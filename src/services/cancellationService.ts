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
import type { CancellationSettlementPaise } from './refundService';
import { createPerformerCancellationPenalty } from './performerPenaltyService';
import { flagRefundReconciliation, isRecurringVisitEscrow } from './recurringVisitRefundSync';
import { taskHoldsRecurringVisitEscrows } from './recurringVisitPayoutScope';

export type CancellationResult = {
  success: boolean;
  cancelled?: boolean;
  refundRequired?: boolean;
  /** The refund failed: the payment is still held and the escrow was not cancelled. */
  refundPending?: boolean;
  refund?: any;
  error?: string;
};

/** Refund outcomes after which the booking may still be cancelled (nothing is owed back). */
const CANCEL_WITHOUT_REFUND_ERRORS = [
  /no capturable balance/i,
  /refund after cancellation fees is zero/i,
  /already refunded/i,
];

function holdsCapturedPayment(escrow: { status?: unknown; paymentStatus?: unknown }): boolean {
  const status = String(escrow.status || '').toLowerCase();
  const paymentStatus = String(escrow.paymentStatus || '').toLowerCase();
  return status === 'held' || paymentStatus === 'captured';
}

const RECURRING_TASK_CANCEL_ERROR =
  'Recurring visit cancellations must identify the exact visit payment (escrowId or razorpayOrderId)';

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
  assignedAt?: Date;
  /** Task budget (rupees) for %-fee base; aligns refund with pre-cancel UI */
  feeBaseAmount?: number;
  taskTitle?: string;
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  /** Book Now / Hourly: false => full refund (no cancellation fee). */
  partnerAssigned?: boolean;
  /** Hourly Helper: execute settlement from task-service (no fee recalculation). */
  precomputedSettlement?: CancellationSettlementPaise;
}): Promise<CancellationResult> {
  try {
    const {
      razorpayOrderId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    } = params;
    const cancelledAtTs = new Date();

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

    // Attempt refund whenever a Razorpay payment exists.
    // Capture/status flags can be stale; refund service validates capturable amount safely.
    const canAttemptRefund = Boolean(postgresEscrow.razorpayPaymentId);

    let razorpayCancelled = false;
    let refundRequired = false;
    let refundFailure: string | null = null;

    // If a payment exists, try refund automatically
    if (canAttemptRefund && postgresEscrow.razorpayPaymentId) {
      logger.info('💰 Payment exists - attempting refund automatically', {
        razorpayOrderId,
        razorpayPaymentId: postgresEscrow.razorpayPaymentId,
        paymentStatus: postgresEscrow.paymentStatus,
        escrowStatus: postgresEscrow.status,
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
          cancelledAt: cancelledAtTs,
          userId: userId,
          assignedAt,
          feeBaseAmount,
          catalogId,
          partnerReachedLocation,
          partnerAssigned,
          precomputedSettlement,
        });

        if (refundResult.success) {
          logger.info('✅ Refund processed automatically after cancellation', {
            razorpayOrderId,
            refundId: refundResult.refund?.refundId,
          });
          // Hourly settlement already includes worker compensation — do not add marketplace performer penalty.
          if (refundCancelledBy === 'performer' && !precomputedSettlement) {
            const latest = await prisma.escrow.findUnique({ where: { id: postgresEscrow.id } });
            if (latest?.status === 'refunded') {
              const feeBase =
                feeBaseAmount != null && Number.isFinite(feeBaseAmount)
                  ? feeBaseAmount
                  : parseFloat(latest.amountInRupees.toString());
              logger.info('[cancellationService] Creating performer penalty after tasker refund', {
                performerUid: latest.performerUid,
                taskId: latest.taskId,
                feeBaseAmount: feeBase,
                cancelledBy: refundCancelledBy,
              });
              const penaltyResult = latest.performerUid
                ? await createPerformerCancellationPenalty({
                    performerUid: latest.performerUid,
                    taskId: latest.taskId,
                    escrowId: latest.id,
                    taskStartDate: refundTaskStartDate,
                    cancelledAt: cancelledAtTs,
                    feeBaseAmount: feeBase,
                    reason,
                    taskTitle,
                  })
                : { success: false as const };
              if (penaltyResult.success) {
                logger.info('[cancellationService] Performer penalty created successfully', {
                  performerUid: latest.performerUid,
                  taskId: latest.taskId,
                  penaltyId: penaltyResult.penalty?.penaltyId,
                  amount: penaltyResult.penalty?.amount,
                  skipped: penaltyResult.skipped,
                });
              } else {
                logger.error('[cancellationService] Failed to create performer penalty', {
                  performerUid: latest.performerUid,
                  taskId: latest.taskId,
                  error: penaltyResult.error,
                });
              }
            } else {
              logger.warn('[cancellationService] Not creating penalty - escrow not in refunded state', {
                escrowId: postgresEscrow.id,
                status: latest?.status,
              });
            }
          } else {
            logger.debug('[cancellationService] Not performer cancellation, skipping penalty creation', {
              cancelledBy: refundCancelledBy,
            });
          }
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
          if ((refundResult.error || '').toLowerCase().includes('no capturable balance')) {
            refundRequired = false;
          } else if (!CANCEL_WITHOUT_REFUND_ERRORS.some((pattern) => pattern.test(refundResult.error || ''))) {
            refundFailure = refundResult.error || 'Refund failed';
          }
        }
      } catch (refundError: any) {
        logger.error('❌ Error processing refund automatically', {
          razorpayOrderId,
          error: refundError.message,
        });
        refundFailure = refundError?.message || 'Refund failed';
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

    // A captured payment whose refund failed stays held (recoverable): marking it cancelled would
    // record a cancellation while the customer's money was never returned.
    if (refundFailure && updatedEscrow && updatedEscrow.status !== 'refunded' && holdsCapturedPayment(updatedEscrow)) {
      await flagRefundReconciliation(updatedEscrow, 'cancel_refund_failed', {
        razorpayOrderId,
        error: refundFailure,
        cancelledBy: cancelledBy || 'poster',
        userId: userId || null,
      });
      return {
        success: false,
        refundRequired: true,
        refundPending: true,
        error: `Refund could not be processed, so the payment was not cancelled: ${refundFailure}`,
      };
    }

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

    if ((cancelledBy || '') === 'performer') {
      const latest = await prisma.escrow.findUnique({ where: { id: postgresEscrow.id } });
      if (latest && (latest.status === 'refunded' || latest.status === 'cancelled')) {
        const feeBase =
          feeBaseAmount != null && Number.isFinite(feeBaseAmount)
            ? feeBaseAmount
            : parseFloat(latest.amountInRupees.toString());
        const tStart = taskStartDate || latest.createdAt;
        logger.info('[cancellationService] Creating performer penalty after tasker cancellation', {
          performerUid: latest.performerUid,
          taskId: latest.taskId,
          escrowStatus: latest.status,
          feeBaseAmount: feeBase,
          cancelledBy,
        });
        const penaltyResult = latest.performerUid
          ? await createPerformerCancellationPenalty({
              performerUid: latest.performerUid,
              taskId: latest.taskId,
              escrowId: latest.id,
              taskStartDate: tStart,
              cancelledAt: cancelledAtTs,
              feeBaseAmount: feeBase,
              reason,
              taskTitle,
            })
          : { success: false as const };
        if (penaltyResult.success) {
          logger.info('[cancellationService] Performer penalty created successfully', {
            performerUid: latest.performerUid,
            taskId: latest.taskId,
            penaltyId: penaltyResult.penalty?.penaltyId,
            amount: penaltyResult.penalty?.amount,
            skipped: penaltyResult.skipped,
          });
        } else {
          logger.error('[cancellationService] Failed to create performer penalty', {
            performerUid: latest.performerUid,
            taskId: latest.taskId,
            error: penaltyResult.error,
          });
        }
      } else {
        logger.debug('[cancellationService] Escrow not found or not in refunded/cancelled state for penalty', {
          escrowId: postgresEscrow.id,
          escrowExists: !!latest,
          status: latest?.status,
        });
      }
    } else {
      logger.debug('[cancellationService] Not performer cancellation, skipping penalty creation', {
        cancelledBy,
      });
    }

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
  cancelledBy?: 'poster' | 'performer';
  taskStartDate?: Date;
  assignedAt?: Date;
  feeBaseAmount?: number;
  taskTitle?: string;
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  partnerAssigned?: boolean;
  precomputedSettlement?: CancellationSettlementPaise;
}): Promise<CancellationResult> {
  try {
    const {
      escrowId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    } = params;

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
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    });
  } catch (error: any) {
    logger.error('❌ Error cancelling escrow:', error);
    return { success: false, error: error.message || 'Failed to cancel escrow' };
  }
}

