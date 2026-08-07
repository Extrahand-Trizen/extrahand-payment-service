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
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import mongoose from 'mongoose';
import { createRefundAmountPaise, getPaymentDetails } from './paymentService';
import { sanitizeRazorpayRefundData } from '../utils/paymentSanitizer';
import { notifyRefundInitiated } from './paymentNotificationService';

function generateRefundId(): string {
  return `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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

async function getProfileContact(uid: string): Promise<{ email?: string; name?: string } | null> {
  if (!uid || mongoose.connection.readyState !== 1) return null;

  try {
    const Profile = mongoose.connection.collection('profiles');
    const profile =
      (await Profile.findOne({ uid })) ||
      (mongoose.isValidObjectId(uid) ? await Profile.findOne({ _id: new mongoose.Types.ObjectId(uid) }) : null);

    if (!profile) return null;

    return {
      email: profile.email,
      name: profile.name || profile.displayName || 'User',
    };
  } catch (error) {
    logger.debug('Failed to load profile contact for refund notification', { error, uid });
    return null;
  }
}

export async function processRefund(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
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
      razorpayOrderId,
      razorpayPaymentId,
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
      precomputedSettlement,
    } = params;

    logger.info('💰 Processing refund', {
      razorpayOrderId,
      razorpayPaymentId,
      reason,
      cancelledBy,
    });

    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findUnique({ where: { razorpayOrderId } });
    if (!postgresEscrow) {
      logger.warn('⚠️ Escrow not found for order:', razorpayOrderId);
      return { success: false, error: 'Escrow not found' };
    }

    if (postgresEscrow.status === 'refunded') {
      return { success: false, error: 'Escrow already refunded' };
    }

    if (postgresEscrow.status === 'released') {
      return {
        success: false,
        error: 'Refund cannot be processed after payout release.',
      };
    }

    // Idempotency check: Check if a refund is already in progress or completed for this payment
    const existingRefund = await prisma.refund.findFirst({
      where: {
        escrowId: postgresEscrow.id,
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

    const escrowAmountRupees = postgresEscrow.amountInRupees;

    const paymentFetch = await getPaymentDetails(razorpayPaymentId);
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

    /** Actual INR captured on Razorpay (task + platform fee + GST, etc.) */
    const capturedRupees = new Prisma.Decimal((capturedPaise / 100).toFixed(2));
    const normalizePercent = (value?: Prisma.Decimal | null): Prisma.Decimal | null => {
      if (!value) return null;
      const one = new Prisma.Decimal('1');
      return value.greaterThan(one) ? value.div(new Prisma.Decimal('100')) : value;
    };
    const inferredTaskAmountFromEscrow = (() => {
      const platformPct = normalizePercent(postgresEscrow.appliedPlatformFeePercent as Prisma.Decimal | null);
      const gstPct = normalizePercent(postgresEscrow.appliedGstPercent as Prisma.Decimal | null) || new Prisma.Decimal('0');
      if (!platformPct) return null;
      const multiplier = new Prisma.Decimal('1').plus(platformPct.mul(new Prisma.Decimal('1').plus(gstPct)));
      if (multiplier.lessThanOrEqualTo(0)) return null;
      return capturedRupees.div(multiplier).toDecimalPlaces(2);
    })();
    const refundTaskBase =
      feeBaseAmount != null
        ? new Prisma.Decimal(feeBaseAmount.toString())
        : postgresEscrow.taskAmount
        ? new Prisma.Decimal(postgresEscrow.taskAmount.toString())
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
      const escrowMeta = (postgresEscrow.metadata as Record<string, unknown> | null) || {};
      const isBookNow = isBookNowEscrowRecord(postgresEscrow);
      const refundableCapturedRupees = new Prisma.Decimal(
        (maxRefundablePaise / 100).toFixed(2),
      );

      if (isBookNow) {
        const resolvedCatalogId = resolveBookNowCatalogId(
          escrowMeta,
          postgresEscrow.taskId,
          catalogId,
        );
        const bookNowFee = await calculateBookNowCancellationFee({
          catalogId: resolvedCatalogId,
          amount: refundableCapturedRupees,
          taskStartDate,
          cancelledAt,
          partnerReachedLocation,
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

      const razorpayRefundResult = await createRefundAmountPaise(
        razorpayPaymentId,
        refundAmountInPaise,
      );

      if (!razorpayRefundResult.success || !razorpayRefundResult.refund) {
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

      razorpayRefund = razorpayRefundResult.refund;
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

    try {
      if (isPostgresConnected()) {
        // Wrap all database operations in a transaction for atomicity
        await prisma.$transaction(async (tx) => {
          // Get current escrow balance with row-level locking to prevent race conditions
          const latestEntry = await tx.ledger.findFirst({
            where: { escrowId: postgresEscrow.id },
            orderBy: { createdAt: 'desc' },
          });
          const currentBalance = latestEntry?.balanceAfter || new Prisma.Decimal('0.00');

          // Create refund record in Postgres
          // Note: amount is not stored - get it from escrow.amountInRupees when needed
          postgresRefund = await tx.refund.create({
            data: {
              refundId,
              escrowId: postgresEscrow.id,
              taskId: postgresEscrow.taskId,
              paymentId: razorpayPaymentId,
              razorpayRefundId: razorpayRefund.id,
              cancellationFee: cancellationFee.greaterThan(0) ? cancellationFee : null,
              refundAmount,
              toOtherParty: toOtherParty.greaterThan(0) ? toOtherParty : null,
              toPlatform: toPlatform.greaterThan(0) ? toPlatform : null,
              reason,
              cancelledBy,
              status: 'processing',
            },
          });

          const ledgerRefundId = postgresRefund.id;

          // Update escrow status to 'refunded'
          await tx.escrow.update({
            where: { id: postgresEscrow.id },
            data: {
              status: 'refunded',
              refundedAt: new Date(),
            },
          });

          // Prepare all ledger entries for batch creation
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
            escrowId: postgresEscrow.id,
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
              escrowId: postgresEscrow.id,
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
                escrowId: postgresEscrow.id,
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
                escrowId: postgresEscrow.id,
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

          // Update refund status to 'completed'
          await tx.refund.update({
            where: { id: postgresRefund.id },
            data: {
              status: 'completed',
              completedAt: new Date(),
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
        if (refundAmount.greaterThan(0)) {
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
        if (toOtherParty.greaterThan(0) && postgresEscrow.performerUid) {
          updateUserPaymentProfile(postgresEscrow.performerUid, {
            type: 'compensation',
            amount: toOtherParty,
            refundId,
            escrowId: postgresEscrow.id,
          }).catch((error) => {
            logger.warn('Failed to update UserPaymentProfile for compensation (non-critical):', error);
          });
        }
      }

      // Escrow already updated in Postgres above (line ~180)

      logger.info('✅ Refund processed successfully', {
        refundId,
        razorpayRefundId: razorpayRefund.id,
        refundAmount: refundAmount.toString(),
        cancellationFee: cancellationFee.toString(),
      });

      // Send refund initiated emails and notifications
      logger.info('Email trigger: refund_initiated', {
        posterUid: postgresEscrow.posterUid,
        refundAmount: refundAmount.toString(),
        cancellationFee: cancellationFee.toString(),
        taskId: postgresEscrow.taskId,
        reason,
      });

      const taskTitle = (postgresEscrow.metadata as any)?.taskTitle || null;
      const posterContact = await getProfileContact(postgresEscrow.posterUid);
      logger.info('[RefundService.processRefund] Dispatching poster refund notification', {
        posterUid: postgresEscrow.posterUid,
        taskId: postgresEscrow.taskId,
        taskTitle,
        refundAmount: refundAmount.toString(),
        hasPosterEmail: Boolean(posterContact?.email),
        hasPosterName: Boolean(posterContact?.name),
        category: 'payments',
      });

      notifyRefundInitiated({
        posterUid: postgresEscrow.posterUid,
        amount: refundAmount.toString(),
        taskId: postgresEscrow.taskId,
        taskTitle,
        reason,
        email: posterContact?.email || null,
        userName: posterContact?.name || null,
      }).catch((error) => {
        logger.warn('[RefundService.processRefund] Failed to send refund initiated notification', {
          posterUid: postgresEscrow.posterUid,
          taskId: postgresEscrow.taskId,
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
          status: 'completed',
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
              status: 'failed',
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
export async function getRefundStatus(refundId: string): Promise<{
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

    // Get original amount from escrow (not stored in refund table)
    const originalAmount = refund.escrow?.amountInRupees || new Prisma.Decimal('0.00');

    return {
      success: true,
      refund: {
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
        createdAt: refund.createdAt,
        completedAt: refund.completedAt,
      },
    };
  } catch (error: any) {
    logger.error('❌ Error getting refund status:', error);
    return { success: false, error: error.message || 'Failed to get refund status' };
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
        createdAt: refund.createdAt,
        completedAt: refund.completedAt,
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

    const paymentFetch = await getPaymentDetails(razorpayPaymentId);
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
    const feeResult = await calculateBookNowCancellationFee({
      catalogId: resolvedCatalogId,
      amount: feeBaseRupees,
      taskStartDate,
      cancelledAt,
      partnerReachedLocation,
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
          status: 'completed',
          completedAt: new Date(),
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

    return {
      success: true,
      refund: {
        refundId,
        razorpayRefundId: razorpayRefund.id,
        amount: refundAmount.toString(),
        status: 'completed',
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
  refund?: { entity?: { id?: string; status?: string } };
  payment?: { entity?: { id?: string } };
};

/**
 * Mark refund completed (or failed) when Razorpay sends refund webhooks.
 * Idempotent — safe when processRefund already set status to completed.
 */
export async function completeRefundFromRazorpayWebhook(
  payload: RazorpayRefundWebhookPayload,
): Promise<void> {
  if (!isPostgresConnected()) {
    logger.warn('Refund webhook skipped — Postgres not connected');
    return;
  }

  const refundEntity = payload?.refund?.entity;
  const razorpayRefundId = refundEntity?.id;
  if (!razorpayRefundId) {
    logger.warn('Refund webhook missing refund entity id');
    return;
  }

  const razorpayStatus = String(refundEntity?.status || '').trim().toLowerCase();

  if (razorpayStatus === 'failed') {
    await prisma.refund.updateMany({
      where: { razorpayRefundId },
      data: {
        status: 'failed',
        errorMessage: 'Razorpay reported refund failure',
      },
    });
    logger.info('Refund marked failed from Razorpay webhook', { razorpayRefundId });
    return;
  }

  const terminalStatuses = new Set(['processed', 'completed', 'success']);
  if (!terminalStatuses.has(razorpayStatus) && razorpayStatus) {
    logger.info('Refund webhook received — non-terminal Razorpay status', {
      razorpayRefundId,
      razorpayStatus,
    });
    return;
  }

  const result = await prisma.refund.updateMany({
    where: {
      razorpayRefundId,
      status: { in: ['pending', 'processing'] },
    },
    data: {
      status: 'completed',
      completedAt: new Date(),
    },
  });

  if (result.count > 0) {
    logger.info('Refund marked completed from Razorpay webhook', { razorpayRefundId });
    return;
  }

  const existing = await prisma.refund.findUnique({ where: { razorpayRefundId } });
  if (!existing) {
    logger.warn('Refund webhook for unknown razorpayRefundId', { razorpayRefundId });
  }
}

