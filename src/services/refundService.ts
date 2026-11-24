import logger from '../config/logger';
import { ensurePostgresReady, isPostgresConnected } from '../config/database';
import {
  calculateRefundWithCancellationFee,
  CancellationFeeResult,
} from './feeCalculationService';
import {
  calculateBookNowCancellationFee,
  describeBookNowCancellationPolicy,
} from './bookNowCancellationPolicy';
import { prisma, prismaDev } from '../config/prisma';
import { Prisma } from '@prisma/client';
import mongoose from 'mongoose';
import { createRefundAmountPaise, getPaymentDetails, resolvePaymentEnvironmentForPayment } from './paymentService';
import { sanitizeRazorpayRefundData } from '../utils/paymentSanitizer';
import {
  notifyRefundInitiated,
  notifyRefundStatusUpdated,
} from './paymentNotificationService';
import { getPaymentClient } from '../config/paymentEnvironment';
import { ConflictError } from '../errors/AppError';
import { taskHoldsRecurringVisitEscrows } from './recurringVisitPayoutScope';
import {
  isRecurringVisitEscrow,
  syncRecurringEscrowFromRefundWebhook,
  syncRecurringVisitRefundSafely,
  withRecurringEscrowRefundLock,
} from './recurringVisitRefundSync';
import { getPaymentTimelineEvents } from './paymentTimelineService';

