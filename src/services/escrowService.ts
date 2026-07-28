import { razorpay } from '../config/razorpay';
import logger from '../config/logger';
import { resolveEscrowTaskAmountForPayout } from '../utils/escrowFinanceUtils';
import { ensurePostgresReady, isPostgresConnected } from '../config/database';
import { REVIEW_ORDER_ID_PREFIX } from '../utils/reviewBypass';
// PaymentTransaction model removed - using Postgres Ledger instead
import { createOrder, getOrderDetails } from './paymentService';
import { sanitizeRazorpayOrderData, sanitizeRazorpayData, sanitizeRazorpayPaymentData } from '../utils/paymentSanitizer';
import { prisma, prismaDev } from '../config/prisma';
import { CategoryFeeMode, Prisma } from '@prisma/client';
import {
  getFeeStructureForCategory,
  pickCategoryFeeConfigKey,
  resolveBiddingPayoutFeePercents,
  resolveEscrowCategoryFeeConfigKey,
} from './feeConfigService';
import { createLedgerEntry, getEscrowBalance } from './ledgerService';
import { EmailServiceClient } from '../clients/EmailServiceClient';
import { fireWhatsAppNotify } from '../clients/WhatsAppClient';
import {
  notifyPaymentReceived,
  notifyPayoutCompleted,
} from './paymentNotificationService';
import { logEscrowCreated, logPaymentCaptured, logPaymentFailed } from './auditLogService';
import mongoose from 'mongoose';
import { buildEscrowMetadataSnapshot, getTaskDisplayTitleFromEscrow } from '../utils/escrowMetadataSnapshot';
import { applyExtraCoinsForBooking, previewExtraCoinsRedemption } from './extraCoinsService';
import { paymentRewardsFlags } from '../config/rewardsFlags';
import { CoinUsageConfigProvider } from '../rewards/config/CoinUsageConfigProvider';

/**
 * Generate unique escrow ID
 */
