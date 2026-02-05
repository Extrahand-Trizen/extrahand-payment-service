/**
 * Payment Failure Service
 * 
 * Handles payment failures, updates escrow status, and creates ledger entries
 */

import logger from '../config/logger';
import { updateEscrowOnPaymentCapture } from './escrowService';
import { createLedgerEntry } from './ledgerService';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { getEscrowBalance } from './ledgerService';
import { EmailServiceClient } from '../clients/EmailServiceClient';

/**
 * Handle payment failure
 * 
 * @param razorpayOrderId - Razorpay order ID
 * @param razorpayPaymentId - Razorpay payment ID (if available)
 * @param failureReason - Reason for failure
 * @param errorCode - Error code (if available)
 * @returns Success status
 */
export async function handlePaymentFailure(params: {
  razorpayOrderId: string;
  razorpayPaymentId?: string;
  failureReason: string;
  errorCode?: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { razorpayOrderId, razorpayPaymentId, failureReason, errorCode } = params;

    logger.warn('⚠️ Payment failure detected', {
      razorpayOrderId,
      razorpayPaymentId,
      failureReason,
      errorCode,
    });

    // Update escrow status to 'failed'
    const updateResult = await updateEscrowOnPaymentCapture(
      razorpayOrderId,
      razorpayPaymentId || 'unknown',
      'failed'
    );

    if (!updateResult.success) {
      logger.error('❌ Failed to update escrow on payment failure:', updateResult.error);
      return { success: false, error: updateResult.error };
    }

    // Create ledger entry for payment failure
    const postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (postgresEscrow) {
      // Get current balance
      const balanceResult = await getEscrowBalance(postgresEscrow.id);
      const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');

      // Create ledger entry for failure (balance remains 0, no money was captured)
      await createLedgerEntry({
        escrowId: postgresEscrow.id,
        type: 'payment',
        amount: new Prisma.Decimal('0.00'), // No amount captured
        balanceBefore: currentBalance,
        balanceAfter: currentBalance, // Balance unchanged (payment failed)
        description: `Payment failed: ${failureReason}`,
        metadata: {
          razorpayOrderId,
          razorpayPaymentId,
          failureReason,
          errorCode,
        },
      });

      // Send payment failed email (non-blocking)
      // Note: Requires user email lookup from user-service
      logger.info('Email trigger: payment_failed', {
        posterUid: postgresEscrow.posterUid,
        amount: postgresEscrow.amountInRupees.toString(),
        taskId: postgresEscrow.taskId,
        failureReason,
        errorCode,
      });
    }

    logger.info('✅ Payment failure handled', {
      razorpayOrderId,
      failureReason,
    });

    return { success: true };
  } catch (error: any) {
    logger.error('❌ Error handling payment failure:', error);
    return { success: false, error: error.message || 'Failed to handle payment failure' };
  }
}

/**
 * Handle payment authorization failure (payment was attempted but not authorized)
 * 
 * @param razorpayOrderId - Razorpay order ID
 * @param razorpayPaymentId - Razorpay payment ID
 * @param failureReason - Reason for failure
 * @returns Success status
 */
export async function handlePaymentAuthorizationFailure(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  failureReason: string;
}): Promise<{ success: boolean; error?: string }> {
  return handlePaymentFailure({
    razorpayOrderId: params.razorpayOrderId,
    razorpayPaymentId: params.razorpayPaymentId,
    failureReason: `Authorization failed: ${params.failureReason}`,
    errorCode: 'AUTHORIZATION_FAILED',
  });
}

/**
 * Handle payment capture failure (payment was authorized but capture failed)
 * 
 * @param razorpayOrderId - Razorpay order ID
 * @param razorpayPaymentId - Razorpay payment ID
 * @param failureReason - Reason for failure
 * @returns Success status
 */
export async function handlePaymentCaptureFailure(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  failureReason: string;
}): Promise<{ success: boolean; error?: string }> {
  return handlePaymentFailure({
    razorpayOrderId: params.razorpayOrderId,
    razorpayPaymentId: params.razorpayPaymentId,
    failureReason: `Capture failed: ${params.failureReason}`,
    errorCode: 'CAPTURE_FAILED',
  });
}