function generateRefundId(): string {
  return `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function getInternalRefundStatus(providerStatus?: string): 'processing' | 'completed' | 'failed' {
  const status = String(providerStatus || '').trim().toLowerCase();
  if (status === 'processed' || status === 'completed' || status === 'success') return 'completed';
  if (status === 'failed') return 'failed';
  return 'processing';
}

async function resolvePaymentIdForRefund(
  orderId?: string | null,
  paymentId?: string | null,
): Promise<string | null> {
  if (paymentId && paymentId.trim()) {
    return paymentId.trim();
  }
  if (!orderId || !orderId.trim()) {
    return null;
  }
  try {
    const cleanOrderId = orderId.trim();
    logger.info('Fetching captured payment for Razorpay order:', { orderId: cleanOrderId });
    const environment = await resolvePaymentEnvironmentForPayment(undefined, cleanOrderId);
    const client = getPaymentClient(environment);
    const payments = await client.orders.fetchPayments(cleanOrderId);
    const items = (payments as { items?: any[] })?.items || [];
    const captured = items.find((p) => p.status === 'captured' && p.id);
    if (captured?.id) {
      return String(captured.id);
    }
    const authorized = items.find((p) => p.status === 'authorized' && p.id);
    if (authorized?.id) {
      return String(authorized.id);
    }
    const anyPayment = items.find((p) => Boolean(p?.id));
    if (anyPayment?.id) {
      return String(anyPayment.id);
    }
  } catch (err: any) {
    logger.warn('Failed to fetch payments for order from Razorpay API:', {
      orderId,
      error: err?.message || String(err),
    });
  }
  return null;
}


/** Precomputed by task-service hourly evaluator — payment must not recalculate fees. */
export type CancellationSettlementPaise = {
  refundAmountPaise: number;
  workerCompensationPaise: number;
  platformRetainedAmountPaise: number;
};

function paiseToRupeeDecimal(paise: number): Prisma.Decimal {
  const safe = Number.isFinite(paise) ? Math.max(0, Math.trunc(paise)) : 0;
  return new Prisma.Decimal((safe / 100).toFixed(2));
}

async function getProfileContact(uid: string): Promise<{ uid?: string; email?: string; name?: string } | null> {
  if (!uid || mongoose.connection.readyState !== 1) return null;

  try {
    const Profile = mongoose.connection.collection('profiles');
    const profile =
      (await Profile.findOne({ uid })) ||
      (mongoose.isValidObjectId(uid) ? await Profile.findOne({ _id: new mongoose.Types.ObjectId(uid) }) : null);

    if (!profile) return null;

    return {
      uid: profile.uid ? String(profile.uid) : undefined,
      email: profile.email,
      name: profile.name || profile.displayName || 'User',
    };
  } catch (error) {
    logger.debug('Failed to load profile contact for refund notification', { error, uid });
    return null;
  }
}

/**
 * Refunds one payment. A recurring visit payment is refunded under its visit lock (so captures
 * and concurrent refunds for the visit are serialized) and its visit is synced to task-service.
 */
export async function processRefund(
  params: Parameters<typeof processRefundUnlocked>[0],
): ReturnType<typeof processRefundUnlocked> {
  const orderId = params.razorpayOrderId ? String(params.razorpayOrderId).trim() : '';
  let lockEscrow: any = null;
  if (orderId && isPostgresConnected()) {
    try {
      lockEscrow = await prisma.escrow.findUnique({ where: { razorpayOrderId: orderId } });
    } catch {
      lockEscrow = null;
    }
  }
  if (!isRecurringVisitEscrow(lockEscrow)) return processRefundUnlocked(params);

  let result: Awaited<ReturnType<typeof processRefundUnlocked>>;
  try {
    result = await withRecurringEscrowRefundLock(lockEscrow, () => processRefundUnlocked(params));
  } catch (error) {
    if (error instanceof ConflictError) return { success: false, error: error.message };
    throw error;
  }
  if (result.success || /already refunded/i.test(String(result.error || ''))) {
    await syncRecurringVisitRefundSafely(lockEscrow.id);
  }
  return result;
}

async function processRefundUnlocked(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  taskId?: string;
  reason?: string;
  cancelledBy: 'poster' | 'performer';
  taskStartDate: Date;
  cancelledAt: Date;
  userId?: string;
  amount?: number;
  assignedAt?: Date;
  feeBaseAmount?: number;
  /** Book Now catalog id (e.g. ac-services) — enables flat cancellation fees */
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  /** false => full refund of capturable amount (no Book Now flat fee). */
  partnerAssigned?: boolean;
  /**
   * Hourly Helper: settlement from task-service evaluator.
   * When set, skips all fee policy calculation.
   */
  precomputedSettlement?: CancellationSettlementPaise;
}): Promise<{
  success: boolean;
  refund?: any;
  error?: string;
}> {
  try {
    const {
      razorpayOrderId: _razorpayOrderId,
      razorpayPaymentId: _razorpayPaymentId,
      taskId,
      reason,
      cancelledBy,
      taskStartDate,
      cancelledAt,
      userId,
      amount,
      assignedAt,
      feeBaseAmount,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    } = params;

    let razorpayOrderId = _razorpayOrderId ? String(_razorpayOrderId).trim() : '';
    let razorpayPaymentId = _razorpayPaymentId ? String(_razorpayPaymentId).trim() : '';
    const cleanTaskId = taskId ? String(taskId).trim() : undefined;

    logger.info('💰 Processing refund', {
      razorpayOrderId,
      razorpayPaymentId,
      taskId: cleanTaskId,
      reason,
      cancelledBy,
    });

    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    let postgresEscrow: any = null;
    let txRecord: any = null;
    let targetDb = prisma;

    // 1. Try finding Escrow by razorpayOrderId
    if (razorpayOrderId) {
      postgresEscrow = await prisma.escrow.findUnique({ where: { razorpayOrderId } });
      if (!postgresEscrow && prismaDev) {
        try {
          postgresEscrow = await prismaDev.escrow.findUnique({ where: { razorpayOrderId } });
          if (postgresEscrow) targetDb = prismaDev;
        } catch (err: any) {
          logger.warn('Failed fallback escrow lookup on prismaDev by order ID:', { message: err?.message });
        }
      }
    }

    // 2. Fallback: lookup Escrow by taskId if razorpayOrderId didn't find it
    if (!postgresEscrow && cleanTaskId) {
      // A recurring plan has one payment per visit; its newest payment may belong to another visit.
      if (await taskHoldsRecurringVisitEscrows(cleanTaskId)) {
        logger.error('Refund by task id refused for a recurring visit plan', {
          taskId: cleanTaskId,
          razorpayOrderId,
        });
        return {
          success: false,
          error: 'Recurring visit refunds must identify the exact visit payment',
        };
      }
      try {
        postgresEscrow = await prisma.escrow.findFirst({ where: { taskId: cleanTaskId }, orderBy: { createdAt: 'desc' } });
      } catch { /* ignore */ }
      if (!postgresEscrow && prismaDev) {
        try {
          postgresEscrow = await prismaDev.escrow.findFirst({ where: { taskId: cleanTaskId }, orderBy: { createdAt: 'desc' } });
          if (postgresEscrow) targetDb = prismaDev;
        } catch { /* ignore */ }
      }
    }

    const recurringVisitEscrow = isRecurringVisitEscrow(postgresEscrow);

    // 3. Lookup Transaction record by taskId or razorpayOrderId
    if (cleanTaskId && !recurringVisitEscrow) {
      try {
        txRecord = await prisma.transaction.findFirst({ where: { taskId: cleanTaskId }, orderBy: { createdAt: 'desc' } });
      } catch { /* ignore */ }
      if (!txRecord && prismaDev) {
        try {
          txRecord = await prismaDev.transaction.findFirst({ where: { taskId: cleanTaskId }, orderBy: { createdAt: 'desc' } });
        } catch { /* ignore */ }
      }
    }
    if (!txRecord && razorpayOrderId) {
      try {
        txRecord = await prisma.transaction.findUnique({ where: { razorpayOrderId } });
      } catch { /* ignore */ }
      if (!txRecord && prismaDev) {
        try {
          txRecord = await prismaDev.transaction.findUnique({ where: { razorpayOrderId } });
        } catch { /* ignore */ }
      }
    }

    // 4. If postgresEscrow wasn't found yet, but txRecord has razorpayOrderId, try finding Escrow with that
    if (!postgresEscrow && txRecord?.razorpayOrderId) {
      try {
        postgresEscrow = await prisma.escrow.findUnique({ where: { razorpayOrderId: txRecord.razorpayOrderId } });
      } catch { /* ignore */ }
      if (!postgresEscrow && prismaDev) {
        try {
          postgresEscrow = await prismaDev.escrow.findUnique({ where: { razorpayOrderId: txRecord.razorpayOrderId } });
          if (postgresEscrow) targetDb = prismaDev;
        } catch { /* ignore */ }
      }
    }

    // 5. Populate razorpayOrderId and razorpayPaymentId from Escrow or Transaction if empty
    if (!razorpayOrderId) {
      razorpayOrderId = postgresEscrow?.razorpayOrderId || txRecord?.razorpayOrderId || '';
    }
    if (!razorpayPaymentId) {
      razorpayPaymentId = postgresEscrow?.razorpayPaymentId || txRecord?.razorpayPaymentId || '';
    }

    if (
      recurringVisitEscrow &&
      postgresEscrow?.razorpayPaymentId &&
      razorpayPaymentId !== String(postgresEscrow.razorpayPaymentId)
    ) {
      logger.error('Refund refused: payment id does not belong to this visit payment', {
        escrowId: postgresEscrow.escrowId,
        razorpayPaymentId,
      });
      return { success: false, error: 'Payment does not belong to this visit payment record' };
    }

    // 6. If razorpayPaymentId is STILL empty, fetch it from Razorpay order payments API!
    if (!razorpayPaymentId && razorpayOrderId) {
      const fetchedPaymentId = await resolvePaymentIdForRefund(razorpayOrderId, null);
      if (fetchedPaymentId) {
        razorpayPaymentId = fetchedPaymentId;
        logger.info('Resolved payment ID from Razorpay order payments:', { razorpayOrderId, razorpayPaymentId });
      }
    }

    const isRealEscrow = Boolean(postgresEscrow);

    // 7. If Escrow row was not found, but we have Transaction record, create a synthetic escrow object
    if (!postgresEscrow) {
      if (txRecord) {
        logger.warn('⚠️ No Escrow found; using Transaction record for refund', { taskId: cleanTaskId, razorpayOrderId, razorpayPaymentId });
        postgresEscrow = {
          id: txRecord.id,
          escrowId: txRecord.id,
          razorpayOrderId: razorpayOrderId || txRecord.razorpayOrderId,
          razorpayPaymentId: razorpayPaymentId || txRecord.razorpayPaymentId,
          taskId: txRecord.taskId || cleanTaskId || '',
          posterUid: txRecord.userId,
          performerUid: null,
          status: 'held',
          paymentStatus: txRecord.status,
          amount: txRecord.amount,
          amountInRupees: txRecord.amount,
          taskAmount: txRecord.amount,
          currency: txRecord.currency || 'INR',
          appliedGstPercent: null,
          appliedPlatformFeePercent: null,
          appliedRazorpayGstPercent: null,
          metadata: txRecord.metadata,
          createdAt: txRecord.createdAt,
          updatedAt: txRecord.updatedAt,
        } as any;
      } else {
        logger.warn('⚠️ Escrow and Transaction not found for order/task:', { razorpayOrderId, taskId: cleanTaskId });
        return { success: false, error: 'Escrow or transaction details not found' };
      }
    }

    if (!razorpayPaymentId) {
      logger.error('❌ Could not resolve payment ID for refund:', { razorpayOrderId, taskId: cleanTaskId });
      return { success: false, error: 'Could not resolve Razorpay Payment ID for this task' };
    }

    // postgresEscrow is guaranteed non-null from this point
    const escrow = postgresEscrow!;

    if (escrow.status === 'refunded') {
      return { success: false, error: 'Escrow already refunded' };
    }

    if (escrow.status === 'released') {
      return {
        success: false,
        error: 'Refund cannot be processed after payout release.',
      };
    }

    // Idempotency check: Check if a refund is already in progress or completed for this payment
    const existingRefund = await targetDb.refund.findFirst({
      where: {
        paymentId: razorpayPaymentId,
        status: { in: ['processing', 'completed'] },
      },
    });


    if (existingRefund) {
      logger.info('ℹ️ Refund already exists (idempotency)', {
        refundId: existingRefund.refundId,
        status: existingRefund.status,
      });
      if (existingRefund.status === 'completed') {
        return {
          success: true,
          refund: {
            refundId: existingRefund.refundId,
            razorpayRefundId: existingRefund.razorpayRefundId,
            amount: existingRefund.refundAmount.toString(),
            cancellationFee: existingRefund.cancellationFee?.toString() || '0.00',
            toOtherParty: existingRefund.toOtherParty?.toString() || '0.00',
            toPlatform: existingRefund.toPlatform?.toString() || '0.00',
            status: 'completed',
          },
        };
      }
      return { success: false, error: 'Refund already in progress' };
    }

    const escrowAmountRupees = escrow.amountInRupees;

    const paymentFetch = await getPaymentDetails(
      razorpayPaymentId,
      await resolvePaymentEnvironmentForPayment(razorpayPaymentId, razorpayOrderId),
    );
    if (!paymentFetch.success || !paymentFetch.payment) {
      return {
        success: false,
        error:
          ('error' in paymentFetch && paymentFetch.error) ||
          'Could not load Razorpay payment to refund',
      };
    }
    const pay = paymentFetch.payment;
    const capturedPaise = Number(pay.amount);
    const alreadyRefunded = Number(pay.amount_refunded ?? 0);
    const maxRefundablePaise = capturedPaise - alreadyRefunded;
    if (!Number.isFinite(maxRefundablePaise) || maxRefundablePaise <= 0) {
      return { success: false, error: 'No capturable balance left to refund on this payment' };
    }
    // A partial amount would mark the visit payment refunded while part of it was kept.
    if (recurringVisitEscrow && amount && !precomputedSettlement) {
      const requestedPaise = Math.round(Number(amount) * 100);
      if (requestedPaise !== maxRefundablePaise) {
        return {
          success: false,
          error:
            requestedPaise > maxRefundablePaise
              ? 'Refund amount exceeds the refundable visit payment'
              : 'Partial refunds of a recurring visit payment are not supported; refund the full visit payment',
        };
      }
    }

    /** Actual INR captured on Razorpay (task + platform fee + GST, etc.) */
    const capturedRupees = new Prisma.Decimal((capturedPaise / 100).toFixed(2));
    const normalizePercent = (value?: Prisma.Decimal | null): Prisma.Decimal | null => {
      if (!value) return null;
      const one = new Prisma.Decimal('1');
      return value.greaterThan(one) ? value.div(new Prisma.Decimal('100')) : value;
    };
    const inferredTaskAmountFromEscrow = (() => {
      const platformPct = normalizePercent(escrow.appliedPlatformFeePercent as Prisma.Decimal | null);
      const gstPct = normalizePercent(escrow.appliedGstPercent as Prisma.Decimal | null) || new Prisma.Decimal('0');
      if (!platformPct) return null;
      const multiplier = new Prisma.Decimal('1').plus(platformPct.mul(new Prisma.Decimal('1').plus(gstPct)));
      if (multiplier.lessThanOrEqualTo(0)) return null;
      return capturedRupees.div(multiplier).toDecimalPlaces(2);
    })();
    const refundTaskBase =
      feeBaseAmount != null
        ? new Prisma.Decimal(feeBaseAmount.toString())
        : escrow.taskAmount
        ? new Prisma.Decimal(escrow.taskAmount.toString())
        : inferredTaskAmountFromEscrow || capturedRupees;

    // Calculate cancellation fee and refund amount (use live capture, not only escrow row)
    let cancellationFeeResult: CancellationFeeResult | null = null;
    let refundAmount: Prisma.Decimal;
    let cancellationFee: Prisma.Decimal;
    let toOtherParty: Prisma.Decimal;
    let toPlatform: Prisma.Decimal;
    let cancellationFeePercentage: number = 0;

    if (precomputedSettlement) {
      refundAmount = paiseToRupeeDecimal(precomputedSettlement.refundAmountPaise);
      toOtherParty = paiseToRupeeDecimal(precomputedSettlement.workerCompensationPaise);
      toPlatform = paiseToRupeeDecimal(precomputedSettlement.platformRetainedAmountPaise);
      cancellationFee = toOtherParty.add(toPlatform).toDecimalPlaces(2);
      const paidPaise =
        precomputedSettlement.refundAmountPaise +
        precomputedSettlement.workerCompensationPaise +
        precomputedSettlement.platformRetainedAmountPaise;
      cancellationFeePercentage =
        paidPaise > 0 ? cancellationFee.toNumber() / (paidPaise / 100) : 0;
      logger.info('Hourly precomputed settlement applied (no fee recalculation)', {
        razorpayPaymentId,
        refundAmountPaise: precomputedSettlement.refundAmountPaise,
        workerCompensationPaise: precomputedSettlement.workerCompensationPaise,
        platformRetainedAmountPaise: precomputedSettlement.platformRetainedAmountPaise,
      });
    } else if (amount) {
      // Partial refund - no cancellation fee
      refundAmount = new Prisma.Decimal(amount.toString());
      cancellationFee = new Prisma.Decimal('0.00');
      toOtherParty = new Prisma.Decimal('0.00');
      toPlatform = new Prisma.Decimal('0.00');
    } else if (cancelledBy === 'performer') {
      // Tasker cancel: full captured refund to poster; policy penalty from performer payouts.
      const performerRefundAmount = new Prisma.Decimal((maxRefundablePaise / 100).toFixed(2));
      
      refundAmount = performerRefundAmount;
      cancellationFee = new Prisma.Decimal('0.00');
      toOtherParty = new Prisma.Decimal('0.00');
      toPlatform = new Prisma.Decimal('0.00');
      cancellationFeePercentage = 0;
      logger.info('Performer cancel: full captured refund to poster', {
        razorpayPaymentId,
        refundAmount: performerRefundAmount.toString(),
        includesPlatformFeeAndGst: true,
      });
    } else {
      const { isBookNowEscrowRecord } = await import('./escrowService');
      const escrowMeta = (escrow.metadata as Record<string, unknown> | null) || {};
      const isBookNow = isBookNowEscrowRecord(escrow);
      const refundableCapturedRupees = new Prisma.Decimal(
        (maxRefundablePaise / 100).toFixed(2),
      );

      if (isBookNow) {
        const resolvedCatalogId = resolveBookNowCatalogId(
          escrowMeta,
          escrow.taskId,
          catalogId,
        );

        // Explicit flag from task-service wins; else escrow performerUid is source of truth.
        const escrowPerformer = String(postgresEscrow.performerUid || '').trim();
        const inferredAssigned =
          escrowPerformer.length > 0 && escrowPerformer !== 'pending_assignment';
        const effectivePartnerAssigned =
          partnerAssigned !== undefined ? partnerAssigned : inferredAssigned;
        logger.info('Book Now cancellation assignment gate', {
          razorpayOrderId,
          partnerAssigned: effectivePartnerAssigned,
          source:
            partnerAssigned !== undefined ? 'request' : 'escrow_performerUid',
        });
        const bookNowFee = await calculateBookNowCancellationFee({
          catalogId: resolvedCatalogId,
          amount: refundableCapturedRupees,
          taskStartDate,
          cancelledAt,
          partnerReachedLocation,
          partnerAssigned: effectivePartnerAssigned,
        });
        cancellationFeeResult = bookNowFee;
      } else {
        const refundFeeBase = refundTaskBase;
        cancellationFeeResult = await calculateRefundWithCancellationFee({
          amount: refundFeeBase,
          taskStartDate,
          cancelledAt,
          cancelledBy,
          assignedAt,
          feeBaseAmount: refundFeeBase,
        });
      }

      refundAmount = cancellationFeeResult.refundAmount;
      cancellationFee = cancellationFeeResult.cancellationFee;
      toOtherParty = cancellationFeeResult.toOtherParty;
      toPlatform = cancellationFeeResult.toPlatform;
      cancellationFeePercentage = cancellationFeeResult.cancellationFeePercentage;
    }

    let refundAmountInPaise = Math.round(parseFloat(refundAmount.toString()) * 100);
    // Hourly: full fee retained (e.g. 1h no-show) — no Razorpay refund, still settle ledger.
    const feeOnlySettlement =
      Boolean(precomputedSettlement) &&
      refundAmountInPaise <= 0 &&
      cancellationFee.greaterThan(0);

    if (refundAmountInPaise <= 0 && !feeOnlySettlement) {
      return {
        success: false,
        error: 'Calculated refund after cancellation fees is zero; nothing to return via Razorpay',
      };
    }
    if (refundAmountInPaise > maxRefundablePaise) {
      if (refundAmountInPaise - maxRefundablePaise > 1) {
        logger.error('Refund amount exceeds Razorpay capturable amount', {
          refundAmountInPaise,
          maxRefundablePaise,
          razorpayPaymentId,
        });
        return {
          success: false,
          error: 'Refund amount exceeds capturable payment amount; check fee policy vs payment total',
        };
      }
      refundAmountInPaise = maxRefundablePaise;
    }

    let razorpayRefund: any = null;
    if (!feeOnlySettlement) {
      logger.info('[RefundService.processRefund] Calling Razorpay refund API', {
        razorpayOrderId,
        razorpayPaymentId,
        refundAmountInPaise,
        refundAmountRupees: (refundAmountInPaise / 100).toFixed(2),
        maxRefundablePaise,
        cancelledBy,
      });

      const paymentEnv = await resolvePaymentEnvironmentForPayment(razorpayPaymentId, razorpayOrderId);
      const razorpayRefundResult = await createRefundAmountPaise(
        razorpayPaymentId,
        refundAmountInPaise,
        paymentEnv,
      );

      if (!razorpayRefundResult.success || !razorpayRefundResult.refund) {
        logger.warn('Failed to create Razorpay refund, checking if already refunded in Razorpay:', {
          razorpayOrderId,
          razorpayPaymentId,
          refundAmountInPaise,
          error: razorpayRefundResult.error,
        });

        // Check if the payment was already refunded in Razorpay directly
        try {
          const client = getPaymentClient(paymentEnv);
          const payment = await client.payments.fetch(razorpayPaymentId);
          if (payment && (Number(payment.amount_refunded) > 0 || payment.status === 'refunded')) {
            const refundsResponse: any = await (client.payments as any).fetchRefunds(razorpayPaymentId);
            const rzpRefunds = refundsResponse?.items || [];
            if (rzpRefunds.length > 0) {
              razorpayRefund = rzpRefunds[0];
              logger.info('✅ Payment was already refunded in Razorpay, syncing existing refund:', {
                razorpayOrderId,
                razorpayPaymentId,
                razorpayRefundId: razorpayRefund.id,
                amount: razorpayRefund.amount,
                status: razorpayRefund.status,
              });
            }
          }
        } catch (fetchErr: any) {
          logger.warn('Failed to inspect existing Razorpay refunds on error:', fetchErr?.message);
        }

        if (!razorpayRefund) {
          logger.error('❌ Failed to create Razorpay refund:', {
            razorpayOrderId,
            razorpayPaymentId,
            refundAmountInPaise,
            error: razorpayRefundResult.error,
          });
          return {
            success: false,
            error: razorpayRefundResult.error || 'Failed to create Razorpay refund',
          };
        }
      } else {
        razorpayRefund = razorpayRefundResult.refund;
      }
      logger.info('[RefundService.processRefund] Razorpay refund API success', {
        razorpayOrderId,
        razorpayPaymentId,
        razorpayRefundId: razorpayRefund.id,
        razorpayRefundStatus: razorpayRefund.status,
        razorpayRefundAmountPaise: razorpayRefund.amount,
        razorpayRefundSpeed: razorpayRefund.speed_processed || razorpayRefund.speed_requested,
      });
    } else {
      logger.info('[RefundService.processRefund] Fee-only settlement (no Razorpay refund)', {
        razorpayOrderId,
        razorpayPaymentId,
        cancellationFee: cancellationFee.toString(),
      });
      razorpayRefund = {
        id: `fee_only_${generateRefundId()}`,
        status: 'processed',
        amount: 0,
      };
    }

    // Sanitize Razorpay refund data
    const sanitizedRefundData = feeOnlySettlement
      ? { feeOnly: true, amount: 0 }
      : sanitizeRazorpayRefundData(razorpayRefund);

    // Generate refund ID
    const refundId = generateRefundId();

    // Use transaction to ensure data consistency - ALL operations atomic
    let postgresRefund: any = null;
    let providerProcessedAt: Date | undefined;

    try {
      if (isPostgresConnected()) {
        // Wrap all database operations in a transaction for atomicity
        await targetDb.$transaction(async (tx) => {
          let currentBalance = new Prisma.Decimal('0.00');

          if (isRealEscrow) {
            // Get current escrow balance with row-level locking to prevent race conditions
            const latestEntry = await tx.ledger.findFirst({
              where: { escrowId: escrow.id },
              orderBy: { createdAt: 'desc' },
            });
            currentBalance = latestEntry?.balanceAfter || new Prisma.Decimal('0.00');
          }

          // Create refund record in Postgres
          postgresRefund = await tx.refund.create({
            data: {
              refundId,
              escrowId: isRealEscrow ? escrow.id : null,
              transactionId: txRecord?.id || null,
              taskId: escrow.taskId,
              paymentId: razorpayPaymentId,
              razorpayRefundId: razorpayRefund.id,
              cancellationFee: cancellationFee.greaterThan(0) ? cancellationFee : null,
              refundAmount,
              toOtherParty: toOtherParty.greaterThan(0) ? toOtherParty : null,
              toPlatform: toPlatform.greaterThan(0) ? toPlatform : null,
              reason,
              cancelledBy,
              status: 'processing',
              providerStatus: razorpayRefund.status || null,
            },
          });

          const ledgerRefundId = postgresRefund.id;

          if (isRealEscrow) {
            // Update escrow status to 'refunded'
            await tx.escrow.update({
              where: { id: escrow.id },
              data: {
                status: 'refunded',
                refundedAt: new Date(),
                razorpayPaymentId: razorpayPaymentId,
              },
            });
          }

          if (txRecord?.id) {
            try {
              await tx.transaction.update({
                where: { id: txRecord.id },
                data: {
                  status: 'refunded',
                  razorpayPaymentId: razorpayPaymentId,
                },
              });
            } catch { /* ignore */ }
          }

          // Prepare all ledger entries for batch creation if real escrow
          if (isRealEscrow) {
            const ledgerEntries: Array<{
              transactionId: string;
              escrowId: string;
              refundId: string;
              type: string;
              amount: Prisma.Decimal;
              balanceBefore: Prisma.Decimal;
              balanceAfter: Prisma.Decimal;
              description: string;
              metadata: any;
            }> = [];

            // Helper to generate transaction ID
            const generateTxId = () => `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

            // 1. Refund entry
            let runningBalance = currentBalance;
            runningBalance = runningBalance.sub(refundAmount);
            ledgerEntries.push({
              transactionId: generateTxId(),
              escrowId: escrow.id,
              refundId: ledgerRefundId,
              type: 'refund',
              amount: refundAmount.neg(),
              balanceBefore: currentBalance,
              balanceAfter: runningBalance,
              description: `Refund processed: ${reason || 'No reason provided'}`,
              metadata: {
                refundId,
                razorpayRefundId: razorpayRefund.id,
                originalAmount: capturedRupees.toString(),
                escrowAmountInRupees: escrowAmountRupees.toString(),
                refundAmount: refundAmount.toString(),
                cancellationFee: cancellationFee.toString(),
                toOtherParty: toOtherParty.toString(),
                toPlatform: toPlatform.toString(),
                cancelledBy,
                reason,
              },
            });

            // 2-4. Cancellation fee entries (if applicable)
            if (cancellationFee.greaterThan(0)) {
              // Cancellation fee
              const balanceBeforeFee = runningBalance;
              runningBalance = runningBalance.sub(cancellationFee);
              ledgerEntries.push({
                transactionId: generateTxId(),
                escrowId: escrow.id,
                refundId: ledgerRefundId,
                type: 'cancellation_fee',
                amount: cancellationFee.neg(),
                balanceBefore: balanceBeforeFee,
                balanceAfter: runningBalance,
                description: `Cancellation fee: ${cancellationFeePercentage * 100}%`,
                metadata: {
                  refundId,
                  cancellationFee: cancellationFee.toString(),
                  cancellationFeePercentage: cancellationFeePercentage,
                  cancelledBy,
                },
              });

              // Compensation to other party
              if (toOtherParty.greaterThan(0)) {
                const balanceBeforeComp = runningBalance;
                runningBalance = runningBalance.sub(toOtherParty);
                ledgerEntries.push({
                  transactionId: generateTxId(),
                  escrowId: escrow.id,
                  refundId: ledgerRefundId,
                  type: 'compensation',
                  amount: toOtherParty.neg(),
                  balanceBefore: balanceBeforeComp,
                  balanceAfter: runningBalance,
                  description: `Compensation to ${cancelledBy === 'poster' ? 'performer' : 'poster'}`,
                  metadata: {
                    refundId,
                    toOtherParty: toOtherParty.toString(),
                    cancelledBy,
                  },
                });
              }

              // Platform fee
              if (toPlatform.greaterThan(0)) {
                const balanceBeforePlatform = runningBalance;
                runningBalance = runningBalance.sub(toPlatform);
                ledgerEntries.push({
                  transactionId: generateTxId(),
                  escrowId: escrow.id,
                  refundId: ledgerRefundId,
                  type: 'platform_fee',
                  amount: toPlatform.neg(),
                  balanceBefore: balanceBeforePlatform,
                  balanceAfter: runningBalance,
                  description: 'Platform cancellation fee',
                  metadata: {
                    refundId,
                    toPlatform: toPlatform.toString(),
                    cancelledBy,
                  },
                });
              }
            }

            // Create all ledger entries in a single batch operation
            if (ledgerEntries.length > 0) {
              await tx.ledger.createMany({
                data: ledgerEntries,
              });
            }
          }

          const internalRefundStatus = getInternalRefundStatus(razorpayRefund.status);
          providerProcessedAt =
            internalRefundStatus === 'completed' ? new Date() : undefined;
          await tx.refund.update({
            where: { id: postgresRefund.id },
            data: {
              status: internalRefundStatus,
              providerStatus: razorpayRefund.status || null,
              ...(providerProcessedAt
                ? { completedAt: providerProcessedAt, providerProcessedAt }
                : {}),
            },
          });
        }, {
          timeout: 30000, // 30 second timeout for transaction
        });

        // Update UserPaymentProfile cache
        // For poster: refund (money returned)
        // For performer: compensation (if toOtherParty exists)
        const { updateUserPaymentProfile } = await import('./userPaymentProfileService');

        // Poster gets refund (skip zero / fee-only settlements)
        if (postgresEscrow?.posterUid && refundAmount.greaterThan(0)) {
          updateUserPaymentProfile(postgresEscrow.posterUid, {
            type: 'refund',
            amount: refundAmount,
            refundId,
            escrowId: postgresEscrow.id,
          }).catch((error) => {
            logger.warn('Failed to update UserPaymentProfile for refund (non-critical):', error);
          });
        }

        // Performer gets compensation (if applicable)
        if (toOtherParty.greaterThan(0) && escrow.performerUid) {
          updateUserPaymentProfile(escrow.performerUid, {
            type: 'compensation',
            amount: toOtherParty,
            refundId,
            escrowId: isRealEscrow ? escrow.id : undefined,
          }).catch((error) => {
            logger.warn('Failed to update UserPaymentProfile for compensation (non-critical):', error);
          });
        }
      }

      await syncMongoTaskRefundStatus(escrow.taskId, razorpayPaymentId, razorpayOrderId, providerProcessedAt);

      // Escrow already updated in Postgres above (line ~180)

      logger.info('✅ Refund processed successfully', {
        refundId,
        razorpayRefundId: razorpayRefund.id,
        refundAmount: refundAmount.toString(),
        cancellationFee: cancellationFee.toString(),
      });

      // Send refund initiated emails and notifications
      logger.info('Email trigger: refund_initiated', {
        posterUid: escrow.posterUid,
        refundAmount: refundAmount.toString(),
        cancellationFee: cancellationFee.toString(),
        taskId: escrow.taskId,
        reason,
      });

      const taskTitle = (escrow.metadata as any)?.taskTitle || null;
      const posterContact = await getProfileContact(escrow.posterUid);
      logger.info('[RefundService.processRefund] Dispatching poster refund notification', {
        posterUid: escrow.posterUid,
        taskId: escrow.taskId,
        taskTitle,
        refundAmount: refundAmount.toString(),
        hasPosterEmail: Boolean(posterContact?.email),
        hasPosterName: Boolean(posterContact?.name),
        category: 'payments',
      });

      notifyRefundInitiated({
        posterUid: posterContact?.uid || escrow.posterUid,
        amount: refundAmount.toString(),
        taskId: escrow.taskId,
        taskTitle,
        reason,
        email: posterContact?.email || null,
        emailUid: posterContact?.uid || null,
        userName: posterContact?.name || null,
      }).catch((error) => {
        logger.warn('[RefundService.processRefund] Failed to send refund initiated notification', {
          posterUid: escrow.posterUid,
          taskId: escrow.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return {
        success: true,
        refund: {
          refundId,
          razorpayRefundId: razorpayRefund.id,
          amount: refundAmount.toString(),
          cancellationFee: cancellationFee.toString(),
          toOtherParty: toOtherParty.toString(),
          toPlatform: toPlatform.toString(),
          status: razorpayRefund.status || 'processing',
          razorpayData: sanitizedRefundData,
        },
      };
    } catch (error: any) {
      logger.error('❌ Error processing refund:', error);

      // Update refund status to 'failed' if it was created
      if (postgresRefund) {
        try {
          await prisma.refund.update({
            where: { id: postgresRefund.id },
            data: {
              status: getInternalRefundStatus(razorpayRefund?.status),
              providerStatus: razorpayRefund?.status || null,
              errorMessage: error.message,
            },
          });
        } catch (updateError) {
          logger.error('❌ Failed to update refund status:', updateError);
        }
      }

      return { success: false, error: error.message || 'Failed to process refund' };
    }
  } catch (error: any) {
    logger.error('❌ Error in refund service:', error);
    return { success: false, error: error.message || 'Failed to process refund' };
  }
}

/**
 * Get refund status
 * 
 * @param refundId - Refund ID
 * @returns Refund status
 */
export async function getRefundStatus(
  refundId: string,
  options?: { syncRazorpay?: boolean; userIds?: string[] },
): Promise<{
  success: boolean;
  refund?: any;
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const refund = await prisma.refund.findUnique({
      where: { refundId },
      include: {
        escrow: true,
      },
    });

    if (!refund) {
      return { success: false, error: 'Refund not found' };
    }

    if (options?.userIds) {
      const userIds = options.userIds;
      const isEscrowParticipant =
        Boolean(refund.escrow) &&
        [refund.escrow?.posterUid, refund.escrow?.performerUid].some(
          (userId) => userId && userIds.includes(userId),
        );
      const transaction = isEscrowParticipant
        ? null
        : await prisma.transaction.findFirst({
            where: {
              razorpayPaymentId: refund.paymentId,
              userId: { in: userIds },
            },
            select: { id: true },
          });
      if (!isEscrowParticipant && !transaction) {
        return { success: false, error: 'Refund not found' };
      }
    }

    // Get original amount from escrow (not stored in refund table)
    const originalAmount = refund.escrow?.amountInRupees || new Prisma.Decimal('0.00');

    let providerRefund: any = null;
    let providerPayment: any = null;
    let providerRefunds: any[] = [];
    let providerSyncWarning: string | null = null;
    let settlement = {
      status: refund.settlementStatus,
      settlementId: refund.settlementId,
      expectedSettlementAt: null,
      settledAt: refund.settledAt,
    };
    if (options?.syncRazorpay) {
      try {
        const environment = await resolvePaymentEnvironmentForPayment(
          refund.paymentId,
          refund.escrow?.razorpayOrderId,
        );
        const client = getPaymentClient(environment);
        const [paymentResult, refundsResult, refundResult] = await Promise.allSettled([
          client.payments.fetch(refund.paymentId),
          fetchRazorpayRefundsForPayment(client, refund.paymentId),
          refund.razorpayRefundId
            ? client.refunds.fetch(refund.razorpayRefundId, { payment_id: refund.paymentId })
            : Promise.resolve(null),
        ]);
        if (paymentResult.status === 'fulfilled') {
          providerPayment = paymentResult.value;
        } else {
          providerSyncWarning = 'Could not refresh payment details from Razorpay.';
          logger.warn('Failed to fetch payment details from Razorpay', {
            paymentId: refund.paymentId,
            error: paymentResult.reason?.message || String(paymentResult.reason),
          });
        }
        if (refundsResult.status === 'fulfilled') {
          providerRefunds = refundsResult.value;
        } else {
          providerSyncWarning = 'Could not refresh all refunds from Razorpay.';
          logger.warn('Failed to fetch payment refunds from Razorpay', {
            paymentId: refund.paymentId,
            error: refundsResult.reason?.message || String(refundsResult.reason),
          });
        }
        if (refundResult.status === 'fulfilled') {
          providerRefund = refundResult.value;
        } else {
          providerSyncWarning = 'Could not refresh refund details from Razorpay.';
          logger.warn('Failed to fetch specific refund from Razorpay', {
            refundId,
            razorpayRefundId: refund.razorpayRefundId,
            error: refundResult.reason?.message || String(refundResult.reason),
          });
        }
      } catch (error: any) {
        providerSyncWarning = 'Could not refresh payment and refund details from Razorpay.';
        logger.warn('Failed to sync payment and refund details from Razorpay', {
          refundId,
          error: error?.message || String(error),
        });
      }
    }

    const listedRefundById = refund.razorpayRefundId
      ? providerRefunds.find((item) => item.id === refund.razorpayRefundId)
      : undefined;
    let listedRefund = listedRefundById;
    if (!listedRefund && !refund.razorpayRefundId) {
      const alreadyLinkedRefunds = await prisma.refund.findMany({
        where: {
          paymentId: refund.paymentId,
          razorpayRefundId: { not: null },
          refundId: { not: refund.refundId },
        },
        select: { razorpayRefundId: true },
      });
      const linkedRefundIds = new Set(
        alreadyLinkedRefunds.map((item) => item.razorpayRefundId),
      );
      const expectedAmountPaise = Math.round(Number(refund.refundAmount) * 100);
      const matchingRefunds = providerRefunds.filter(
        (item) =>
          item.id &&
          !linkedRefundIds.has(item.id) &&
          Number(item.amount) === expectedAmountPaise,
      );
      if (matchingRefunds.length === 1) {
        [listedRefund] = matchingRefunds;
      }
    }
    providerRefund = providerRefund ?? listedRefund ?? null;
    const providerAmountRupees = Number(providerRefund?.amount) / 100;
    const hasProviderAmount = Number.isFinite(providerAmountRupees) && providerAmountRupees >= 0;
    const providerStatus = providerRefund?.status || refund.providerStatus || null;
    if (options?.syncRazorpay && providerRefund?.id && providerRefund?.status) {
      const normalizedStatus = String(providerRefund.status).trim().toLowerCase();
      const internalStatus = getInternalRefundStatus(normalizedStatus);
      await prisma.refund.updateMany({
        where: { refundId: refund.refundId },
        data: {
          ...(refund.razorpayRefundId ? {} : { razorpayRefundId: providerRefund.id }),
          providerStatus: normalizedStatus,
          status: internalStatus,
          ...(internalStatus === 'failed'
            ? { errorMessage: 'Razorpay reported refund failure' }
            : {}),
        },
      });
    }
    const statusUpdatedAt =
      refund.providerStatus && (!providerRefund || providerRefund.status === refund.providerStatus)
        ? refund.updatedAt
        : null;
    const transaction = await prisma.transaction.findUnique({
      where: { razorpayPaymentId: refund.paymentId },
      select: { createdAt: true },
    });
    const timeline: Array<{ eventType: string; occurredAt: Date | null }> =
      await getPaymentTimelineEvents(
      refund.paymentId,
      refund.razorpayRefundId,
    );
    const paymentCreatedTimestamp = Number(providerPayment?.created_at);
    const paymentCreatedAt =
      Number.isFinite(paymentCreatedTimestamp) && paymentCreatedTimestamp > 0
        ? new Date(paymentCreatedTimestamp * 1000)
        : transaction?.createdAt ?? refund.escrow?.createdAt;
    if (paymentCreatedAt) {
      timeline.unshift({
        eventType: 'payment.created',
        occurredAt: paymentCreatedAt,
      });
    }
    const providerRefundCreatedTimestamp = Number(providerRefund?.created_at);
    const refundCreatedAt =
      Number.isFinite(providerRefundCreatedTimestamp) && providerRefundCreatedTimestamp > 0
        ? new Date(providerRefundCreatedTimestamp * 1000)
        : refund.createdAt;
    if (!timeline.some((event) => event.eventType === 'refund.created')) {
      timeline.push({ eventType: 'refund.created', occurredAt: refundCreatedAt });
    }
    const normalizedProviderStatus = String(providerStatus || '').toLowerCase();
    const hasTerminalRefundEvent = timeline.some((event) =>
      ['refund.processed', 'refund.failed'].includes(event.eventType),
    );
    if (!hasTerminalRefundEvent && normalizedProviderStatus === 'failed') {
      timeline.push({
        eventType: 'refund.failed',
        occurredAt:
          refund.providerProcessedAt ??
          refund.completedAt ??
          (providerRefund?.status ? null : refund.updatedAt),
      });
    }
    const paymentStatus = String(providerPayment?.status || '').toLowerCase();
    const currentPaymentEventType =
      paymentStatus === 'authorized'
        ? 'payment.authorized'
        : paymentStatus === 'captured'
          ? 'payment.captured'
          : paymentStatus === 'refunded'
            ? 'payment.refunded'
            : null;
    if (
      currentPaymentEventType &&
      !timeline.some((event) => event.eventType === currentPaymentEventType)
    ) {
      timeline.push({ eventType: currentPaymentEventType, occurredAt: null });
    }
    if (
      String(settlement.status || '').toLowerCase() === 'settled' &&
      !timeline.some((event) => event.eventType === 'settlement.processed')
    ) {
      timeline.push({
        eventType: 'settlement.processed',
        occurredAt: settlement.settledAt,
      });
    }
    timeline.sort(
      (left, right) =>
        (left.occurredAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.occurredAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
    );

    return {
      success: true,
      refund: {
        refundId: refund.refundId,
        razorpayRefundId: refund.razorpayRefundId,
        amount: originalAmount.toString(),
        cancellationFee: refund.cancellationFee?.toString(),
        refundAmount: hasProviderAmount
          ? providerAmountRupees.toFixed(2)
          : refund.refundAmount.toString(),
        toOtherParty: refund.toOtherParty?.toString(),
        toPlatform: refund.toPlatform?.toString(),
        reason: refund.reason,
        cancelledBy: refund.cancelledBy,
        status: providerStatus || refund.status,
        razorpayRefundStatus: providerStatus,
        razorpaySpeedProcessed:
          providerRefund?.speed_processed || providerRefund?.speed_requested || null,
        refundBankReference:
          providerRefund?.acquirer_data?.rrn ??
          providerRefund?.acquirer_data?.arn ??
          providerRefund?.acquirer_data?.utr ??
          null,
        refundBankReferenceType: providerRefund?.acquirer_data?.rrn
          ? 'RRN'
          : providerRefund?.acquirer_data?.arn
            ? 'ARN'
            : providerRefund?.acquirer_data?.utr
              ? 'UTR'
              : null,
        createdAt: refund.createdAt,
        processedAt: refund.providerProcessedAt,
        statusUpdatedAt,
        paymentMethod:
          providerPayment?.method ??
          (refund.escrow?.razorpayPaymentData
            ? (refund.escrow.razorpayPaymentData as Record<string, unknown>).method
            : null),
        paymentStatus: providerPayment?.status ?? null,
        paymentCreatedAt,
        providerSyncWarning,
        timeline: timeline.map((event) => ({
          ...event,
          source:
            event.eventType === 'settlement.processed'
              ? 'razorpay_settlement_report'
              : event.occurredAt
                ? 'webhook_or_razorpay'
                : 'razorpay_current',
        })),
        expectedCreditAt: refund.expectedDepositAt,
        settlement: {
          ...settlement,
          status: settlement.status?.toUpperCase() ?? null,
        },
      },
    };
  } catch (error: any) {
    logger.error('❌ Error getting refund status:', error);
    return { success: false, error: error.message || 'Failed to get refund status' };
  }
}

async function fetchRazorpayRefundsForPayment(
  client: ReturnType<typeof getPaymentClient>,
  paymentId: string,
): Promise<any[]> {
  const pageSize = 100;
  const refunds: any[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await client.payments.fetchMultipleRefund(paymentId, {
      count: pageSize,
      skip,
    });
    refunds.push(...page.items);
    if (page.items.length < pageSize) return refunds;
  }
}

/**
 * Get refunds belonging to customer identities supplied by the authenticated API gateway.
 */
export async function getCustomerRefunds(userIds: string[]): Promise<{
  success: boolean;
  refunds?: any[];
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }
    if (userIds.length === 0) {
      return { success: true, refunds: [] };
    }

    const identityIds = new Set(userIds);
    if (mongoose.connection.readyState === 1) {
      try {
        const profileObjectIds = userIds
          .filter((uid) => mongoose.isValidObjectId(uid))
          .map((uid) => new mongoose.Types.ObjectId(uid));
        const profiles = await mongoose.connection.collection('profiles')
          .find({
            $or: [
              { uid: { $in: userIds } },
              ...(profileObjectIds.length > 0
                ? [{ _id: { $in: profileObjectIds } }]
                : []),
            ],
          })
          .project({ _id: 1, uid: 1 })
          .toArray();
        profiles.forEach((profile) => {
          if (profile.uid) identityIds.add(String(profile.uid));
          if (profile._id) identityIds.add(String(profile._id));
        });
      } catch (error: any) {
        logger.warn('Could not expand customer refund identities from profiles', {
          error: error?.message || String(error),
        });
      }
    }

    const expandedUserIds = Array.from(identityIds);
    const databases = [prisma, ...(prismaDev ? [prismaDev] : [])];
    const refundsById = new Map<string, { refund: any; transactionAmount?: string }>();
    for (const database of databases) {
      try {
        const [escrows, transactions] = await Promise.all([
          database.escrow.findMany({
            where: {
              OR: [
                { posterUid: { in: expandedUserIds } },
                { performerUid: { in: expandedUserIds } },
              ],
            },
            select: { id: true },
          }),
          database.transaction.findMany({
            where: {
              userId: { in: expandedUserIds },
            },
            select: { id: true, razorpayPaymentId: true, amount: true },
          }),
        ]);
        const escrowIds = escrows.map((escrow) => escrow.id);
        const transactionIds = transactions.map((transaction) => transaction.id);
        const paymentIds = transactions
          .map((transaction) => transaction.razorpayPaymentId)
          .filter((paymentId): paymentId is string => Boolean(paymentId));
        const clauses = [
          ...(escrowIds.length > 0 ? [{ escrowId: { in: escrowIds } }] : []),
          ...(transactionIds.length > 0 ? [{ transactionId: { in: transactionIds } }] : []),
          ...(paymentIds.length > 0 ? [{ paymentId: { in: paymentIds } }] : []),
        ];
        if (clauses.length === 0) continue;

        const databaseRefunds = await database.refund.findMany({
          where: { OR: clauses },
          include: { escrow: true },
          orderBy: { createdAt: 'desc' },
        });
        const transactionAmountByPaymentId = new Map(
          transactions
            .filter((transaction) => transaction.razorpayPaymentId)
            .map((transaction) => [
              transaction.razorpayPaymentId as string,
              transaction.amount.toString(),
            ]),
        );
        databaseRefunds.forEach((refund) => {
          if (!refundsById.has(refund.refundId)) {
            refundsById.set(refund.refundId, {
              refund,
              transactionAmount: transactionAmountByPaymentId.get(refund.paymentId),
            });
          }
        });
      } catch (error: any) {
        if (database === prisma) throw error;
        logger.warn('Could not load customer refunds from secondary payment database', {
          error: error?.message || String(error),
        });
      }
    }

    return {
      success: true,
      refunds: Array.from(refundsById.values())
        .sort(
          (left, right) =>
            right.refund.createdAt.getTime() - left.refund.createdAt.getTime(),
        )
        .map(({ refund, transactionAmount }) => ({
          refundId: refund.refundId,
          razorpayRefundId: refund.razorpayRefundId,
          amount:
            refund.escrow?.amountInRupees?.toString() ??
            transactionAmount ??
            '0.00',
          refundAmount: refund.refundAmount.toString(),
          cancellationFee: refund.cancellationFee?.toString(),
          reason: refund.reason,
          taskId: refund.taskId,
          status: refund.status,
          razorpayRefundStatus: refund.providerStatus,
          createdAt: refund.createdAt,
          processedAt: refund.providerProcessedAt,
          expectedCreditAt: refund.expectedDepositAt,
        })),
    };
  } catch (error: any) {
    logger.error('Failed to get customer refunds:', error);
    return { success: false, error: error.message || 'Failed to get customer refunds' };
  }
}