/**
 * Cancel Book Now escrow by booking order id (line task ids may differ from escrow.taskId).
 */
export async function cancelEscrowByBookingOrderId(params: {
  bookingOrderId: string;
  reason?: string;
  userId?: string;
  cancelledBy?: 'poster' | 'performer';
  taskStartDate?: Date;
  assignedAt?: Date;
  feeBaseAmount?: number;
  taskTitle?: string;
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  partnerAssigned?: boolean;
  precomputedSettlement?: CancellationSettlementPaise;
}): Promise<CancellationResult> {
  try {
    const {
      bookingOrderId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    } = params;

    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const { findEscrowByBookingOrderId } = await import('./escrowService');
    const postgresEscrow = await findEscrowByBookingOrderId(bookingOrderId);
    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found for booking' };
    }

    return await cancelPayment({
      razorpayOrderId: postgresEscrow.razorpayOrderId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    });
  } catch (error: any) {
    logger.error('❌ Error cancelling escrow by booking order ID:', error);
    return { success: false, error: error.message || 'Failed to cancel escrow' };
  }
}

/**
 * Escrow for a task-id cancel. A recurring plan holds one payment per visit, so a task id alone
 * (whose newest payment may belong to another visit) never selects a recurring visit payment.
 */
async function resolveEscrowForTaskCancellation(
  taskId: string,
): Promise<{ escrow: any } | { error: string; notFound?: boolean }> {
  const trimmed = String(taskId || '').trim();
  if (trimmed && (await taskHoldsRecurringVisitEscrows(trimmed))) {
    logger.error('Cancel by task id refused for a recurring visit plan', { taskId: trimmed });
    return { error: RECURRING_TASK_CANCEL_ERROR };
  }
  const { resolveEscrowRecordForTaskId } = await import('./escrowService');
  const escrow = await resolveEscrowRecordForTaskId(trimmed);
  if (!escrow) return { error: 'Escrow not found for task', notFound: true };
  if (isRecurringVisitEscrow(escrow)) {
    logger.error('Cancel by task id resolved a recurring visit payment; refused', {
      taskId: trimmed,
      escrowId: escrow.escrowId,
    });
    return { error: RECURRING_TASK_CANCEL_ERROR };
  }
  return { escrow };
}

