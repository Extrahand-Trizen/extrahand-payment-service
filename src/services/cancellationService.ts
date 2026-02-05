/**
 * Payment Cancellation Service
 * 
 * Handles payment cancellations, updates escrow status, and creates ledger entries
 */

import logger from '../config/logger';
import { razorpay } from '../config/razorpay';
import { isPostgresConnected } from '../config/database';
import { getEscrowByOrderId } from './escrowService';
import { createLedgerEntry, getEscrowBalance } from './ledgerService';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { sanitizeRazorpayData } from '../utils/paymentSanitizer';
import { processRefund } from './refundService';

/**
 * Cancel payment order
 * 
 * @param razorpayOrderId - Razorpay order ID
 * @param reason - Cancellation reason (optional)
 * @param userId - User ID who is cancelling (for audit)
 * @returns Success status and cancellation details
 */
export async function cancelPayment(params: {
  razorpayOrderId: string;
  reason?: string;
  userId?: string;
  cancelledBy?: 'poster' | 'performer';
  taskStartDate?: Date;
}): Promise<{ success: boolean; cancelled?: boolean; refundRequired?: boolean; refund?: any; error?: string }> {
  try {
    const { razorpayOrderId, reason, userId, cancelledBy, taskStartDate } = params;

    logger.info('🔄 Processing payment cancellation', {
      razorpayOrderId,
      reason,
      userId,
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
    if (postgresEscrow.status === 'cancelled') {
      logger.info('✅ Escrow already cancelled', { razorpayOrderId });
      return { success: true, cancelled: true };
    }

    if (postgresEscrow.status === 'released') {
      logger.warn('⚠️ Cannot cancel - escrow already released', { razorpayOrderId });
      return { success: false, error: 'Cannot cancel - escrow already released' };
    }

    // Check if payment was captured
    const paymentCaptured = 
      postgresEscrow.paymentStatus === 'captured' || 
      postgresEscrow.status === 'held';

    let razorpayCancelled = false;
    let refundRequired = false;

    // If payment was captured, we need to process a refund
    if (paymentCaptured && postgresEscrow.razorpayPaymentId) {
      logger.info('💰 Payment was captured - processing refund automatically', {
        razorpayOrderId,
        razorpayPaymentId: postgresEscrow.razorpayPaymentId,
      });
      refundRequired = true;
      
      // Auto-trigger refund processing
      try {
        // Get task details for refund calculation
        const taskId = postgresEscrow.taskId;
        const refundTaskStartDate = taskStartDate || new Date(postgresEscrow.createdAt);
        const refundCancelledBy = cancelledBy || 'poster'; // Default to poster if not specified
        
        const refundResult = await processRefund({
          razorpayOrderId: postgresEscrow.razorpayOrderId,
          razorpayPaymentId: postgresEscrow.razorpayPaymentId,
          reason: reason || 'Payment cancelled',
          cancelledBy: refundCancelledBy,
          taskStartDate: refundTaskStartDate,
          cancelledAt: new Date(),
          userId: userId,
        });

        if (refundResult.success) {
          logger.info('✅ Refund processed automatically after cancellation', {
            razorpayOrderId,
            refundId: refundResult.refund?.refundId,
          });
          // Escrow status is already updated to 'refunded' by processRefund
          return {
            success: true,
            cancelled: true,
            refundRequired: true,
            refund: refundResult.refund,
          };
        } else {
          logger.error('❌ Failed to process refund automatically', {
            razorpayOrderId,
            error: refundResult.error,
          });
          // Continue with cancellation even if refund fails
          // The escrow will be marked as cancelled, and refund can be processed manually later
        }
      } catch (refundError: any) {
        logger.error('❌ Error processing refund automatically', {
          razorpayOrderId,
          error: refundError.message,
        });
        // Continue with cancellation even if refund processing fails
      }
    } else {
      // Try to cancel the Razorpay order (if not captured)
      try {
        // Razorpay doesn't have a direct "cancel order" API
        // Orders are automatically cancelled if payment is not captured within a time limit
        // For our purposes, we'll just mark it as cancelled in our system
        razorpayCancelled = true;
        logger.info('✅ Order marked as cancelled (payment not captured)', {
          razorpayOrderId,
        });
      } catch (error: any) {
        logger.warn('⚠️ Could not cancel Razorpay order (may already be cancelled):', error.message);
        // Continue with cancellation anyway
        razorpayCancelled = true;
      }
    }

    // Check if escrow was already updated by refund processing
    const updatedEscrow = await prisma.escrow.findUnique({
      where: { id: postgresEscrow.id },
    });

    // Only update escrow status if it hasn't been updated to 'refunded' by processRefund
    if (updatedEscrow && updatedEscrow.status !== 'refunded') {
      // Update Postgres escrow
      const balanceResult = await getEscrowBalance(postgresEscrow.id);
      const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');

      await prisma.escrow.update({
        where: { id: postgresEscrow.id },
        data: {
          status: 'cancelled',
          errorMessage: reason || 'Payment cancelled by user',
        },
      });

    // Create ledger entry for cancellation
    await createLedgerEntry({
      escrowId: postgresEscrow.id,
      type: 'escrow', // Escrow status change (cancellation)
      amount: new Prisma.Decimal('0.00'), // No money movement for cancellation
      balanceBefore: currentBalance,
      balanceAfter: currentBalance, // Balance unchanged (cancellation before capture)
      description: `Payment cancelled: ${reason || 'No reason provided'}`,
      metadata: {
        razorpayOrderId,
        razorpayPaymentId: postgresEscrow.razorpayPaymentId,
        reason,
        userId,
        refundRequired,
      },
    });
    } // Close the if block

    logger.info('✅ Payment cancellation processed', {
      razorpayOrderId,
      refundRequired,
      razorpayCancelled,
    });

    return {
      success: true,
      cancelled: true,
      refundRequired,
      refund: undefined, // Will be set if refund was processed
    };
  } catch (error: any) {
    logger.error('❌ Error cancelling payment:', error);
    return { success: false, error: error.message || 'Failed to cancel payment' };
  }
}

/**
 * Cancel escrow by escrow ID
 * 
 * @param escrowId - Escrow ID
 * @param reason - Cancellation reason (optional)
 * @param userId - User ID who is cancelling (for audit)
 * @returns Success status
 */
export async function cancelEscrow(params: {
  escrowId: string;
  reason?: string;
  userId?: string;
}): Promise<{ success: boolean; cancelled?: boolean; refundRequired?: boolean; error?: string }> {
  try {
    const { escrowId, reason, userId } = params;

    // Get escrow from Postgres
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    // Cancel using order ID
    return await cancelPayment({
      razorpayOrderId: postgresEscrow.razorpayOrderId,
      reason,
      userId,
    });
  } catch (error: any) {
    logger.error('❌ Error cancelling escrow:', error);
    return { success: false, error: error.message || 'Failed to cancel escrow' };
  }
}

/**
 * Cancel escrow by task ID
 * 
 * @param taskId - Task ID
 * @param reason - Cancellation reason (optional)
 * @param userId - User ID who is cancelling (for audit)
 * @returns Success status
 */
export async function cancelEscrowByTaskId(params: {
  taskId: string;
  reason?: string;
  userId?: string;
}): Promise<{ success: boolean; cancelled?: boolean; refundRequired?: boolean; error?: string }> {
  try {
    const { taskId, reason, userId } = params;

    // Get escrow from Postgres
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found for task' };
    }

    // Cancel using order ID
    return await cancelPayment({
      razorpayOrderId: postgresEscrow.razorpayOrderId,
      reason,
      userId,
    });
  } catch (error: any) {
    logger.error('❌ Error cancelling escrow by task ID:', error);
    return { success: false, error: error.message || 'Failed to cancel escrow' };
  }
}