/**
 * Get refunds by escrow ID
 * 
 * @param escrowId - Escrow ID
 * @returns List of refunds
 */
export async function getRefundsByEscrowId(escrowId: string): Promise<{
  success: boolean;
  refunds?: any[];
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    // First get Postgres escrow to find its ID
    const postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    const refunds = await prisma.refund.findMany({
      where: { escrowId: postgresEscrow.id },
      orderBy: { createdAt: 'desc' },
    });

    // Get original amount from escrow (same for all refunds of this escrow)
    const originalAmount = postgresEscrow.amountInRupees;

    return {
      success: true,
      refunds: refunds.map(refund => ({
        refundId: refund.refundId,
        razorpayRefundId: refund.razorpayRefundId,
        amount: originalAmount.toString(),
        cancellationFee: refund.cancellationFee?.toString(),
        refundAmount: refund.refundAmount.toString(),
        toOtherParty: refund.toOtherParty?.toString(),
        toPlatform: refund.toPlatform?.toString(),
        reason: refund.reason,
        cancelledBy: refund.cancelledBy,
        status: refund.status,
        razorpayRefundStatus: refund.providerStatus,
        createdAt: refund.createdAt,
        processedAt: refund.providerProcessedAt,
        statusUpdatedAt: refund.providerStatus ? refund.updatedAt : null,
        expectedDepositAt: refund.expectedDepositAt,
        expectedCreditAt: refund.expectedDepositAt,
        settlement: {
          status: refund.settlementStatus?.toUpperCase() ?? null,
          settlementId: refund.settlementId,
          expectedSettlementAt: null,
          settledAt: refund.settledAt,
        },
      })),
    };
  } catch (error: any) {
    logger.error('❌ Error getting refunds by escrow ID:', error);
    return { success: false, error: error.message || 'Failed to get refunds' };
  }
}