/**
 * The exact escrow a relayed user cancel refers to (same precedence as the cancel endpoint).
 */
export async function resolveEscrowForCancellation(ids: {
  razorpayOrderId?: unknown;
  bookingOrderId?: unknown;
  escrowId?: unknown;
  taskId?: unknown;
}): Promise<{ escrow: any } | { error: string; notFound?: boolean }> {
  const value = (v: unknown) => (v == null ? '' : String(v).trim());
  const orderId = value(ids.razorpayOrderId);
  const bookingOrderId = value(ids.bookingOrderId);
  const escrowId = value(ids.escrowId);
  const taskId = value(ids.taskId);
  if (!isPostgresConnected()) return { error: 'Postgres not connected' };

  let escrow: any = null;
  if (orderId) {
    escrow = await prisma.escrow.findUnique({ where: { razorpayOrderId: orderId } });
  } else if (bookingOrderId) {
    const { findEscrowByBookingOrderId } = await import('./escrowService');
    escrow = await findEscrowByBookingOrderId(bookingOrderId);
  } else if (escrowId) {
    escrow = await prisma.escrow.findUnique({ where: { escrowId } });
  } else if (taskId) {
    const resolved = await resolveEscrowForTaskCancellation(taskId);
    if ('error' in resolved) return resolved;
    escrow = resolved.escrow;
  } else {
    return { error: 'Either razorpayOrderId, escrowId, bookingOrderId, or taskId is required' };
  }
  if (!escrow) return { error: 'Escrow not found', notFound: true };
  return { escrow };
}

/**
 * Cancel escrow by task ID
 *
 * Book Now escrows are often stored under `booknow-pending-{bookingOrderId}` while
 * cancel callers pass the materialized Mongo task id — resolve via line metadata and
 * pending-id prefix before failing.
 */
export async function cancelEscrowByTaskId(params: {
  taskId: string;
  reason?: string;
  userId?: string;
  cancelledBy?: 'poster' | 'performer';
  taskStartDate?: Date;
  assignedAt?: Date;
  feeBaseAmount?: number;
  taskTitle?: string;
  catalogId?: string | null;
  partnerReachedLocation?: boolean;
  partnerAssigned?: boolean;
  precomputedSettlement?: CancellationSettlementPaise;
}): Promise<CancellationResult> {
  try {
    const {
      taskId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    } = params;

    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const resolved = await resolveEscrowForTaskCancellation(taskId);
    if ('error' in resolved) {
      return { success: false, error: resolved.error };
    }
    const postgresEscrow = resolved.escrow;

    return await cancelPayment({
      razorpayOrderId: postgresEscrow.razorpayOrderId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
      partnerAssigned,
      precomputedSettlement,
    });
  } catch (error: any) {
    logger.error('❌ Error cancelling escrow by task ID:', error);
    return { success: false, error: error.message || 'Failed to cancel escrow' };
  }
}

