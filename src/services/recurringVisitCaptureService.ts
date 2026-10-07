import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { withRecurringVisitOrderLock } from './recurringVisitOrderService';
import { processRefund } from './refundService';
import { isEscrowPaidRecord, resolveEscrowPaymentTransition } from '../utils/escrowPaymentState';

/**
 * A recurring visit has at most one bound payment. A capture that arrives after the visit already
 * has one is a duplicate: it is stored as `cancelled` with `paymentStatus` `captured` and this
 * error code (never `held`, so it is never bound, released or paid out) and is refunded.
 */
export const DUPLICATE_VISIT_PAYMENT_CODE = 'DUPLICATE_VISIT_PAYMENT';

const REFUND_JOB_TYPE = 'refund_retry';
const REFUND_JOB_REASON = 'duplicate_recurring_visit_payment';
const CAPTURE_LOCK_WAIT_MS = 20_000;
const REFUND_RETRY_DELAY_MS = 5 * 60 * 1000;
/** A refund claim older than this is treated as abandoned by a crashed instance. */
const REFUND_CLAIM_STALE_MS = 2 * 60 * 1000;
const REFUND_MAX_ATTEMPTS = 10;

type EscrowRow = Record<string, any>;

const str = (value: unknown): string => (value == null ? '' : String(value).trim());