/**
 * Map a line's catalog price to the INR actually charged on Razorpay for that line.
 * Needed when checkout used Extra Coins, prior partial refunds, or line totals != capture.
 */
function resolveBookNowCatalogId(
  meta: Record<string, unknown>,
  taskId?: string | null,
  catalogId?: string | null,
): string | undefined {
  const explicit = String(catalogId || meta.bookNowCatalogId || '').trim();
  if (explicit) return explicit;

  const lineItems = Array.isArray(meta.bookNowLineItems)
    ? (meta.bookNowLineItems as Array<{
        taskId?: string;
        catalogId?: string;
        categorySlug?: string;
      }>)
    : [];

  if (taskId) {
    const row = lineItems.find((item) => item.taskId === taskId);
    const fromRow = String(row?.catalogId || row?.categorySlug || '').trim();
    if (fromRow) return fromRow;
  }

  if (lineItems.length === 1) {
    const only = lineItems[0];
    const fromOnly = String(only.catalogId || only.categorySlug || '').trim();
    if (fromOnly) return fromOnly;
  }

  return undefined;
}

function resolveBookNowLineFeeBase(params: {
  lineAmountRupees: number;
  capturedPaise: number;
  maxRefundablePaise: number;
  taskId: string;
  isLastActiveItem: boolean;
  meta: Record<string, unknown>;
  escrowTaskAmountRupees?: Prisma.Decimal | null;
}): number {
  const {
    lineAmountRupees,
    capturedPaise,
    maxRefundablePaise,
    taskId,
    isLastActiveItem,
    meta,
    escrowTaskAmountRupees,
  } = params;

  const capturedRupees = capturedPaise / 100;
  const maxRefundableRupees = maxRefundablePaise / 100;

  const lineItems = Array.isArray(meta.bookNowLineItems)
    ? (meta.bookNowLineItems as Array<{ taskId?: string; lineAmountRupees?: number }>)
    : [];

  const totalCatalogLineRupees =
    lineItems.length > 0
      ? lineItems.reduce((sum, row) => sum + Number(row.lineAmountRupees || 0), 0)
      : Number(escrowTaskAmountRupees?.toString() || lineAmountRupees);

  let feeBase = lineAmountRupees;
  if (totalCatalogLineRupees > 0 && Math.abs(totalCatalogLineRupees - capturedRupees) > 0.01) {
    feeBase = (lineAmountRupees / totalCatalogLineRupees) * capturedRupees;
  }

  if (isLastActiveItem) {
    feeBase = Math.min(feeBase, maxRefundableRupees);
  }

  const rounded = Math.round(feeBase * 100) / 100;
  logger.info('Book Now line refund fee base resolved', {
    taskId,
    lineAmountRupees,
    capturedRupees,
    totalCatalogLineRupees,
    feeBase: rounded,
    isLastActiveItem,
    maxRefundableRupees,
  });
  return rounded;
}

