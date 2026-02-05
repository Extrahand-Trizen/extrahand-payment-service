import { razorpay } from '../config/razorpay';
import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
// PaymentTransaction model removed - using Postgres Ledger instead
import { createOrder } from './paymentService';
import { sanitizeRazorpayOrderData, sanitizeRazorpayData, sanitizeRazorpayPaymentData } from '../utils/paymentSanitizer';
import { prisma } from '../config/prisma';
import { createLedgerEntry, getEscrowBalance } from './ledgerService';
import { Prisma } from '@prisma/client';
import { EmailServiceClient } from '../clients/EmailServiceClient';

/**
 * Generate unique escrow ID
 */
function generateEscrowId(): string {
  return `escrow_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Calculate auto-release days from auto-release date and creation date
 */
function calculateAutoReleaseDays(autoReleaseDate: Date | null, createdAt: Date): number | null {
  if (!autoReleaseDate) return null;
  const millisecondsPerDay = 1000 * 60 * 60 * 24;
  const daysDifference = Math.ceil(
    (autoReleaseDate.getTime() - createdAt.getTime()) / millisecondsPerDay
  );
  return daysDifference > 0 ? daysDifference : null;
}

/**
 * Convert Postgres escrow to format expected by frontend (backward compatibility)
 * Computes derived fields: autoReleaseEnabled, autoReleaseAfterDays
 * Queries related tables for: releaseTransactionId, refundTransactionId, refundReason
 */
async function convertPostgresEscrowToFrontendFormat(postgresEscrow: any): Promise<any> {
  if (!postgresEscrow) return null;

  // Compute derived fields
  const isAutoReleaseEnabled = postgresEscrow.autoReleaseDate !== null;
  const autoReleaseDays = calculateAutoReleaseDays(
    postgresEscrow.autoReleaseDate,
    postgresEscrow.createdAt
  );

  // Query related tables for transaction IDs and refund reason
  let releaseTransactionId: string | null = null;
  let refundTransactionId: string | null = null;
  let refundReason: string | null = null;

  try {
    // Get release transaction ID from Payout table
    if (postgresEscrow.status === 'released') {
      const completedPayout = await prisma.payout.findFirst({
        where: {
          escrowId: postgresEscrow.id,
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
        select: { payoutId: true },
      });
      releaseTransactionId = completedPayout?.payoutId || null;
    }

    // Get refund transaction ID and reason from Refund table
    if (postgresEscrow.status === 'refunded') {
      const completedRefund = await prisma.refund.findFirst({
        where: {
          escrowId: postgresEscrow.id,
          status: 'completed',
        },
        orderBy: { createdAt: 'desc' },
        select: { refundId: true, reason: true },
      });
      refundTransactionId = completedRefund?.refundId || null;
      refundReason = completedRefund?.reason || null;
    }
  } catch (error: any) {
    // Log but don't fail - these are optional fields
    logger.warn('Error querying related tables for escrow conversion:', {
      escrowId: postgresEscrow.escrowId,
      error: error.message,
    });
  }

  return {
    _id: postgresEscrow.id, // For backward compatibility
    id: postgresEscrow.id,
    escrowId: postgresEscrow.escrowId,
    razorpayOrderId: postgresEscrow.razorpayOrderId,
    taskId: postgresEscrow.taskId,
    applicationId: postgresEscrow.applicationId,
    posterUid: postgresEscrow.posterUid,
    performerUid: postgresEscrow.performerUid,
    amount: postgresEscrow.amount.toString(),
    amountInRupees: postgresEscrow.amountInRupees.toString(),
    currency: postgresEscrow.currency,
    status: postgresEscrow.status,
    razorpayPaymentId: postgresEscrow.razorpayPaymentId,
    paymentStatus: postgresEscrow.paymentStatus,
    autoReleaseEnabled: isAutoReleaseEnabled,
    autoReleaseAfterDays: autoReleaseDays,
    autoReleaseDate: postgresEscrow.autoReleaseDate,
    heldAt: postgresEscrow.heldAt,
    releasedAt: postgresEscrow.releasedAt,
    releaseTransactionId,
    refundedAt: postgresEscrow.refundedAt,
    refundTransactionId,
    refundReason,
    errorMessage: postgresEscrow.errorMessage,
    errorCode: postgresEscrow.errorCode,
    razorpayOrderData: postgresEscrow.razorpayOrderData || null,
    razorpayPaymentData: postgresEscrow.razorpayPaymentData || null,
    metadata: postgresEscrow.metadata || null,
    createdAt: postgresEscrow.createdAt,
    updatedAt: postgresEscrow.updatedAt,
  };
}

/**
 * Create escrow - Hold funds when offer is accepted
 * Now uses Postgres only (migrated from hybrid MongoDB + Postgres)
 */
export async function createEscrow(params: {
  taskId: string;
  applicationId?: string;
  posterUid: string;
  performerUid: string;
  amount: number; // Amount in rupees
  currency?: string;
  autoReleaseAfterDays?: number;
  metadata?: Record<string, any>;
}): Promise<{ success: boolean; escrow?: any; order?: any; error?: string }> {
  try {
    const {
      taskId,
      applicationId,
      posterUid,
      performerUid,
      amount,
      currency = 'INR',
      autoReleaseAfterDays,
      metadata = {},
    } = params;

    // Validate amount
    if (!amount || amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    // Convert to paise for Razorpay
    const amountInPaise = Math.round(amount * 100);

    // Create Razorpay order
    const orderResult = await createOrder(amountInPaise, currency, {
      taskId,
      applicationId,
      posterUid,
      performerUid,
      type: 'escrow',
      ...metadata,
    });

    if (!orderResult.success || !orderResult.order) {
      return { success: false, error: orderResult.error || 'Failed to create Razorpay order' };
    }

    const razorpayOrder = orderResult.order;

    // If Postgres is not connected, return order without saving
    if (!isPostgresConnected()) {
      logger.warn('⚠️ Postgres not connected - Escrow created but not saved');
      return {
        success: true,
        order: razorpayOrder,
      };
    }

    // Calculate auto-release date if enabled
    let autoReleaseDate: Date | null = null;
    if (autoReleaseAfterDays && autoReleaseAfterDays > 0) {
      autoReleaseDate = new Date();
      autoReleaseDate.setDate(autoReleaseDate.getDate() + autoReleaseAfterDays);
    }

    // Sanitize Razorpay order data before storing (remove sensitive information)
    const sanitizedOrderData = sanitizeRazorpayOrderData(razorpayOrder);

    // Create escrow record
    const escrowId = generateEscrowId();

    // Convert amounts to Prisma Decimal
    const amountDecimal = new Prisma.Decimal(amountInPaise.toString());
    const amountInRupeesDecimal = new Prisma.Decimal(amount.toFixed(2));

    try {
      // Create escrow in Postgres (all data - financial + metadata)
      const postgresEscrow = await prisma.escrow.create({
        data: {
          escrowId,
          razorpayOrderId: razorpayOrder.id,
          taskId,
          applicationId: applicationId || null,
          posterUid,
          performerUid,
          amount: amountDecimal,
          currency,
          amountInRupees: amountInRupeesDecimal,
          status: 'pending',
          autoReleaseDate: autoReleaseDate,
          razorpayOrderData: sanitizedOrderData as any, // Store sanitized data in JSONB
          metadata: metadata as any, // Store metadata in JSONB
        },
      });

      // Create initial ledger entry (escrow created)
      await createLedgerEntry({
        escrowId: postgresEscrow.id,
        type: 'escrow',
        amount: amountInRupeesDecimal,
        balanceBefore: new Prisma.Decimal('0.00'),
        balanceAfter: amountInRupeesDecimal,
        description: `Escrow created for task ${taskId}`,
        metadata: {
          escrowId,
          razorpayOrderId: razorpayOrder.id,
          taskId,
        },
      });

      logger.info('✅ Escrow created (Postgres only)', {
        escrowId,
        taskId,
        razorpayOrderId: razorpayOrder.id,
        amount,
      });

      // Convert to frontend format for backward compatibility
      const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(postgresEscrow);

      return {
        success: true,
        escrow: escrowForFrontend,
        order: razorpayOrder,
      };
    } catch (error: any) {
      logger.error('❌ Error creating escrow:', error);
      throw error;
    }
  } catch (error: any) {
    logger.error('❌ Error creating escrow:', error);
    return { success: false, error: error.message || 'Failed to create escrow' };
  }
}

/**
 * Update escrow status when payment is captured
 * Now uses Postgres only
 */
export async function updateEscrowOnPaymentCapture(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  paymentStatus: 'authorized' | 'captured' | 'failed',
  razorpayPaymentData?: any // Optional: Razorpay payment response
): Promise<{ success: boolean; escrow?: any; error?: string }> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    // Sanitize payment data if provided
    const sanitizedPaymentData = razorpayPaymentData 
      ? sanitizeRazorpayPaymentData(razorpayPaymentData)
      : null;

    const updateData: any = {
      razorpayPaymentId,
      paymentStatus,
    };

    // Store sanitized payment data in JSONB
    if (sanitizedPaymentData) {
      updateData.razorpayPaymentData = sanitizedPaymentData as any;
    }

    if (paymentStatus === 'captured') {
      updateData.status = 'held';
      updateData.heldAt = new Date();
      // DO NOT set auto-release date here - it will be set when completion is approved
      // Auto-release should only happen after task completion approval, not when payment is captured
    } else if (paymentStatus === 'failed') {
      updateData.status = 'cancelled';
      updateData.errorMessage = 'Payment failed';
    }

    const updatedEscrow = await prisma.escrow.update({
      where: { id: postgresEscrow.id },
      data: updateData,
    });

    // Create ledger entry for payment capture
    if (paymentStatus === 'captured') {
      // Get current balance (using Postgres escrow ID)
      const balanceResult = await getEscrowBalance(postgresEscrow.id);
      const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');

      // Create ledger entry for payment capture
      await createLedgerEntry({
        escrowId: postgresEscrow.id,
        type: 'payment',
        amount: updatedEscrow.amountInRupees,
        balanceBefore: currentBalance,
        balanceAfter: updatedEscrow.amountInRupees, // Balance after payment capture
        description: `Payment captured for escrow ${postgresEscrow.escrowId}`,
        metadata: {
          razorpayPaymentId,
          razorpayOrderId,
          escrowId: postgresEscrow.escrowId,
        },
      });

      // Update UserPaymentProfile cache for poster (payment made)
      const { updateUserPaymentProfile } = await import('./userPaymentProfileService');
      updateUserPaymentProfile(postgresEscrow.posterUid, {
        type: 'payment',
        amount: updatedEscrow.amountInRupees,
        escrowId: postgresEscrow.id,
      }).catch((error) => {
        logger.warn('Failed to update UserPaymentProfile for payment (non-critical):', error);
      });

      // Send payment received email to poster (non-blocking)
      // Note: Email requires user lookup from user-service which is async
      logger.info('Email trigger: payment_received', {
        posterUid: postgresEscrow.posterUid,
        amount: updatedEscrow.amountInRupees.toString(),
        taskId: postgresEscrow.taskId,
        escrowId: postgresEscrow.escrowId,
      });
    }

    logger.info('✅ Escrow updated on payment capture (Postgres only)', {
      escrowId: postgresEscrow.escrowId,
      razorpayOrderId,
      paymentStatus,
    });

    // Convert to frontend format
    const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(updatedEscrow);

    return { success: true, escrow: escrowForFrontend };
  } catch (error: any) {
    logger.error('❌ Error updating escrow on payment capture:', error);
    return { success: false, error: error.message || 'Failed to update escrow' };
  }
}

/**
 * Get escrow by ID
 * Now uses Postgres only
 */
export async function getEscrowById(escrowId: string): Promise<any | null> {
  try {
    if (!isPostgresConnected()) {
      return null;
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });

    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow:', error);
    return null;
  }
}

/**
 * Get escrow by Razorpay order ID
 * Now uses Postgres only
 */
export async function getEscrowByOrderId(razorpayOrderId: string): Promise<any | null> {
  try {
    if (!isPostgresConnected()) {
      return null;
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by order ID:', error);
    return null;
  }
}

/**
 * Get escrow by task ID
 * Now uses Postgres only
 */
export async function getEscrowByTaskId(taskId: string): Promise<any | null> {
  try {
    if (!isPostgresConnected()) {
      return null;
    }

    const postgresEscrow = await prisma.escrow.findFirst({
      where: {
        taskId,
        status: {
          in: ['pending', 'held'],
        },
      },
      orderBy: {
        createdAt: 'desc', // Get most recent escrow for the task
      },
    });

    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by task ID:', error);
    return null;
  }
}

/**
 * Get escrow status
 * Now uses Postgres only
 */
export async function getEscrowStatus(escrowId: string): Promise<{
  success: boolean;
  escrow?: any;
  error?: string;
}> {
  try {
    const escrow = await getEscrowById(escrowId);

    if (!escrow) {
      return { success: false, error: 'Escrow not found' };
    }

    return { success: true, escrow };
  } catch (error: any) {
    logger.error('❌ Error getting escrow status:', error);
    return { success: false, error: error.message || 'Failed to get escrow status' };
  }
}

/**
 * Generate unique transaction ID
 */
function generateTransactionId(): string {
  return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Release escrow funds to performer
 * This releases the held funds to the performer's account
 * Now uses Postgres only
 */
export async function releaseEscrow(
  escrowId: string,
  releasedBy: string, // UID of user releasing (should be poster)
  metadata?: Record<string, any>
): Promise<{ success: boolean; escrow?: any; transaction?: any; error?: string }> {
  try {
    if (!isPostgresConnected()) {
      logger.warn('⚠️ Postgres not connected - Cannot release escrow');
      return { success: false, error: 'Postgres not connected' };
    }

    // Find escrow in Postgres
    const postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    // Validate escrow can be released
    if (postgresEscrow.status !== 'held') {
      return { 
        success: false, 
        error: `Escrow cannot be released. Current status: ${postgresEscrow.status}. Only 'held' escrows can be released.` 
      };
    }

    // Verify the person releasing is the poster
    if (postgresEscrow.posterUid !== releasedBy) {
      return { 
        success: false, 
        error: 'Only the task poster can release escrow funds' 
      };
    }

    // Verify payment was captured
    if (!postgresEscrow.razorpayPaymentId || postgresEscrow.paymentStatus !== 'captured') {
      return { 
        success: false, 
        error: 'Payment not captured. Cannot release escrow until payment is captured.' 
      };
    }

    // Generate transaction ID
    const transactionId = generateTransactionId();

    // Create payment transaction record for release (in MongoDB for now - can migrate later)
    let releaseTransaction = null;
    if (isPostgresConnected()) {
      // For now, we'll skip PaymentTransaction model (MongoDB) and rely on Postgres ledger
      // In future, we can create a PaymentTransaction table in Postgres if needed
      releaseTransaction = {
        transactionId,
        type: 'release',
        status: 'completed',
        createdAt: new Date(),
      };
    }

    // Update escrow status in Postgres
    const updatedEscrow = await prisma.escrow.update({
      where: { id: postgresEscrow.id },
      data: {
        status: 'released',
        releasedAt: new Date(),
      },
    });

    logger.info('✅ Escrow released (Postgres only)', {
      escrowId: postgresEscrow.escrowId,
      transactionId,
      taskId: postgresEscrow.taskId,
      amount: postgresEscrow.amountInRupees.toString(),
      performerUid: postgresEscrow.performerUid,
    });

    // Send email notification to performer (non-blocking)
    // TODO: Fetch performer email from user-service
    // For now, log the intent and the email can be triggered once profile lookup is implemented
    logger.info('Email trigger: escrow_released', {
      performerUid: postgresEscrow.performerUid,
      amount: postgresEscrow.amountInRupees.toString(),
      taskId: postgresEscrow.taskId,
    });

    // Convert to frontend format
    const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(updatedEscrow);

    return {
      success: true,
      escrow: escrowForFrontend,
      transaction: releaseTransaction,
    };
  } catch (error: any) {
    logger.error('❌ Error releasing escrow:', error);
    return { success: false, error: error.message || 'Failed to release escrow' };
  }
}

/**
 * Update escrow auto-release date (for revisions)
 * Now uses Postgres only
 * 
 * @param razorpayOrderId - Razorpay order ID
 * @param autoReleaseDate - New auto-release date (or null to cancel auto-release)
 * @returns Success status
 */
export async function updateEscrowAutoRelease(
  razorpayOrderId: string,
  autoReleaseDate: Date | null
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    await prisma.escrow.update({
      where: { razorpayOrderId },
      data: {
        autoReleaseDate,
      },
    });

    logger.info('✅ Escrow auto-release date updated (Postgres only)', {
      razorpayOrderId,
      autoReleaseDate: autoReleaseDate?.toISOString() || 'cancelled',
    });

    return { success: true };
  } catch (error: any) {
    logger.error('❌ Error updating escrow auto-release:', error);
    return { success: false, error: error.message || 'Failed to update escrow auto-release' };
  }
}