function readMeta(row: EscrowRow | null | undefined): Record<string, unknown> {
  const meta = row?.metadata;
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export type RecurringVisitCaptureScope = { parentTaskId: string; visitId: string };

/**
 * Visit scope from the escrow's own server-written order metadata (set at order creation from
 * the task-service visit quote). Escrows whose plan id disagrees with their task id are not
 * classified, so an unrelated payment is never treated as a visit duplicate.
 */
export function recurringVisitCaptureScope(escrow: EscrowRow | null | undefined): RecurringVisitCaptureScope | null {
  const meta = readMeta(escrow);
  const visitId = str(meta.visitId);
  const parentTaskId = str(escrow?.taskId);
  if (!visitId || !parentTaskId) return null;
  const metaParentTaskId = str(meta.parentTaskId);
  if (metaParentTaskId && metaParentTaskId !== parentTaskId) {
    logger.warn('Recurring visit capture not classified: escrow task and plan metadata differ', {
      escrowId: escrow?.escrowId,
      taskId: parentTaskId,
      metadataParentTaskId: metaParentTaskId,
      visitId,
    });
    return null;
  }
  return { parentTaskId, visitId };
}

export function isDuplicateVisitPaymentEscrow(escrow: EscrowRow | null | undefined): boolean {
  return str(escrow?.errorCode) === DUPLICATE_VISIT_PAYMENT_CODE;
}

/** The visit's bound payment: captured money still held or already paid out. */
function isVisitBoundPayment(row: EscrowRow): boolean {
  const status = str(row.status).toLowerCase();
  return isEscrowPaidRecord(row) && (status === 'held' || status === 'released');
}

export type RecurringVisitCaptureBinding =
  | { outcome: 'winner'; escrow: EscrowRow }
  | { outcome: 'already_winner'; escrow: EscrowRow }
  | { outcome: 'duplicate'; escrow: EscrowRow; winnerEscrowIds: string[]; newlyMarked: boolean }
  | { outcome: 'ignored'; escrow: EscrowRow; reason: string };

/**
 * Decides, under the visit's order lock, whether this capture becomes the visit's bound payment
 * (`held`) or is a duplicate, and persists that decision with a write conditional on the state
 * that was inspected. Captures for the same visit are serialized, so exactly one can win.
 */
export async function bindRecurringVisitCapture(params: {
  escrowDbId: string;
  scope: RecurringVisitCaptureScope;
  razorpayPaymentId: string;
  razorpayPaymentData?: unknown;
}): Promise<RecurringVisitCaptureBinding> {
  const { escrowDbId, scope, razorpayPaymentId } = params;
  return withRecurringVisitOrderLock(
    scope.parentTaskId,
    scope.visitId,
    async (): Promise<RecurringVisitCaptureBinding> => {
      const current = await prisma.escrow.findUnique({ where: { id: escrowDbId } });
      if (!current) throw new Error('Escrow not found');

      if (isDuplicateVisitPaymentEscrow(current)) {
        if (str(current.razorpayPaymentId) === razorpayPaymentId) {
          const recorded = readMeta(current).duplicateVisitPayment as { winnerEscrowIds?: string[] } | undefined;
          return {
            outcome: 'duplicate',
            escrow: current,
            winnerEscrowIds: recorded?.winnerEscrowIds ?? [],
            newlyMarked: false,
          };
        }
        logger.error('Another payment captured on an order already marked as a duplicate visit payment', {
          escrowId: current.escrowId,
          razorpayOrderId: current.razorpayOrderId,
          recordedPaymentId: current.razorpayPaymentId,
          razorpayPaymentId,
        });
        return { outcome: 'ignored', escrow: current, reason: 'order already settled as a duplicate' };
      }

      if (
        str(current.paymentStatus) === 'captured' &&
        str(current.status) === 'held' &&
        str(current.razorpayPaymentId) === razorpayPaymentId
      ) {
        return { outcome: 'already_winner', escrow: current };
      }

      const transition = resolveEscrowPaymentTransition(current, 'captured', razorpayPaymentId);
      if (!transition.apply) {
        return { outcome: 'ignored', escrow: current, reason: transition.reason };
      }

      const siblings = await prisma.escrow.findMany({
        where: {
          taskId: scope.parentTaskId,
          id: { not: current.id },
          metadata: { path: ['visitId'], equals: scope.visitId },
        },
        orderBy: { createdAt: 'asc' },
      });
      const winners = siblings.filter(isVisitBoundPayment);
      const paymentFields = {
        razorpayPaymentId,
        paymentStatus: 'captured',
        ...(params.razorpayPaymentData ? { razorpayPaymentData: params.razorpayPaymentData as any } : {}),
      };
      const guard = { id: current.id, status: current.status, paymentStatus: current.paymentStatus };

      if (winners.length === 0) {
        const bound = await prisma.escrow.updateMany({
          where: guard,
          data: { ...paymentFields, status: 'held', heldAt: new Date() },
        });
        const latest = (await prisma.escrow.findUnique({ where: { id: current.id } })) ?? current;
        if (bound.count === 0) {
          return { outcome: 'ignored', escrow: latest, reason: 'escrow changed concurrently' };
        }
        return { outcome: 'winner', escrow: latest };
      }

      const winnerEscrowIds = winners.map((row) => String(row.escrowId));
      if (winners.length > 1) {
        logger.error('Recurring visit already has multiple bound payments; needs reconciliation', {
          parentTaskId: scope.parentTaskId,
          visitId: scope.visitId,
          boundEscrowIds: winnerEscrowIds,
          newCaptureEscrowId: current.escrowId,
        });
      }
      const marked = await prisma.escrow.updateMany({
        where: guard,
        data: {
          ...paymentFields,
          status: 'cancelled',
          errorCode: DUPLICATE_VISIT_PAYMENT_CODE,
          errorMessage: 'Duplicate payment for a visit that is already paid; refunded to the customer',
          metadata: {
            ...readMeta(current),
            duplicateVisitPayment: {
              winnerEscrowIds,
              previousStatus: current.status,
              detectedAt: new Date().toISOString(),
            },
          } as any,
        },
      });
      const latest = (await prisma.escrow.findUnique({ where: { id: current.id } })) ?? current;
      if (marked.count === 0) {
        return { outcome: 'ignored', escrow: latest, reason: 'escrow changed concurrently' };
      }
      logger.warn('Duplicate captured payment for recurring visit; refunding', {
        escrowId: current.escrowId,
        razorpayOrderId: current.razorpayOrderId,
        razorpayPaymentId,
        parentTaskId: scope.parentTaskId,
        visitId: scope.visitId,
        previousStatus: current.status,
        boundEscrowIds: winnerEscrowIds,
      });
      return { outcome: 'duplicate', escrow: latest, winnerEscrowIds, newlyMarked: true };
    },
    { waitMs: CAPTURE_LOCK_WAIT_MS },
  );
}

export type DuplicateVisitRefundStatus =
  | 'refunded'
  | 'in_progress'
  | 'retry_scheduled'
  | 'needs_reconciliation'
  | 'skipped';

export function duplicateRefundJobId(escrowId: string): string {
  return `refund_retry_duplicate_visit_payment_${escrowId}`;
}

/**
 * Refunds a duplicate visit payment at most once. The JobQueue row (deterministic jobId) is both
 * the retry record and a claim: only the caller that moves it to `processing` calls Razorpay;
 * processRefund additionally refuses a second refund for the same payment id.
 */
export async function ensureDuplicateVisitPaymentRefund(escrowDbId: string): Promise<{
  status: DuplicateVisitRefundStatus;
  error?: string;
}> {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowDbId } });
  if (!escrow) return { status: 'skipped', error: 'Escrow not found' };
  const jobId = duplicateRefundJobId(escrow.escrowId);

  if (str(escrow.status) === 'refunded') {
    await prisma.jobQueue.updateMany({
      where: { jobId, status: { not: 'completed' } },
      data: { status: 'completed', completedAt: new Date(), lastError: null },
    });
    return { status: 'refunded' };
  }
  if (!isDuplicateVisitPaymentEscrow(escrow) || str(escrow.status) !== 'cancelled') {
    logger.error('Duplicate visit refund skipped: escrow is not a duplicate visit payment', {
      escrowId: escrow.escrowId,
      status: escrow.status,
      errorCode: escrow.errorCode,
    });
    return { status: 'skipped', error: 'Escrow is not a duplicate visit payment' };
  }

  const scope = recurringVisitCaptureScope(escrow);
  await prisma.jobQueue.upsert({
    where: { jobId },
    create: {
      jobId,
      jobType: REFUND_JOB_TYPE,
      entityType: 'escrow',
      entityId: escrow.id,
      payload: {
        reason: REFUND_JOB_REASON,
        escrowId: escrow.escrowId,
        razorpayOrderId: escrow.razorpayOrderId,
        razorpayPaymentId: escrow.razorpayPaymentId,
        parentTaskId: scope?.parentTaskId ?? escrow.taskId,
        visitId: scope?.visitId ?? null,
      },
      status: 'pending',
      maxAttempts: REFUND_MAX_ATTEMPTS,
      nextRetryAt: new Date(),
      priority: 10,
    },
    update: {},
  });

  const claimed = await prisma.jobQueue.updateMany({
    where: {
      jobId,
      OR: [
        { status: 'pending' },
        { status: 'processing', updatedAt: { lt: new Date(Date.now() - REFUND_CLAIM_STALE_MS) } },
      ],
    },
    data: { status: 'processing', attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) {
    const job = await prisma.jobQueue.findUnique({ where: { jobId } });
    if (job?.status === 'completed') return { status: 'refunded' };
    if (job?.status === 'failed') return { status: 'needs_reconciliation', error: job.lastError ?? undefined };
    return { status: 'in_progress' };
  }

  const finish = (data: Record<string, unknown>) => prisma.jobQueue.update({ where: { jobId }, data });

  let result: { success: boolean; error?: string };
  try {
    const now = new Date();
    result = await processRefund({
      razorpayOrderId: escrow.razorpayOrderId,
      razorpayPaymentId: str(escrow.razorpayPaymentId),
      reason: 'Duplicate payment for a recurring visit that was already paid',
      cancelledBy: 'poster',
      taskStartDate: now,
      cancelledAt: now,
      amount: Number(escrow.amountInRupees),
    });
  } catch (error: any) {
    result = { success: false, error: error?.message || 'Refund failed' };
  }

  const error = str(result.error);
  if (result.success || /already refunded/i.test(error)) {
    await finish({ status: 'completed', completedAt: new Date(), lastError: null });
    logger.info('Duplicate recurring visit payment refunded', {
      escrowId: escrow.escrowId,
      razorpayPaymentId: escrow.razorpayPaymentId,
    });
    return { status: 'refunded' };
  }
  if (/no capturable balance/i.test(error)) {
    // Razorpay shows the payment fully refunded but no refund was recorded here: never refund again.
    await finish({ status: 'failed', lastError: `Needs reconciliation: ${error}`, completedAt: new Date() });
    logger.error('Duplicate visit payment already refunded at Razorpay without a local record', {
      escrowId: escrow.escrowId,
      razorpayPaymentId: escrow.razorpayPaymentId,
    });
    return { status: 'needs_reconciliation', error };
  }

  const job = await prisma.jobQueue.findUnique({ where: { jobId } });
  const exhausted = (job?.attemptCount ?? 0) >= (job?.maxAttempts ?? REFUND_MAX_ATTEMPTS);
  await finish({
    status: exhausted ? 'failed' : 'pending',
    lastError: error || 'Refund failed',
    nextRetryAt: new Date(Date.now() + REFUND_RETRY_DELAY_MS),
  });
  logger.error('Duplicate recurring visit payment refund failed; will retry', {
    escrowId: escrow.escrowId,
    razorpayPaymentId: escrow.razorpayPaymentId,
    attempts: job?.attemptCount,
    exhausted,
    error,
  });
  return { status: exhausted ? 'needs_reconciliation' : 'retry_scheduled', error };
}

/** Retries due duplicate visit refunds (for a job worker or operator). */
export async function retryPendingDuplicateVisitPaymentRefunds(limit = 20): Promise<{
  refunded: number;
  pending: number;
}> {
  const jobs = await prisma.jobQueue.findMany({
    where: {
      jobType: REFUND_JOB_TYPE,
      entityType: 'escrow',
      status: 'pending',
      nextRetryAt: { lte: new Date() },
      payload: { path: ['reason'], equals: REFUND_JOB_REASON },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  });
  let refunded = 0;
  let pending = 0;
  for (const job of jobs) {
    const outcome = await ensureDuplicateVisitPaymentRefund(String(job.entityId));
    if (outcome.status === 'refunded') refunded += 1;
    else pending += 1;
  }
  return { refunded, pending };
}