/** Refund one Book Now line item from a multi-service checkout (partial refund, escrow stays held). */
export async function processBookNowLineItemRefund(params: {
  bookingOrderId: string;
  taskId: string;
  lineAmountRupees: number;
  taskStartDate: Date;
  assignedAt?: Date | null;
  reason?: string;
  userId?: string;
  taskTitle?: string;
  isLastActiveItem: boolean;
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  partnerAssigned?: boolean;
}): Promise<{ success: boolean; refund?: any; error?: string }> {
  const {
    bookingOrderId,
    taskId,
    lineAmountRupees,
    taskStartDate,
    assignedAt,
    reason,
    userId,
    taskTitle,
    isLastActiveItem,
    catalogId,
    partnerReachedLocation,
    partnerAssigned,
  } = params;

  try {
    if (!(await ensurePostgresReady())) {
      return { success: false, error: 'Postgres not connected' };
    }

    const { findEscrowByBookingOrderId, isBookNowEscrowRecord } = await import('./escrowService');
    const postgresEscrow = await findEscrowByBookingOrderId(bookingOrderId);
    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found for booking' };
    }
    if (!isBookNowEscrowRecord(postgresEscrow)) {
      return { success: false, error: 'Not a Book Now escrow' };
    }
    if (String(postgresEscrow.status || '').toLowerCase() === 'released') {
      return {
        success: false,
        error: 'Refund cannot be processed after payout release.',
      };
    }
    const razorpayPaymentId = postgresEscrow.razorpayPaymentId;
    if (!razorpayPaymentId) {
      return { success: false, error: 'Payment not captured — nothing to refund' };
    }

    const meta = (postgresEscrow.metadata as Record<string, unknown> | null) || {};
    const cancelledIds = Array.isArray(meta.cancelledLineTaskIds)
      ? (meta.cancelledLineTaskIds as string[])
      : [];
    if (cancelledIds.includes(taskId)) {
      return { success: false, error: 'This service was already refunded' };
    }

    const paymentFetch = await getPaymentDetails(
      razorpayPaymentId,
      await resolvePaymentEnvironmentForPayment(razorpayPaymentId, bookingOrderId),
    );
    if (!paymentFetch.success || !paymentFetch.payment) {
      return { success: false, error: 'Could not load payment for refund' };
    }

    const capturedPaise = Number(paymentFetch.payment.amount);
    const alreadyRefundedPaise = Number(paymentFetch.payment.amount_refunded ?? 0);
    const maxRefundablePaise = capturedPaise - alreadyRefundedPaise;
    if (!Number.isFinite(maxRefundablePaise) || maxRefundablePaise <= 0) {
      return { success: false, error: 'No capturable balance left to refund' };
    }

    const cancelledAt = new Date();
    const feeBaseRupees = resolveBookNowLineFeeBase({
      lineAmountRupees,
      capturedPaise,
      maxRefundablePaise,
      taskId,
      isLastActiveItem,
      meta,
      escrowTaskAmountRupees: postgresEscrow.taskAmount,
    });

    const resolvedCatalogId = resolveBookNowCatalogId(meta, taskId, catalogId);
    const escrowPerformer = String(postgresEscrow.performerUid || '').trim();
    const inferredAssigned =
      escrowPerformer.length > 0 && escrowPerformer !== 'pending_assignment';
    const effectivePartnerAssigned =
      partnerAssigned !== undefined ? partnerAssigned : inferredAssigned;
    logger.info('Book Now line cancellation assignment gate', {
      bookingOrderId,
      taskId,
      partnerAssigned: effectivePartnerAssigned,
      source: partnerAssigned !== undefined ? 'request' : 'escrow_performerUid',
    });
    const feeResult = await calculateBookNowCancellationFee({
      catalogId: resolvedCatalogId,
      amount: feeBaseRupees,
      taskStartDate,
      cancelledAt,
      partnerReachedLocation,
      partnerAssigned: effectivePartnerAssigned,
    });

    let refundPaise = Math.round(parseFloat(feeResult.refundAmount.toString()) * 100);
    if (refundPaise <= 0) {
      return {
        success: false,
        error: 'Calculated refund after cancellation fees is zero; nothing to return via Razorpay',
      };
    }
    if (refundPaise > maxRefundablePaise) {
      logger.warn('Book Now line refund capped to remaining Razorpay balance', {
        bookingOrderId,
        taskId,
        requestedRefundPaise: refundPaise,
        maxRefundablePaise,
        lineAmountRupees,
        feeBaseRupees,
        isLastActiveItem,
      });
      refundPaise = maxRefundablePaise;
    }

    const refundAmount = new Prisma.Decimal((refundPaise / 100).toFixed(2));
    const cancellationFee = feeResult.cancellationFee;
    const toOtherParty = feeResult.toOtherParty;
    const toPlatform = feeResult.toPlatform;
    const razorpayRefundResult = await createRefundAmountPaise(
      razorpayPaymentId,
      refundPaise,
      await resolvePaymentEnvironmentForPayment(razorpayPaymentId, bookingOrderId),
    );
    if (!razorpayRefundResult.success || !razorpayRefundResult.refund) {
      return {
        success: false,
        error: razorpayRefundResult.error || 'Failed to create Razorpay refund',
      };
    }

    const razorpayRefund = razorpayRefundResult.refund;
    const refundId = generateRefundId();
    const nextCancelledIds = [...cancelledIds, taskId];
    const prevLineDetails = Array.isArray(meta.cancelledLineDetails)
      ? (meta.cancelledLineDetails as Array<Record<string, unknown>>)
      : [];
    const cancellationPolicy = describeBookNowCancellationPolicy({
      catalogId: resolvedCatalogId,
      tier: feeResult.tier,
      cancellationFee: feeResult.cancellationFee,
    });
    const resolvedLineTitle = taskTitle?.trim() || undefined;
    const lineDetail = {
      taskId,
      taskTitle: resolvedLineTitle,
      lineAmountRupees,
      refundAmount: refundAmount.toString(),
      cancellationFee: cancellationFee.toString(),
      cancellationFeePercentage: feeResult.cancellationFeePercentage,
      cancellationPolicyLabel: cancellationPolicy.label,
      cancellationPolicyKey: cancellationPolicy.policyKey,
      cancelledAt: cancelledAt.toISOString(),
    };

    const internalRefundStatus = getInternalRefundStatus(razorpayRefund.status);
    const providerProcessedAt =
      internalRefundStatus === 'completed' ? new Date() : undefined;

    await prisma.$transaction(async (tx) => {
      const latestEntry = await tx.ledger.findFirst({
        where: { escrowId: postgresEscrow.id },
        orderBy: { createdAt: 'desc' },
      });
      const currentBalance = latestEntry?.balanceAfter || new Prisma.Decimal('0.00');
      const balanceAfter = Prisma.Decimal.max(
        currentBalance.sub(refundAmount),
        new Prisma.Decimal('0.00'),
      );

      const postgresRefund = await tx.refund.create({
        data: {
          refundId,
          escrowId: postgresEscrow.id,
          taskId,
          paymentId: razorpayPaymentId,
          razorpayRefundId: razorpayRefund.id,
          refundAmount,
          cancellationFee: cancellationFee.greaterThan(0) ? cancellationFee : null,
          toOtherParty: toOtherParty.greaterThan(0) ? toOtherParty : null,
          toPlatform: toPlatform.greaterThan(0) ? toPlatform : null,
          reason: resolvedLineTitle
            ? `Book Now line cancelled: ${resolvedLineTitle}`
            : reason || 'Book Now line cancelled',
          cancelledBy: 'poster',
          status: internalRefundStatus,
          providerStatus: razorpayRefund.status || null,
          ...(providerProcessedAt
            ? { completedAt: providerProcessedAt, providerProcessedAt }
            : {}),
        },
      });

      await tx.ledger.create({
        data: {
          transactionId: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          escrowId: postgresEscrow.id,
          refundId: postgresRefund.id,
          type: 'refund',
          amount: refundAmount.neg(),
          balanceBefore: currentBalance,
          balanceAfter,
          description: `Partial Book Now refund for task ${taskId}`,
          metadata: {
            refundId,
            taskId,
            bookingOrderId,
            razorpayRefundId: razorpayRefund.id,
          },
        },
      });

      const remainingPaise = maxRefundablePaise - refundPaise;
      const closeEscrow = isLastActiveItem || remainingPaise <= 0;

      await tx.escrow.update({
        where: { id: postgresEscrow.id },
        data: {
          status: closeEscrow ? 'refunded' : 'held',
          ...(closeEscrow ? { refundedAt: new Date() } : {}),
          metadata: {
            ...meta,
            cancelledLineTaskIds: nextCancelledIds,
            cancelledLineDetails: [
              ...prevLineDetails.filter((row) => String(row.taskId) !== taskId),
              lineDetail,
            ],
            lastPartialRefundTaskId: taskId,
            lastPartialRefundAt: new Date().toISOString(),
          } as any,
        },
      });
    });

    logger.info('Book Now line item refund processed', {
      bookingOrderId,
      taskId,
      refundPaise,
      isLastActiveItem,
      userId,
    });

    const posterContact = await getProfileContact(postgresEscrow.posterUid);
    const resolvedPosterUid = posterContact?.uid || postgresEscrow.posterUid;

    void notifyRefundStatusUpdated({
      posterUid: resolvedPosterUid,
      refundId,
      amount: refundAmount.toString(),
      taskId,
      status: 'initiated',
    });
    if (internalRefundStatus === 'completed') {
      void notifyRefundStatusUpdated({
        posterUid: resolvedPosterUid,
        refundId,
        amount: refundAmount.toString(),
        taskId,
        status: 'completed',
      });
    }

    return {
      success: true,
      refund: {
        refundId,
        razorpayRefundId: razorpayRefund.id,
        amount: refundAmount.toString(),
        status: razorpayRefund.status || 'processing',
      },
    };
  } catch (error: any) {
    logger.error('Book Now line item refund failed', {
      bookingOrderId,
      taskId,
      error: error?.message,
    });
    return { success: false, error: error?.message || 'Failed to process partial refund' };
  }
}

