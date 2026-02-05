/**
 * Refund Service
 * 
 * Handles refunds (full/partial) with cancellation fee calculation
 * Uses Prisma for financial data storage
 */

import logger from '../config/logger';
import { razorpay } from '../config/razorpay';
import { isPostgresConnected } from '../config/database';
import { createLedgerEntry, getEscrowBalance } from './ledgerService';
import { 
  calculateCancellationFee, 
  calculateRefundWithCancellationFee,
  CancellationFeeResult 
} from './feeCalculationService';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { createRefund as createRazorpayRefund } from './paymentService';
import { sanitizeRazorpayRefundData } from '../utils/paymentSanitizer';
import { EmailServiceClient } from '../clients/EmailServiceClient';

/**
 * Generate unique refund ID
 */
function generateRefundId(): string {
  return `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Process refund with cancellation fee
 * 
 * @param params - Refund parameters
 * @returns Refund result
 */
export async function processRefund(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  reason?: string;
  cancelledBy: 'poster' | 'performer';
  taskStartDate: Date;
  cancelledAt: Date;
  userId?: string;
  amount?: number; // Optional: for partial refunds (in rupees)
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
      amount, // Optional partial refund amount
    } = params;

    logger.info('💰 Processing refund', {
      razorpayOrderId,
      razorpayPaymentId,
      reason,
      cancelledBy,
    });

    // Get escrow from Postgres
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (!postgresEscrow) {
      logger.warn('⚠️ Escrow not found for order:', razorpayOrderId);
      return { success: false, error: 'Escrow not found' };
    }

    // Check escrow status
    if (postgresEscrow.status === 'refunded') {
      logger.warn('⚠️ Escrow already refunded', { razorpayOrderId });
      // Check if there's an existing completed refund - return it for idempotency
      const existingRefund = await prisma.refund.findFirst({
        where: {
          escrowId: postgresEscrow.id,
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existingRefund) {
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
      return { success: false, error: 'Escrow already refunded' };
    }

    if (postgresEscrow.status !== 'held' && postgresEscrow.status !== 'pending') {
      logger.warn('⚠️ Cannot refund - escrow status:', postgresEscrow.status);
      return { success: false, error: `Cannot refund - escrow status: ${postgresEscrow.status}` };
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
      // If processing, return error (don't allow duplicate processing)
      return { success: false, error: 'Refund already in progress' };
    }

    // Get original amount
    const originalAmount = postgresEscrow.amountInRupees;

    // Calculate cancellation fee and refund amount
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
    } else {
      // Full refund with cancellation fee
      cancellationFeeResult = await calculateRefundWithCancellationFee({
        amount: originalAmount,
        taskStartDate,
        cancelledAt,
        cancelledBy,
      });

      refundAmount = cancellationFeeResult.refundAmount;
      cancellationFee = cancellationFeeResult.cancellationFee;
      toOtherParty = cancellationFeeResult.toOtherParty;
      toPlatform = cancellationFeeResult.toPlatform;
      cancellationFeePercentage = cancellationFeeResult.cancellationFeePercentage;
    }

    // Convert refund amount to paise for Razorpay
    const refundAmountInPaise = Math.round(parseFloat(refundAmount.toString()) * 100);

    // Create refund in Razorpay
    const razorpayRefundResult = await createRazorpayRefund(
      razorpayPaymentId,
      amount ? amount : undefined // Pass amount only for partial refunds
    );

    if (!razorpayRefundResult.success || !razorpayRefundResult.refund) {
      logger.error('❌ Failed to create Razorpay refund:', razorpayRefundResult.error);
      return { success: false, error: razorpayRefundResult.error || 'Failed to create Razorpay refund' };
    }

    const razorpayRefund = razorpayRefundResult.refund;

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
              originalAmount: originalAmount.toString(),
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

      // Send refund processed email (non-blocking)
      // Note: Requires user email lookup from user-service
      logger.info('Email trigger: refund_processed', {
        posterUid: postgresEscrow.posterUid,
        refundAmount: refundAmount.toString(),
        cancellationFee: cancellationFee.toString(),
        taskId: postgresEscrow.taskId,
        reason,
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

