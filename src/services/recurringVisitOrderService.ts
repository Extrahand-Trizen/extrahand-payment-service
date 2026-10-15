import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { resolvePaymentEnvironment } from '../config/paymentEnvironment';
import { CouponClient } from '../clients/CouponClient';
import { ConflictError } from '../errors/AppError';
import { visitAmountsMatch } from '../utils/recurringVisitOrderValidation';

/**
 * Cross-instance serialization of recurring visit order creation. The lock is a row in
 * PaymentOrderIdempotency (unique idempotencyKey), so it holds across API instances.
 */
const LOCK_KEY_PREFIX = 'recurring-visit-order-lock';
const LOCK_ORDER_ID_PLACEHOLDER = 'recurring-visit-order-lock';
export const RECURRING_VISIT_ORDER_LOCK_TTL_MS = 30_000;
/** Pending orders older than this are superseded instead of reused. */
const REUSABLE_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lockKey(parentTaskId: string, visitId: string): string {
  return `${LOCK_KEY_PREFIX}:${parentTaskId}:${visitId}`;
}

export async function withRecurringVisitOrderLock<T>(
  parentTaskId: string,
  visitId: string,
  fn: () => Promise<T>,
  options: { waitMs?: number; pollMs?: number; ttlMs?: number } = {},
): Promise<T> {
  const waitMs = options.waitMs ?? 8_000;
  const pollMs = options.pollMs ?? 150;
  const ttlMs = options.ttlMs ?? RECURRING_VISIT_ORDER_LOCK_TTL_MS;
  const key = lockKey(parentTaskId, visitId);
  const deadline = Date.now() + waitMs;
  let lockRowId: string | null = null;

  while (!lockRowId) {
    try {
      const row = await prisma.paymentOrderIdempotency.create({
        data: {
          idempotencyKey: key,
          razorpayOrderId: LOCK_ORDER_ID_PLACEHOLDER,
          orderPayload: { lock: true, acquiredAt: new Date().toISOString() },
        },
      });
      lockRowId = row.id;
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      // A crashed holder never deletes its row; expire it after the TTL.
      await prisma.paymentOrderIdempotency.deleteMany({
        where: { idempotencyKey: key, createdAt: { lt: new Date(Date.now() - ttlMs) } },
      });
      if (Date.now() >= deadline) {
        logger.warn('Recurring visit order lock busy', { parentTaskId, visitId });
        throw new ConflictError('A payment for this visit is already being created. Please try again.');
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    await prisma.paymentOrderIdempotency
      .deleteMany({ where: { id: lockRowId } })
      .catch((error: any) =>
        logger.warn('Failed to release recurring visit order lock', {
          parentTaskId,
          visitId,
          error: error?.message,
        }),
      );
  }
}

export type RecurringVisitOrderRequest = {
  parentTaskId: string;
  visitId: string;
  posterUid: string;
  performerUid: string;
  applicationId?: string | null;
  grossAmountRupees: number;
  quotedVisitAmountRupees: number;
  metadata: Record<string, unknown>;
  authenticatedUid?: string | null;
};

function readMeta(row: { metadata?: unknown }): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function norm(value: unknown): string {
  return String(value ?? '').trim();
}

function requestUsesCoins(metadata: Record<string, unknown>): boolean {
  return metadata.useExtraCoins === true || Number(metadata.requestedCoinDiscountRupees || 0) > 0;
}

/**
 * Settles the visit's existing unpaid orders before a new one is created:
 * - an equivalent unpaid order is returned for reuse (same checkout);
 * - any other unpaid order is superseded (cancelled) so only one order stays active.
 * Failed, cancelled and refunded orders are ignored, so the customer can always retry.
 */
export async function settlePendingRecurringVisitOrders(
  request: RecurringVisitOrderRequest,
): Promise<{ reuse: any | null }> {
  // Authorized (in-flight) payments count as paid and are handled by the caller's paid check.
  const pendingRows = await prisma.escrow.findMany({
    where: {
      taskId: request.parentTaskId,
      status: 'pending',
      paymentStatus: 'pending',
      metadata: { path: ['visitId'], equals: request.visitId },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (pendingRows.length === 0) return { reuse: null };

  const environment = await resolvePaymentEnvironment(request.authenticatedUid || request.posterUid);
  const requestCoupon = norm(request.metadata.couponCode).toLowerCase();
  const reusable = requestUsesCoins(request.metadata)
    ? null
    : pendingRows.find((row) => {
        const meta = readMeta(row);
        const order = row.razorpayOrderData as Record<string, unknown> | null;
        const createdAt = row.createdAt ? new Date(row.createdAt).getTime() : 0;
        return (
          Date.now() - createdAt < REUSABLE_ORDER_MAX_AGE_MS &&
          norm(row.posterUid) === norm(request.posterUid) &&
          norm(row.performerUid) === norm(request.performerUid) &&
          norm(row.applicationId) === norm(request.applicationId) &&
          visitAmountsMatch(Number(meta.visitBudgetRupees), request.quotedVisitAmountRupees) &&
          visitAmountsMatch(Number(meta.originalAmountRupees), request.grossAmountRupees) &&
          norm(meta.couponCode).toLowerCase() === requestCoupon &&
          Number(meta.customerCoinDiscountRupees || 0) === 0 &&
          norm(meta.paymentEnvironment || 'live') === environment &&
          Boolean(order) &&
          norm(order?.id) === norm(row.razorpayOrderId) &&
          Boolean(norm(order?.keyId))
        );
      }) ?? null;

  for (const row of pendingRows) {
    if (reusable && row.id === reusable.id) continue;
    const superseded = await prisma.escrow.updateMany({
      where: { id: row.id, status: 'pending', paymentStatus: 'pending' },
      data: {
        status: 'cancelled',
        errorMessage: 'Superseded by a newer payment order for this visit',
        errorCode: 'SUPERSEDED',
      },
    });
    if (superseded.count === 0) continue;
    logger.info('Superseded unpaid recurring visit order', {
      escrowId: row.escrowId,
      razorpayOrderId: row.razorpayOrderId,
      parentTaskId: request.parentTaskId,
      visitId: request.visitId,
    });
    const couponRedemptionId = norm(readMeta(row).couponRedemptionId);
    if (couponRedemptionId) {
      await CouponClient.cancel(couponRedemptionId);
    }
  }

  if (reusable) {
    logger.info('Reusing unpaid recurring visit order', {
      escrowId: reusable.escrowId,
      razorpayOrderId: reusable.razorpayOrderId,
      parentTaskId: request.parentTaskId,
      visitId: request.visitId,
    });
  }
  return { reuse: reusable };
}