type RazorpayRefundWebhookPayload = {
  refund?: {
    entity?: {
      id?: string;
      status?: string;
      payment_id?: string;
      amount?: number;
      notes?: Record<string, unknown>;
    };
  };
  payment?: { entity?: { id?: string; amount?: number; amount_refunded?: number; status?: string } };
  eventCreatedAt?: number | string;
};

/**
 * Sync refund status and the provider-confirmed processing time from Razorpay webhooks.
 */
export async function completeRefundFromRazorpayWebhook(
  payload: RazorpayRefundWebhookPayload,
): Promise<void> {
  const refundEntity = payload?.refund?.entity;
  const paymentEntity = payload?.payment?.entity;
  const razorpayRefundId = refundEntity?.id;
  if (!razorpayRefundId) {
    logger.warn('Refund webhook missing refund entity id');
    if (paymentEntity?.id) {
      await syncRecurringEscrowAfterRefundWebhook(undefined, paymentEntity);
    }
    return;
  }

  await syncExtraMartRefundFromRazorpayWebhook(refundEntity);
  if (!isPostgresConnected()) {
    logger.warn('Refund webhook skipped — Postgres not connected');
    return;
  }

  await updateRefundRecordFromRazorpayWebhook(
    razorpayRefundId,
    refundEntity,
    payload.eventCreatedAt,
  );
  const razorpayStatus = String(refundEntity?.status || '').trim().toLowerCase();
  if (razorpayStatus && !['processed', 'completed', 'success'].includes(razorpayStatus)) return;
  await syncRecurringEscrowAfterRefundWebhook(razorpayRefundId, paymentEntity, refundEntity?.payment_id);
}