function generateEscrowId(): string {
  return `escrow_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** Book Now order id — column when migrated, else metadata from createEscrow. */
export function resolveEscrowBookingOrderId(escrow: {
  bookingOrderId?: string | null;
  metadata?: unknown;
}): string | null {
  const column = escrow.bookingOrderId?.trim();
  if (column) return column;

  if (!escrow.metadata || typeof escrow.metadata !== 'object' || Array.isArray(escrow.metadata)) {
    return null;
  }
  const fromMeta = (escrow.metadata as Record<string, unknown>).bookingOrderId;
  return typeof fromMeta === 'string' && fromMeta.trim() ? fromMeta.trim() : null;
}

export async function findEscrowByBookingOrderId(bookingOrderId: string) {
  const id = bookingOrderId?.trim();
  if (!id) return null;

  let byColumn = await prisma.escrow.findFirst({
    where: { bookingOrderId: id },
    orderBy: { createdAt: 'desc' },
  });
  
  if (!byColumn && prismaDev) {
    byColumn = await prismaDev.escrow.findFirst({
      where: { bookingOrderId: id },
      orderBy: { createdAt: 'desc' },
    });
  }
  
  if (byColumn) return byColumn;

  let byMetadata = await prisma.escrow.findFirst({
    where: {
      metadata: {
        path: ['bookingOrderId'],
        equals: id,
      },
    },
    orderBy: { createdAt: 'desc' },
  });
  
  if (!byMetadata && prismaDev) {
    byMetadata = await prismaDev.escrow.findFirst({
      where: {
        metadata: {
          path: ['bookingOrderId'],
          equals: id,
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
  
  return byMetadata;
}

export function isBookNowEscrowRecord(escrow: {
  bookingOrderId?: string | null;
  metadata?: unknown;
}): boolean {
  if (resolveEscrowBookingOrderId(escrow)) return true;
  if (!escrow.metadata || typeof escrow.metadata !== 'object' || Array.isArray(escrow.metadata)) {
    return false;
  }
  return (escrow.metadata as Record<string, unknown>).bookingMode === 'book_now';
}

function generatePaymentTransactionId(): string {
  return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function readPendingCustomerCoinDiscountRupees(metadata: unknown): Prisma.Decimal {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return new Prisma.Decimal('0.00');
  }
  const record = metadata as Record<string, unknown>;
  const raw =
    record.pendingCustomerCoinDiscountRupees ??
    record.customerCoinDiscountRupees ??
    0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Prisma.Decimal('0.00');
  }
  return new Prisma.Decimal(parsed.toFixed(2));
}

async function redeemCustomerCoinsOnEscrowCapture(postgresEscrow: {
  escrowId: string;
  taskId: string;
  posterUid: string;
  metadata: unknown;
}): Promise<void> {
  const escrowMetadata = postgresEscrow.metadata;
  const pendingRupees = readPendingCustomerCoinDiscountRupees(escrowMetadata);
  if (pendingRupees.lessThanOrEqualTo(0)) {
    return;
  }

  try {
    const redeem = await applyExtraCoinsForBooking({
      userId: postgresEscrow.posterUid,
      bookingId: postgresEscrow.escrowId,
      taskId: postgresEscrow.taskId,
      maxRedeemRupees: pendingRupees,
    });

    if (!redeem.success) {
      logger.error('[escrowService] customer coin redeem failed after payment capture', {
        escrowId: postgresEscrow.escrowId,
        taskId: postgresEscrow.taskId,
        posterUid: postgresEscrow.posterUid,
        pendingRupees: pendingRupees.toString(),
        error: redeem.error,
      });
      return;
    }

    logger.info('[escrowService] customer coins redeemed after payment capture', {
      escrowId: postgresEscrow.escrowId,
      taskId: postgresEscrow.taskId,
      posterUid: postgresEscrow.posterUid,
      redeemedRupees: redeem.redeemedRupees,
      redeemedCoins: redeem.redeemedCoins,
      duplicate: redeem.duplicate === true,
    });
  } catch (coinError: any) {
    logger.error('[escrowService] customer coin redeem threw after payment capture', {
      escrowId: postgresEscrow.escrowId,
      taskId: postgresEscrow.taskId,
      posterUid: postgresEscrow.posterUid,
      pendingRupees: pendingRupees.toString(),
      error: coinError?.message || 'Unknown error',
    });
  }
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

  const payoutTaskAmount = resolveEscrowTaskAmountForPayout(postgresEscrow);
  const escrowMeta =
    postgresEscrow.metadata &&
    typeof postgresEscrow.metadata === 'object' &&
    !Array.isArray(postgresEscrow.metadata)
      ? (postgresEscrow.metadata as Record<string, unknown>)
      : {};
  const taskTitle =
    typeof escrowMeta.taskTitle === 'string' && escrowMeta.taskTitle.trim()
      ? escrowMeta.taskTitle.trim()
      : undefined;

  let appliedPlatformFeePercent = postgresEscrow.appliedPlatformFeePercent?.toString() ?? null;
  let appliedGstPercent = postgresEscrow.appliedGstPercent?.toString() ?? null;

  if (!isBookNowEscrowRecord(postgresEscrow)) {
    try {
      const resolved = await resolveBiddingPayoutFeePercents({
        taskCategory: postgresEscrow.taskCategory,
        categorySlug:
          typeof escrowMeta.categorySlug === 'string' ? escrowMeta.categorySlug : undefined,
        catalogId: typeof escrowMeta.catalogId === 'string' ? escrowMeta.catalogId : undefined,
        metadata: escrowMeta,
      });
      appliedPlatformFeePercent = String(resolved.platformFeePercentage);
      appliedGstPercent = String(resolved.gstPercentage);
    } catch (error: any) {
      logger.warn('Could not resolve live bidding payout fee percents for escrow', {
        escrowId: postgresEscrow.escrowId,
        error: error?.message,
      });
    }
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
    bookingOrderId: resolveEscrowBookingOrderId(postgresEscrow),
    amount: postgresEscrow.amount.toString(),
    amountInRupees: postgresEscrow.amountInRupees.toString(),
    taskAmount: payoutTaskAmount.toString(),
    appliedPlatformFeePercent,
    appliedGstPercent,
    taskTitle,
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
    taskCategory: postgresEscrow.taskCategory || null,
    appliedRazorpayGstPercent: postgresEscrow.appliedRazorpayGstPercent?.toString() ?? null,
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
  amount: number; // Amount in rupees (full amount including fees)
  taskAmount?: number; // Base task amount in rupees (excluding platform fee and GST)
  currency?: string;
  autoReleaseAfterDays?: number;
  taskCategory?: string;
  metadata?: Record<string, any>;
}): Promise<{ success: boolean; escrow?: any; order?: any; error?: string }> {
  try {
    const {
      taskId,
      applicationId,
      posterUid,
      performerUid,
      amount,
      taskAmount,
      currency = 'INR',
      autoReleaseAfterDays,
      taskCategory,
      metadata = {},
    } = params;

    // Validate amount
    if (!amount || amount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    if (!(await ensurePostgresReady())) {
      return {
        success: false,
        error: 'Payment database not ready. Please try again in a moment.',
      };
    }

    const escrowId = generateEscrowId();
    const coinCaps = await CoinUsageConfigProvider.getCapPercents();
    const posterCapPercent = paymentRewardsFlags.CUSTOMER_BOOKING_COIN_CAP_ENABLED
      ? coinCaps.posterBooking.toFixed(4)
      : '1.0000';
    const maxCustomerCoinDiscount = new Prisma.Decimal(amount.toFixed(2))
      .mul(new Prisma.Decimal(posterCapPercent))
      .toDecimalPlaces(2);
    const requestedCoinDiscountRaw = Number(metadata?.requestedCoinDiscountRupees || 0);
    const requestedCoinDiscount = Number.isFinite(requestedCoinDiscountRaw)
      ? new Prisma.Decimal(Math.max(requestedCoinDiscountRaw, 0).toFixed(2))
      : new Prisma.Decimal('0.00');

    // Reserve discount for Razorpay order only; wallet is debited after payment capture.
    let pendingCoinRupees = new Prisma.Decimal('0.00');
    let pendingCoinUnits = new Prisma.Decimal('0.00');
    if ((metadata?.useExtraCoins === true || requestedCoinDiscount.gt(0)) && maxCustomerCoinDiscount.gt(0)) {
      const cap = requestedCoinDiscount.gt(0)
        ? (requestedCoinDiscount.lessThan(maxCustomerCoinDiscount)
            ? requestedCoinDiscount
            : maxCustomerCoinDiscount
          ).toDecimalPlaces(2)
        : maxCustomerCoinDiscount;
      try {
        const preview = await previewExtraCoinsRedemption({
          userId: posterUid,
          maxRedeemRupees: cap,
          walletRole: 'poster',
        });
        pendingCoinRupees = new Prisma.Decimal(preview.redeemableRupees);
        pendingCoinUnits = new Prisma.Decimal(preview.redeemableCoins);
      } catch (coinError: any) {
        logger.warn('[escrowService] customer coin preview failed, continuing without discount', {
          taskId,
          posterUid,
          error: coinError?.message || 'Unknown error',
        });
      }
    }

    const finalChargeAmount = Prisma.Decimal.max(
      new Prisma.Decimal(amount.toFixed(2)).sub(pendingCoinRupees).toDecimalPlaces(2),
      new Prisma.Decimal('0.00')
    );

    // Convert to paise for Razorpay
    const amountInPaise = Math.round(Number(finalChargeAmount.toString()) * 100);

    // Create Razorpay order
    const orderResult = await createOrder(amountInPaise, currency, {
      taskId,
      applicationId,
      posterUid,
      performerUid,
      type: 'escrow',
      ...(taskCategory ? { taskCategory } : {}),
      ...metadata,
      pendingCustomerCoinDiscountRupees: pendingCoinRupees.toString(),
      customerCoinDiscountRupees: pendingCoinRupees.toString(),
      customerCoinDiscountCoins: pendingCoinUnits.toString(),
      customerCoinDiscountCapRupees: maxCustomerCoinDiscount.toString(),
      originalAmountRupees: Number(amount.toFixed(2)),
    });

    if (!orderResult.success || !orderResult.order) {
      return { success: false, error: orderResult.error || 'Failed to create Razorpay order' };
    }

    const razorpayOrder = orderResult.order;

    const escrowMetadata = buildEscrowMetadataSnapshot(
      {
        ...metadata,
        ...(taskAmount
          ? {
              visitBudgetRupees: Number(taskAmount.toFixed(2)),
              originalAmountRupees: Number(amount.toFixed(2)),
            }
          : {
              originalAmountRupees: Number(amount.toFixed(2)),
            }),
        pendingCustomerCoinDiscountRupees: pendingCoinRupees.toString(),
        customerCoinDiscountRupees: pendingCoinRupees.toString(),
        customerCoinDiscountCoins: pendingCoinUnits.toString(),
        customerCoinDiscountCapRupees: maxCustomerCoinDiscount.toString(),
        ...(String(razorpayOrder.id).startsWith(REVIEW_ORDER_ID_PREFIX)
          ? { reviewBypass: true }
          : {}),
      } as Record<string, unknown>,
      { taskCategory: taskCategory ?? null }
    );

    // Calculate auto-release date if enabled
    let autoReleaseDate: Date | null = null;
    if (autoReleaseAfterDays && autoReleaseAfterDays > 0) {
      autoReleaseDate = new Date();
      autoReleaseDate.setDate(autoReleaseDate.getDate() + autoReleaseAfterDays);
    }

    // Sanitize Razorpay order data before storing (remove sensitive information)
    const sanitizedOrderData = sanitizeRazorpayOrderData(razorpayOrder);

    // Create escrow record
    // Convert amounts to Prisma Decimal
    const amountDecimal = new Prisma.Decimal(amountInPaise.toString());
    const amountInRupeesDecimal = finalChargeAmount;
    const taskAmountDecimal = taskAmount 
      ? new Prisma.Decimal(taskAmount.toFixed(2))
      : null;

    try {
      const isBookNowEscrow = metadata?.bookingMode === 'book_now';
      const categoryFeeKey = resolveEscrowCategoryFeeConfigKey({
        taskCategory,
        categorySlug:
          typeof metadata.categorySlug === 'string' ? metadata.categorySlug : undefined,
        catalogId: typeof metadata.catalogId === 'string' ? metadata.catalogId : undefined,
        metadata,
      });

      // Resolve fee structure for this category and snapshot applied percentages
      const feeForCategory = await getFeeStructureForCategory(categoryFeeKey, {
        mode: isBookNowEscrow ? CategoryFeeMode.BOOK_NOW : CategoryFeeMode.BIDDING,
      });

      const appliedGstPercent = feeForCategory.platformFee.gstPercentage !== undefined
        ? new Prisma.Decimal(feeForCategory.platformFee.gstPercentage.toString())
        : undefined;

      const appliedPlatformFeePercent = feeForCategory.platformFee.percentage !== undefined
        ? new Prisma.Decimal(feeForCategory.platformFee.percentage.toString())
        : undefined;

      const appliedRazorpayGstPercent = feeForCategory.processingFees.razorpayFeeGstPercentage !== undefined
        ? new Prisma.Decimal(feeForCategory.processingFees.razorpayFeeGstPercentage.toString())
        : undefined;

      const bookingOrderIdColumn =
        typeof metadata.bookingOrderId === 'string' && metadata.bookingOrderId.trim()
          ? metadata.bookingOrderId.trim()
          : null;

      // Create escrow in Postgres (all data - financial + metadata)
      const postgresEscrow = await prisma.escrow.create({
        data: {
          escrowId,
          razorpayOrderId: razorpayOrder.id,
          taskId,
          applicationId: applicationId || null,
          posterUid,
          performerUid,
          bookingOrderId: bookingOrderIdColumn,
          amount: amountDecimal,
          currency,
          amountInRupees: amountInRupeesDecimal,
          taskAmount: taskAmountDecimal,
          status: 'pending',
          autoReleaseDate: autoReleaseDate,
          razorpayOrderData: sanitizedOrderData as any, // Store sanitized data in JSONB
          metadata: escrowMetadata as any, // JSONB: snapshot + client fields
          taskCategory: pickCategoryFeeConfigKey(categoryFeeKey, taskCategory) ?? null,
          appliedGstPercent: appliedGstPercent ?? null,
          appliedPlatformFeePercent: appliedPlatformFeePercent ?? null,
          appliedRazorpayGstPercent: appliedRazorpayGstPercent ?? null,
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
        bookingOrderId: bookingOrderIdColumn,
        bookingMode: (metadata as Record<string, unknown>)?.bookingMode,
        amount,
      });

      await logEscrowCreated({
        escrowId: postgresEscrow.id,
        razorpayOrderId: razorpayOrder.id,
        taskId,
        posterUid,
        amountInRupees: amountInRupeesDecimal.toString(),
        actorId: posterUid,
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
 * Create escrow for Book Now — payment before helper assignment (no performer yet).
 */
export async function createBookingEscrow(params: {
  taskId: string;
  bookingOrderId: string;
  posterUid: string;
  amount: number;
  taskAmount?: number;
  currency?: string;
  taskCategory?: string;
  metadata?: Record<string, any>;
}): Promise<{ success: boolean; escrow?: any; order?: any; error?: string }> {
  const {
    taskId,
    bookingOrderId,
    posterUid,
    amount,
    taskAmount,
    currency = 'INR',
    taskCategory,
    metadata = {},
  } = params;

  if (!bookingOrderId?.trim()) {
    return { success: false, error: 'bookingOrderId is required' };
  }

  return createEscrow({
    taskId,
    posterUid,
    performerUid: 'pending_assignment',
    amount,
    taskAmount,
    currency,
    taskCategory,
    metadata: {
      ...metadata,
      bookingMode: 'book_now',
      bookingOrderId,
    },
  });
}

/**
 * Attach performer after ops assigns helper to a Book Now order.
 */
export async function attachPerformerToEscrow(params: {
  escrowId: string;
  performerUid: string;
  applicationId?: string;
}): Promise<{ success: boolean; escrow?: any; error?: string }> {
  const { escrowId, performerUid, applicationId } = params;

  if (!escrowId?.trim() || !performerUid?.trim()) {
    return { success: false, error: 'escrowId and performerUid are required' };
  }

  if (!(await ensurePostgresReady())) {
    return { success: false, error: 'Postgres not connected' };
  }

  try {
    let targetPrisma = prisma;
    let existing = await prisma.escrow.findFirst({
      where: {
        OR: [{ escrowId }, { id: escrowId }],
      },
    });

    if (!existing && prismaDev) {
      existing = await prismaDev.escrow.findFirst({
        where: {
          OR: [{ escrowId }, { id: escrowId }],
        },
      });
      if (existing) {
        targetPrisma = prismaDev;
      }
    }

    if (!existing) {
      return { success: false, error: 'Escrow not found' };
    }

    if (!isBookNowEscrowRecord(existing)) {
      return { success: false, error: 'Escrow is not a Book Now booking' };
    }

    const pendingPerformer =
      !existing.performerUid || existing.performerUid === 'pending_assignment';
    if (!pendingPerformer && existing.performerUid !== performerUid) {
      logger.warn('Overwriting performer on book-now escrow', {
        escrowId,
        oldPerformerUid: existing.performerUid,
        newPerformerUid: performerUid,
      });
    }

    const metadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};

    const updated = await targetPrisma.escrow.update({
      where: { id: existing.id },
      data: {
        performerUid,
        applicationId: applicationId || existing.applicationId,
        metadata: {
          ...metadata,
          performerAttachedAt: new Date().toISOString(),
        } as any,
      },
    });

    logger.info('Performer attached to book-now escrow', {
      escrowId: updated.escrowId,
      bookingOrderId: resolveEscrowBookingOrderId(updated),
      performerUid,
    });

    const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(updated);
    return { success: true, escrow: escrowForFrontend };
  } catch (error: any) {
    logger.error('Failed to attach performer to escrow', {
      escrowId,
      performerUid,
      error: error?.message,
    });
    return { success: false, error: error.message || 'Failed to attach performer' };
  }
}

export async function resetPerformerOnEscrow(escrowId: string): Promise<{ success: boolean; error?: string }> {
  if (!escrowId?.trim()) {
    return { success: false, error: 'escrowId is required' };
  }

  try {
    let targetPrisma = prisma;
    let existing = await prisma.escrow.findFirst({
      where: { OR: [{ escrowId }, { id: escrowId }] },
    });

    if (!existing && prismaDev) {
      existing = await prismaDev.escrow.findFirst({
        where: { OR: [{ escrowId }, { id: escrowId }] },
      });
      if (existing) targetPrisma = prismaDev;
    }

    if (!existing) {
      return { success: false, error: 'Escrow not found' };
    }

    await targetPrisma.escrow.update({
      where: { id: existing.id },
      data: { performerUid: 'pending_assignment' },
    });

    logger.info('Performer reset on escrow', { escrowId });
    return { success: true };
  } catch (error: any) {
    logger.error('Failed to reset performer on escrow', { escrowId, error: error?.message });
    return { success: false, error: error.message || 'Failed to reset performer' };
  }
}

/**
 * Move recurring per-visit escrow from one visitId to the next when a paid visit is rescheduled.
 */
export async function reassignRecurringVisitEscrow(params: {
  escrowId: string;
  taskId: string;
  fromVisitId: string;
  toVisitId: string;
}): Promise<{ success: boolean; escrow?: any; error?: string }> {
  const { escrowId, taskId, fromVisitId, toVisitId } = params;

  const trimmedEscrowId = escrowId?.trim();
  const trimmedTaskId = taskId?.trim();
  const trimmedFromVisitId = fromVisitId?.trim();
  const trimmedToVisitId = toVisitId?.trim();

  if (!trimmedEscrowId || !trimmedTaskId || !trimmedFromVisitId || !trimmedToVisitId) {
    return {
      success: false,
      error: 'escrowId, taskId, fromVisitId, and toVisitId are required',
    };
  }

  if (trimmedFromVisitId === trimmedToVisitId) {
    logger.info('Reassign recurring visit: from and to match — will verify escrow after load', {
      escrowId: trimmedEscrowId,
      taskId: trimmedTaskId,
      visitId: trimmedFromVisitId,
    });
  }

  if (!(await ensurePostgresReady())) {
    return { success: false, error: 'Postgres not connected' };
  }

  try {
    const existing = await prisma.escrow.findFirst({
      where: {
        OR: [{ escrowId: trimmedEscrowId }, { id: trimmedEscrowId }],
      },
    });

    if (!existing) {
      return { success: false, error: 'Escrow not found' };
    }

    if (String(existing.taskId || '').trim() !== trimmedTaskId) {
      return { success: false, error: 'Escrow does not belong to this task' };
    }

    const status = String(existing.status || '').toLowerCase();
    const paymentStatus = String(existing.paymentStatus || '').toLowerCase();
    const isPaid =
      status === 'held' ||
      status === 'released' ||
      paymentStatus === 'captured' ||
      paymentStatus === 'authorized';
    if (!isPaid) {
      return {
        success: false,
        error: `Escrow payment is not held. Current status: ${existing.status}`,
      };
    }

    const metadata =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};

    const currentVisitId =
      typeof metadata.visitId === 'string' ? metadata.visitId.trim() : '';
    const reassignedFromVisitId = currentVisitId || trimmedFromVisitId;
    if (currentVisitId && currentVisitId !== trimmedFromVisitId) {
      logger.warn('Reassign recurring visit: fromVisitId differs from escrow metadata visitId; proceeding', {
        escrowId: trimmedEscrowId,
        taskId: trimmedTaskId,
        metadataVisitId: currentVisitId,
        requestedFromVisitId: trimmedFromVisitId,
        toVisitId: trimmedToVisitId,
      });
    }

    if (trimmedFromVisitId === trimmedToVisitId || currentVisitId === trimmedToVisitId) {
      if (currentVisitId !== trimmedToVisitId) {
        const updated = await prisma.escrow.update({
          where: { id: existing.id },
          data: {
            metadata: {
              ...metadata,
              visitId: trimmedToVisitId,
              recurringVisitReassignedFrom: reassignedFromVisitId || undefined,
              recurringVisitReassignedAt: new Date().toISOString(),
            } as any,
          },
        });

        logger.info('Reassign recurring visit: bound missing visitId metadata to target visit', {
          escrowId: updated.escrowId,
          taskId: trimmedTaskId,
          visitId: trimmedToVisitId,
        });

        const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(updated);
        return { success: true, escrow: escrowForFrontend };
      }

      logger.info('Reassign recurring visit: payment already on target visit — no-op', {
        escrowId: trimmedEscrowId,
        taskId: trimmedTaskId,
        visitId: trimmedToVisitId,
      });
      const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(existing);
      return { success: true, escrow: escrowForFrontend };
    }

    const updated = await prisma.escrow.update({
      where: { id: existing.id },
      data: {
        metadata: {
          ...metadata,
          visitId: trimmedToVisitId,
          recurringVisitReassignedFrom: reassignedFromVisitId,
          recurringVisitReassignedAt: new Date().toISOString(),
        } as any,
      },
    });

    logger.info('Reassigned recurring visit escrow to next visit', {
      escrowId: updated.escrowId,
      taskId: trimmedTaskId,
      fromVisitId: trimmedFromVisitId,
      toVisitId: trimmedToVisitId,
    });

    const escrowForFrontend = await convertPostgresEscrowToFrontendFormat(updated);
    return { success: true, escrow: escrowForFrontend };
  } catch (error: any) {
    logger.error('Failed to reassign recurring visit escrow', {
      escrowId,
      taskId,
      fromVisitId,
      toVisitId,
      error: error?.message,
    });
    return { success: false, error: error.message || 'Failed to reassign visit escrow' };
  }
}

/**
 * Rebuild a missing Escrow row from Razorpay order notes (legacy race when Postgres was not ready).
 */
async function recoverEscrowFromRazorpayOrder(razorpayOrderId: string) {
  const orderResult = await getOrderDetails(razorpayOrderId);
  if (!orderResult.success || !orderResult.order) {
    return null;
  }

  const order = orderResult.order as Record<string, unknown>;
  const notes = (order.notes as Record<string, unknown>) || {};
  const taskId = String(notes.taskId || '').trim();
  const posterUid = String(notes.posterUid || '').trim();
  if (!taskId || !posterUid) {
    return null;
  }

  const performerUid = String(notes.performerUid || 'pending_assignment').trim() || 'pending_assignment';
  const applicationId = String(notes.applicationId || '').trim() || null;
  const bookingOrderId = String(notes.bookingOrderId || '').trim() || null;
  const amountPaise = Number(order.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    return null;
  }

  const amountInRupees = new Prisma.Decimal((amountPaise / 100).toFixed(2));
  const originalAmount = Number(notes.originalAmountRupees);
  const taskAmountDecimal = Number.isFinite(originalAmount) && originalAmount > 0
    ? new Prisma.Decimal(originalAmount.toFixed(2))
    : amountInRupees;

  const escrowMetadata = buildEscrowMetadataSnapshot(
    {
      ...notes,
      recoveredFromRazorpayOrder: true,
      recoveredAt: new Date().toISOString(),
    } as Record<string, unknown>,
    {
      taskCategory:
        typeof notes.taskCategory === 'string' ? notes.taskCategory : null,
    },
  );

  const escrowId = generateEscrowId();
  const sanitizedOrderData = sanitizeRazorpayOrderData(order);

  const recovered = await prisma.escrow.create({
    data: {
      escrowId,
      razorpayOrderId,
      taskId,
      applicationId,
      posterUid,
      performerUid,
      bookingOrderId,
      amount: new Prisma.Decimal(amountPaise.toString()),
      currency: String(order.currency || 'INR'),
      amountInRupees,
      taskAmount: taskAmountDecimal,
      status: 'pending',
      razorpayOrderData: sanitizedOrderData as any,
      metadata: escrowMetadata as any,
      taskCategory:
        typeof notes.taskCategory === 'string' ? notes.taskCategory : null,
    },
  });

  await createLedgerEntry({
    escrowId: recovered.id,
    type: 'escrow',
    amount: amountInRupees,
    balanceBefore: new Prisma.Decimal('0.00'),
    balanceAfter: amountInRupees,
    description: `Escrow recovered for task ${taskId}`,
    metadata: { escrowId, razorpayOrderId, taskId, recovered: true },
  });

  logger.warn('Recovered missing escrow from Razorpay order', {
    escrowId: recovered.escrowId,
    razorpayOrderId,
    taskId,
    bookingOrderId,
  });

  return recovered;
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
    if (!(await ensurePostgresReady())) {
      return { success: false, error: 'Postgres not connected' };
    }

    let postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (!postgresEscrow) {
      try {
        postgresEscrow = await recoverEscrowFromRazorpayOrder(razorpayOrderId);
      } catch (recoverError: any) {
        logger.error('Failed to recover escrow from Razorpay order', {
          razorpayOrderId,
          error: recoverError?.message,
        });
      }
    }

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    // Idempotency: if this escrow is already captured for this payment, skip update and ledger
    if (
      paymentStatus === 'captured' &&
      postgresEscrow.paymentStatus === 'captured' &&
      postgresEscrow.razorpayPaymentId === razorpayPaymentId
    ) {
      await redeemCustomerCoinsOnEscrowCapture(postgresEscrow);
      logger.info('ℹ️ Escrow payment already captured (idempotent)', {
        escrowId: postgresEscrow.escrowId,
        razorpayOrderId,
        razorpayPaymentId,
      });
      return { success: true, escrow: postgresEscrow };
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
      updateData.errorMessage = (razorpayPaymentData as any)?.error_description || 'Payment failed';
      updateData.errorCode = (razorpayPaymentData as any)?.error_code || null;
    }

    const updatedEscrow = await prisma.escrow.update({
      where: { id: postgresEscrow.id },
      data: updateData,
    });

    const shouldPersistTransaction =
      typeof razorpayPaymentId === 'string' &&
      razorpayPaymentId.trim().length > 0 &&
      razorpayPaymentId !== 'unknown';

    let paymentTransaction: { id: string } | null = null;
    if (shouldPersistTransaction) {
      const paymentMethod =
        sanitizedPaymentData &&
        typeof (sanitizedPaymentData as any).method === 'string'
          ? String((sanitizedPaymentData as any).method)
          : null;

      paymentTransaction = await prisma.transaction.upsert({
        where: { razorpayPaymentId },
        create: {
          userId: postgresEscrow.posterUid,
          taskId: postgresEscrow.taskId,
          razorpayOrderId,
          razorpayPaymentId,
          amount: updatedEscrow.amountInRupees,
          currency: updatedEscrow.currency || 'INR',
          status: paymentStatus,
          paymentMethod,
          metadata: sanitizedPaymentData ? { payment: sanitizedPaymentData } : undefined,
        },
        update: {
          razorpayOrderId,
          amount: updatedEscrow.amountInRupees,
          currency: updatedEscrow.currency || 'INR',
          status: paymentStatus,
          paymentMethod: paymentMethod ?? undefined,
          metadata: sanitizedPaymentData ? { payment: sanitizedPaymentData } : undefined,
        },
        select: { id: true },
      });
    }

    // Create ledger entry for payment capture
    if (paymentStatus === 'captured') {
      // Get current balance (using Postgres escrow ID)
      const balanceResult = await getEscrowBalance(postgresEscrow.id);
      const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');

      // Create ledger entry for payment capture
      const ledgerResult = await createLedgerEntry({
        escrowId: postgresEscrow.id,
        paymentTransactionId: paymentTransaction?.id,
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

      if (paymentTransaction?.id && ledgerResult.success && ledgerResult.ledger?.id) {
        // Transaction is linked from Ledger side via paymentTransactionId
      }

      // Update UserPaymentProfile cache for poster (payment made)
      const { updateUserPaymentProfile } = await import('./userPaymentProfileService');
      updateUserPaymentProfile(postgresEscrow.posterUid, {
        type: 'payment',
        amount: updatedEscrow.amountInRupees,
        escrowId: postgresEscrow.id,
      }).catch((error) => {
        logger.warn('Failed to update UserPaymentProfile for payment (non-critical):', error);
      });

      // Send payment received email/in-app to poster (non-blocking)
      logger.info('Email trigger: payment_received', {
        posterUid: postgresEscrow.posterUid,
        amount: updatedEscrow.amountInRupees.toString(),
        taskId: postgresEscrow.taskId,
        escrowId: postgresEscrow.escrowId,
      });

      (async () => {
        try {
          const amountStr = updatedEscrow.amountInRupees.toString();
          let notifyUid = String(postgresEscrow.posterUid || '');

          if (mongoose.connection.readyState === 1) {
            const Profile = mongoose.connection.collection('profiles');
            const posterProfile =
              (await Profile.findOne({ uid: postgresEscrow.posterUid })) ||
              (mongoose.isValidObjectId(postgresEscrow.posterUid)
                ? await Profile.findOne({ _id: new mongoose.Types.ObjectId(postgresEscrow.posterUid) })
                : null);

            if (posterProfile?.uid) {
              notifyUid = String(posterProfile.uid);
            }

            // In-app + push (Firebase uid so FCM tokens resolve)
            await notifyPaymentReceived({
              posterUid: notifyUid,
              amount: amountStr,
              taskTitle: getTaskDisplayTitleFromEscrow(postgresEscrow),
              taskId: postgresEscrow.taskId,
            });

            if (posterProfile?.email) {
              await EmailServiceClient.sendPaymentReceived(
                posterProfile.email,
                posterProfile.name || 'User',
                {
                  amount: Number(amountStr),
                  taskTitle: getTaskDisplayTitleFromEscrow(postgresEscrow),
                  transactionId: razorpayPaymentId,
                  paymentDate: new Date().toLocaleString(),
                  isEscrow: true
                }
              );
            }
          } else {
            await notifyPaymentReceived({
              posterUid: notifyUid,
              amount: amountStr,
              taskTitle: getTaskDisplayTitleFromEscrow(postgresEscrow),
              taskId: postgresEscrow.taskId,
            });
          }
        } catch (err) {
          logger.error('Error sending payment received notifications:', err);
        }
      })();
    }

    logger.info('✅ Escrow updated on payment capture (Postgres only)', {
      escrowId: postgresEscrow.escrowId,
      razorpayOrderId,
      paymentStatus,
    });

    if (paymentStatus === 'captured') {
      await redeemCustomerCoinsOnEscrowCapture(postgresEscrow);

      logPaymentCaptured({
        escrowId: postgresEscrow.id,
        razorpayOrderId,
        razorpayPaymentId,
        actorId: postgresEscrow.posterUid,
      }).catch(() => {});

      const { paymentRewardsFlags } = await import('../config/rewardsFlags');
      if (paymentRewardsFlags.EMIT_PAYMENT_COMPLETED_EVENTS) {
        const { UserServiceClient } = await import('../clients/UserServiceClient');
        const taskAmount = Number(postgresEscrow.taskAmount || postgresEscrow.amountInRupees || 0);
        const feePct = Number(postgresEscrow.appliedPlatformFeePercent || 0.05);
        const platformFeeInr = Math.round(taskAmount * feePct * 100) / 100;
        UserServiceClient.processRewardEvent({
          eventType: 'PAYMENT_COMPLETED',
          payload: {
            taskId: postgresEscrow.taskId,
            posterUid: postgresEscrow.posterUid,
            refereeUid: postgresEscrow.posterUid,
            performerUid: postgresEscrow.performerUid,
            amountInr: taskAmount,
            platformFeeInr,
          },
          correlationId: postgresEscrow.escrowId,
        }).catch(() => undefined);
      }

      const capturedBookingOrderId = resolveEscrowBookingOrderId(postgresEscrow);
      if (capturedBookingOrderId) {
        const { TaskServiceClient } = await import('../clients/TaskServiceClient');
        TaskServiceClient.notifyBookingPaymentCaptured({
          bookingOrderId: capturedBookingOrderId,
          escrowId: postgresEscrow.escrowId,
          razorpayOrderId,
          taskId: postgresEscrow.taskId,
        }).catch((err) => {
          logger.error('Book Now payment-captured callback failed', {
            bookingOrderId: capturedBookingOrderId,
            taskId: postgresEscrow.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      const escrowMetadata = (postgresEscrow.metadata || {}) as Record<string, unknown>;
      const recurringVisitId =
        typeof escrowMetadata.visitId === 'string' ? escrowMetadata.visitId.trim() : '';
      const recurringParentTaskId =
        typeof escrowMetadata.parentTaskId === 'string'
          ? escrowMetadata.parentTaskId.trim()
          : postgresEscrow.taskId;
      if (recurringVisitId && (escrowMetadata.recurringPlan === true || recurringParentTaskId)) {
        const { TaskServiceClient } = await import('../clients/TaskServiceClient');
        TaskServiceClient.notifyRecurringVisitPaymentCaptured({
          parentTaskId: recurringParentTaskId,
          visitId: recurringVisitId,
          escrowId: postgresEscrow.escrowId,
        }).catch((err) => {
          logger.error('Recurring visit payment-captured callback failed', {
            parentTaskId: recurringParentTaskId,
            visitId: recurringVisitId,
            taskId: postgresEscrow.taskId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } else if (paymentStatus === 'failed') {
      logPaymentFailed({
        escrowId: postgresEscrow.id,
        razorpayOrderId,
        razorpayPaymentId,
        errorCode: (razorpayPaymentData as any)?.error_code,
        errorDescription: (razorpayPaymentData as any)?.error_description,
      }).catch(() => {});
    }

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

    let postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });
    
    if (!postgresEscrow && prismaDev) {
      postgresEscrow = await prismaDev.escrow.findUnique({
        where: { escrowId },
      });
    }

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

    let postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (!postgresEscrow && prismaDev) {
      postgresEscrow = await prismaDev.escrow.findUnique({
        where: { razorpayOrderId },
      });
    }

    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by order ID:', error);
    return null;
  }
}

async function findEscrowByBookNowLineTaskId(taskId: string) {
  const trimmed = taskId?.trim();
  if (!trimmed) return null;

  const recentBookNow = await prisma.escrow.findMany({
    where: {
      OR: [
        { bookingOrderId: { not: null } },
        { metadata: { path: ['bookingMode'], equals: 'book_now' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 80,
  });

  for (const row of recentBookNow) {
    const meta =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {};
    const lineItems = Array.isArray(meta.bookNowLineItems) ? meta.bookNowLineItems : [];
    if (
      lineItems.some((item) => {
        const rowItem = item as { taskId?: string };
        return String(rowItem?.taskId || '').trim() === trimmed;
      })
    ) {
      return row;
    }
  }

  return null;
}

/** Extract booking order id from `booknow-pending-{orderId}` escrow task keys. */
export function bookingOrderIdFromPendingTaskId(taskId: string): string | null {
  const match = /^booknow-pending-(.+)$/i.exec(String(taskId || '').trim());
  return match?.[1]?.trim() || null;
}

/**
 * Resolve Postgres escrow for cancel / lookups.
 * Tries exact taskId, Book Now line metadata, then pending-placebooker order id.
 */
export async function resolveEscrowRecordForTaskId(taskId: string) {
  const trimmed = String(taskId || '').trim();
  if (!trimmed || !isPostgresConnected()) return null;

  let postgresEscrow = await prisma.escrow.findFirst({
    where: { taskId: trimmed },
    orderBy: { createdAt: 'desc' },
  });

  if (!postgresEscrow && prismaDev) {
    postgresEscrow = await prismaDev.escrow.findFirst({
      where: { taskId: trimmed },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (postgresEscrow) return postgresEscrow;

  const byLineTask = await findEscrowByBookNowLineTaskId(trimmed);
  if (byLineTask) return byLineTask;

  const pendingOrderId = bookingOrderIdFromPendingTaskId(trimmed);
  if (pendingOrderId) {
    const byPendingOrder = await findEscrowByBookingOrderId(pendingOrderId);
    if (byPendingOrder) return byPendingOrder;
  }

  // Callers sometimes pass bookingOrderId as taskId for Book Now.
  const byOrderId = await findEscrowByBookingOrderId(trimmed);
  if (byOrderId) return byOrderId;

  return null;
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

    const postgresEscrow = await resolveEscrowRecordForTaskId(taskId);
    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by task ID:', error);
    return null;
  }
}

/** Book Now: escrow is keyed by booking order id, not always the line task id. */
export async function getEscrowByBookingOrderId(bookingOrderId: string): Promise<any | null> {
  try {
    if (!isPostgresConnected()) {
      return null;
    }

    const postgresEscrow = await findEscrowByBookingOrderId(bookingOrderId);
    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by booking order ID:', error);
    return null;
  }
}

/** Per-visit escrow lookup for recurring v2 (metadata.visitId). */
export async function getEscrowByTaskIdAndVisitId(
  taskId: string,
  visitId: string,
): Promise<any | null> {
  try {
    if (!isPostgresConnected()) {
      return null;
    }

    const trimmedVisitId = visitId?.trim();
    if (!taskId?.trim() || !trimmedVisitId) {
      return null;
    }

    let postgresEscrow = await prisma.escrow.findFirst({
      where: {
        taskId,
        metadata: {
          path: ['visitId'],
          equals: trimmedVisitId,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!postgresEscrow && prismaDev) {
      postgresEscrow = await prismaDev.escrow.findFirst({
        where: {
          taskId,
          metadata: {
            path: ['visitId'],
            equals: trimmedVisitId,
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
    }

    return postgresEscrow ? await convertPostgresEscrowToFrontendFormat(postgresEscrow) : null;
  } catch (error: any) {
    logger.error('❌ Error getting escrow by task ID and visit ID:', error);
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

    // Send notifications to performer
    logger.info('Email trigger: escrow_released', {
      performerUid: postgresEscrow.performerUid,
      amount: postgresEscrow.amountInRupees.toString(),
      taskId: postgresEscrow.taskId,
    });

    (async () => {
      try {
        if (mongoose.connection.readyState === 1 && postgresEscrow.performerUid) {
          const Profile = mongoose.connection.collection('profiles');
          const posterProfile = await Profile.findOne({ uid: postgresEscrow.posterUid }) || await Profile.findOne({ _id: new mongoose.Types.ObjectId(postgresEscrow.posterUid) });
          const performerUid = postgresEscrow.performerUid;
          const performerProfile = await Profile.findOne({ uid: performerUid }) || await Profile.findOne({ _id: new mongoose.Types.ObjectId(performerUid) });
          
          if (performerProfile) {
            const amountStr = postgresEscrow.amountInRupees.toString();
            const performerNotifyUid = String(
              performerProfile.uid || performerUid || '',
            );

            await notifyPayoutCompleted({
              performerUid: performerNotifyUid,
              amount: amountStr,
              taskTitle: getTaskDisplayTitleFromEscrow(postgresEscrow),
              taskId: postgresEscrow.taskId,
            });

            // Customer invoice ready — once per escrow after funds are released/settled.
            if (postgresEscrow.posterUid) {
              fireWhatsAppNotify({
                uid: postgresEscrow.posterUid,
                templateKey: 'wa_invoice_ready',
                category: 'payments',
                templateBody: {
                  var_1: getTaskDisplayTitleFromEscrow(postgresEscrow) || 'your task',
                },
                idempotencyKey: `wa_invoice_ready:${postgresEscrow.escrowId}`,
                metadata: {
                  workId: postgresEscrow.taskId,
                  invoiceId: postgresEscrow.escrowId,
                  triggerType: 'invoice_ready',
                  recipientRole: 'customer',
                },
              });
            }

            // Email Notification
            if (performerProfile.email) {
              await EmailServiceClient.sendEscrowReleased(
                performerProfile.email,
                performerProfile.name || 'Tasker',
                {
                  amount: Number(amountStr),
                  taskTitle: getTaskDisplayTitleFromEscrow(postgresEscrow),
                  requesterName: posterProfile?.name || 'Poster',
                  transactionId: transactionId,
                  estimatedArrival: '1-2 business days'
                }
              );
            }

            // SMS by default for payout
            if (performerProfile.phoneNumber || performerProfile.phone) {
              const phone = performerProfile.phoneNumber || performerProfile.phone;
              await import('../clients/Fast2SMSClient').then(m => m.Fast2SMSClient.sendSMS(
                phone,
                `ExtraHand: Rs ${amountStr} payout credited to your account. It will reflect in your bank account shortly.`
              ));
            }
          }
        }
      } catch (err) {
        logger.error('Error sending escrow released notifications:', err);
      }
    })();

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
