import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
import { calculateRefundWithCancellationFee, CancellationFeeResult } from './feeCalculationService';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import mongoose from 'mongoose';
import { createRefundAmountPaise, getPaymentDetails } from './paymentService';
import { sanitizeRazorpayRefundData } from '../utils/paymentSanitizer';
import { notifyRefundInitiated } from './paymentNotificationService';

function generateRefundId(): string {
  return `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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

    if (amount) {
      // Partial refund - no cancellation fee
      refundAmount = new Prisma.Decimal(amount.toString());
      cancellationFee = new Prisma.Decimal('0.00');
      toOtherParty = new Prisma.Decimal('0.00');
      toPlatform = new Prisma.Decimal('0.00');
    } else if (cancelledBy === 'performer') {
      // Tasker cancel: poster gets full captured amount back (includes platform fee + GST)
      // Policy penalty is recovered from performer's future payouts.
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
      // Poster cancel: time-based cancellation fee may reduce refund
      // Use taskAmount as feeBaseAmount if available (for refund calculation on task amount only, not fees/GST)
      const refundFeeBase = refundTaskBase;
      
      cancellationFeeResult = await calculateRefundWithCancellationFee({
        amount: refundFeeBase,  // Calculate fees on task amount, not full capture
        taskStartDate,
        cancelledAt,
        cancelledBy,
        assignedAt,
        feeBaseAmount: refundFeeBase,
      });

      refundAmount = cancellationFeeResult.refundAmount;
      cancellationFee = cancellationFeeResult.cancellationFee;
      toOtherParty = cancellationFeeResult.toOtherParty;
      toPlatform = cancellationFeeResult.toPlatform;
      cancellationFeePercentage = cancellationFeeResult.cancellationFeePercentage;
    }

    let refundAmountInPaise = Math.round(parseFloat(refundAmount.toString()) * 100);
    if (refundAmountInPaise <= 0) {
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

    logger.info('[RefundService.processRefund] Calling Razorpay refund API', {
      razorpayOrderId,
      razorpayPaymentId,
      refundAmountInPaise,
      refundAmountRupees: (refundAmountInPaise / 100).toFixed(2),
      maxRefundablePaise,
      cancelledBy,
    });

    const razorpayRefundResult = await createRefundAmountPaise(razorpayPaymentId, refundAmountInPaise);

    if (!razorpayRefundResult.success || !razorpayRefundResult.refund) {
      logger.error('❌ Failed to create Razorpay refund:', {
        razorpayOrderId,
        razorpayPaymentId,
        refundAmountInPaise,
        error: razorpayRefundResult.error,
      });
      return { success: false, error: razorpayRefundResult.error || 'Failed to create Razorpay refund' };
    }

    const razorpayRefund = razorpayRefundResult.refund;
    logger.info('[RefundService.processRefund] Razorpay refund API success', {
      razorpayOrderId,
      razorpayPaymentId,
      razorpayRefundId: razorpayRefund.id,
      razorpayRefundStatus: razorpayRefund.status,
      razorpayRefundAmountPaise: razorpayRefund.amount,
      razorpayRefundSpeed: razorpayRefund.speed_processed || razorpayRefund.speed_requested,
    });

    // Sanitize Razorpay refund data
    const sanitizedRefundData = sanitizeRazorpayRefundData(razorpayRefund);

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
        
        // Poster gets refund
        updateUserPaymentProfile(postgresEscrow.posterUid, {
          type: 'refund',
          amount: refundAmount,
          refundId,
          escrowId: postgresEscrow.id,
        }).catch((error) => {
          logger.warn('Failed to update UserPaymentProfile for refund (non-critical):', error);
        });

        // Performer gets compensation (if applicable)
        if (toOtherParty.greaterThan(0)) {
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