async function syncExtraMartRefundFromRazorpayWebhook(
  refundEntity: NonNullable<RazorpayRefundWebhookPayload['refund']>['entity'],
): Promise<void> {
  const notes = refundEntity?.notes;
  if (notes?.source !== 'extramart') return;

  const baseUrl = process.env.QCOMMERCE_SERVICE_URL?.trim().replace(/\/$/, '');
  const serviceAuth = process.env.SERVICE_AUTH_TOKEN?.trim();
  const orderNumber = typeof notes.orderNumber === 'string' ? notes.orderNumber.trim() : '';
  const razorpayRefundId = String(refundEntity?.id || '').trim();
  if (!baseUrl || !serviceAuth || !orderNumber || !razorpayRefundId) {
    throw new Error('ExtraMart refund webhook sync is missing service configuration or refund identifiers');
  }

  const response = await fetch(`${baseUrl}/api/v1/internal/refunds/razorpay-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Auth': serviceAuth,
      'X-Service-Name': 'payment-service',
    },
    body: JSON.stringify({
      orderNumber,
      razorpayRefundId,
      providerStatus: refundEntity?.status || '',
      reason: typeof notes.reason === 'string' ? notes.reason : '',
      amountPaise: refundEntity?.amount,
    }),
  });

  if (!response.ok) {
    throw new Error(`ExtraMart refund webhook sync failed (HTTP ${response.status})`);
  }
}

async function syncRecurringEscrowAfterRefundWebhook(
  razorpayRefundId: string | undefined,
  paymentEntity: NonNullable<RazorpayRefundWebhookPayload['payment']>['entity'],
  refundPaymentId?: string,
): Promise<void> {
  try {
    await syncRecurringEscrowFromRefundWebhook({
      razorpayRefundId,
      razorpayPaymentId: refundPaymentId || paymentEntity?.id,
      payment: paymentEntity,
    });
  } catch (error: any) {
    logger.error('Refund webhook: recurring visit escrow sync failed', {
      razorpayRefundId,
      razorpayPaymentId: refundPaymentId || paymentEntity?.id,
      error: error?.message || String(error),
    });
  }
}

async function updateRefundRecordFromRazorpayWebhook(
  razorpayRefundId: string,
  refundEntity: NonNullable<RazorpayRefundWebhookPayload['refund']>['entity'],
  eventCreatedAt?: number | string,
): Promise<void> {
  const razorpayStatus = String(refundEntity?.status || '').trim().toLowerCase();
  const eventTimestamp = Number(eventCreatedAt);
  const providerStatusUpdatedAt =
    Number.isFinite(eventTimestamp) && eventTimestamp > 0
      ? new Date(eventTimestamp * 1000)
      : new Date();

  const notificationDetails = async () =>
    prisma.refund.findUnique({
      where: { razorpayRefundId },
      select: {
        refundId: true,
        refundAmount: true,
        taskId: true,
        escrow: { select: { posterUid: true } },
      },
    });

  if (razorpayStatus === 'failed') {
    const refund = await notificationDetails();
    const data = {
      status: 'failed',
      providerStatus: razorpayStatus,
      errorMessage: 'Razorpay reported refund failure',
      updatedAt: providerStatusUpdatedAt,
    };
    const result = await prisma.refund.updateMany({
      where: { razorpayRefundId, status: { not: 'failed' } },
      data,
    });
    if (result.count > 0) {
      logger.info('Refund marked failed from Razorpay webhook', { razorpayRefundId });
      if (refund?.escrow?.posterUid) {
        const posterContact = await getProfileContact(refund.escrow.posterUid);
        await notifyRefundStatusUpdated({
          posterUid: posterContact?.uid || refund.escrow.posterUid,
          refundId: refund.refundId,
          amount: refund.refundAmount.toString(),
          taskId: refund.taskId,
          status: 'failed',
        });
      }
    } else {
      await prisma.refund.updateMany({
        where: { razorpayRefundId, status: 'failed' },
        data,
      });
      if (!refund) {
        logger.warn('Refund webhook for unknown razorpayRefundId', { razorpayRefundId });
      }
    }
    return;
  }

  const terminalStatuses = new Set(['processed', 'completed', 'success']);
  if (!terminalStatuses.has(razorpayStatus) && razorpayStatus) {
    await prisma.refund.updateMany({
      where: {
        razorpayRefundId,
        status: { in: ['pending', 'processing'] },
      },
      data: {
        status: 'processing',
        providerStatus: razorpayStatus,
        updatedAt: providerStatusUpdatedAt,
      },
    });
    logger.info('Refund webhook received — non-terminal Razorpay status', {
      razorpayRefundId,
      razorpayStatus,
    });
    return;
  }

  const refund = await notificationDetails();
  const data = {
    status: 'completed',
    providerStatus: razorpayStatus,
    completedAt: providerStatusUpdatedAt,
    providerProcessedAt: providerStatusUpdatedAt,
    updatedAt: providerStatusUpdatedAt,
  };
  const result = await prisma.refund.updateMany({
    where: {
      razorpayRefundId,
      status: { in: ['pending', 'processing'] },
    },
    data,
  });

  if (result.count > 0) {
    logger.info('Refund marked completed from Razorpay webhook', { razorpayRefundId });
    if (refund?.escrow?.posterUid) {
      const posterContact = await getProfileContact(refund.escrow.posterUid);
      await notifyRefundStatusUpdated({
        posterUid: posterContact?.uid || refund.escrow.posterUid,
        refundId: refund.refundId,
        amount: refund.refundAmount.toString(),
        taskId: refund.taskId,
        status: 'completed',
      });
    }
    return;
  }

  await prisma.refund.updateMany({
    where: { razorpayRefundId, status: 'completed' },
    data,
  });
  if (!refund) {
    const paymentId = refundEntity?.payment_id;
    if (paymentId) {
      try {
        const escrow = await prisma.escrow.findFirst({
          where: { razorpayPaymentId: paymentId },
        });
        if (escrow) {
          const refundAmountRupees = new Prisma.Decimal(
            (Number(refundEntity?.amount || escrow.amount) / 100).toFixed(2),
          );
          const internalStatus = getInternalRefundStatus(razorpayStatus);
          const newRefundId = `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          await prisma.refund.create({
            data: {
              refundId: newRefundId,
              taskId: escrow.taskId,
              escrowId: escrow.id,
              paymentId,
              razorpayRefundId,
              refundAmount: refundAmountRupees,
              status: internalStatus,
              providerStatus: razorpayStatus || null,
              reason: (refundEntity?.notes as any)?.reason || 'Refund processed directly via Razorpay',
              cancelledBy: 'performer',
              completedAt: providerStatusUpdatedAt,
              providerProcessedAt: providerStatusUpdatedAt,
              createdAt: providerStatusUpdatedAt,
            },
          });

          await prisma.escrow.update({
            where: { id: escrow.id },
            data: {
              status: 'refunded',
              refundedAt: providerStatusUpdatedAt,
            },
          });

          await prisma.transaction.updateMany({
            where: { razorpayPaymentId: paymentId },
            data: {
              status: 'refunded',
            },
          });

          await syncMongoTaskRefundStatus(escrow.taskId, paymentId, escrow.razorpayOrderId, providerStatusUpdatedAt);

          logger.info('✅ Auto-created ExtraHand refund from Razorpay webhook for out-of-band refund', {
            razorpayRefundId,
            paymentId,
            taskId: escrow.taskId,
            refundId: newRefundId,
          });
          return;
        }
      } catch (autoCreateErr: any) {
        logger.error('Failed to auto-create refund from webhook for out-of-band refund:', autoCreateErr);
      }
    }
    logger.warn('Refund webhook for unknown razorpayRefundId', { razorpayRefundId });
  }
}

async function syncMongoTaskRefundStatus(
  taskId?: string | null,
  paymentId?: string | null,
  orderId?: string | null,
  refundedAt?: Date,
): Promise<void> {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const db = mongoose.connection.db;
    if (!db) return;
    const at = refundedAt || new Date();
    if (taskId) {
      const taskQuery: any = {
        $or: [
          { taskId },
          ...(mongoose.isValidObjectId(taskId) ? [{ _id: new mongoose.Types.ObjectId(taskId) }] : []),
        ],
      };
      await db.collection('tasks').updateOne(taskQuery, {
        $set: {
          escrowStatus: 'refunded',
          paymentStatus: 'refunded',
          isRefunded: true,
          refundedAt: at,
        },
      });
      await db.collection('bookingorders').updateMany(taskQuery, {
        $set: {
          status: 'refunded',
          paymentStatus: 'refunded',
        },
      });
    }
    if (paymentId || orderId) {
      const orderQuery: any = {
        $or: [
          ...(paymentId ? [{ razorpayPaymentId: paymentId }] : []),
          ...(orderId ? [{ razorpayOrderId: orderId }] : []),
        ],
      };
      await db.collection('bookingorders').updateMany(orderQuery, {
        $set: {
          status: 'refunded',
          paymentStatus: 'refunded',
        },
      });
    }
  } catch (err: any) {
    logger.warn('Failed to sync Mongo task refund status:', {
      taskId,
      paymentId,
      error: err?.message || String(err),
    });
  }
}
