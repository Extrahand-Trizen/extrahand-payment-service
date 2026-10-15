import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { TaskServiceClient } from '../clients/TaskServiceClient';
import { ConflictError } from '../errors/AppError';
import { withRecurringVisitOrderLock } from './recurringVisitOrderService';
import {
  DUPLICATE_VISIT_PAYMENT_CODE,
  duplicateRefundJobId,
  ensureDuplicateVisitPaymentRefund,
  isDuplicateVisitPaymentEscrow,
  recurringVisitCaptureScope,
  retryPendingDuplicateVisitPaymentRefunds,
} from './recurringVisitCaptureService';

/**
 * Refund synchronization for recurring visit payments: a refund marks exactly the refunded
 * payment's escrow `refunded` and tells task-service (via a deterministic JobQueue row that is
 * both the retry record and the idempotency key) so only that visit stops counting as paid.
 */

export const RECURRING_VISIT_REFUND_SYNC_JOB_TYPE = 'recurring_visit_refund_sync';
const RECONCILIATION_JOB_TYPE = 'reconciliation';
const SYNC_MAX_ATTEMPTS = 10;
const SYNC_RETRY_DELAY_MS = 2 * 60 * 1000;
/** A sync claim older than this is treated as abandoned by a crashed instance. */
const SYNC_CLAIM_STALE_MS = 2 * 60 * 1000;
const REFUND_LOCK_WAIT_MS = 20_000;

type EscrowRow = Record<string, any>;

const str = (value: unknown): string => (value == null ? '' : String(value).trim());

export function isRecurringVisitEscrow(escrow: EscrowRow | null | undefined): boolean {
  return recurringVisitCaptureScope(escrow) !== null;
}

/**
 * Serializes refunds of a recurring visit payment with captures and orders for the same visit.
 * Non-recurring escrows run unlocked (unchanged behaviour).
 */
export async function withRecurringEscrowRefundLock<T>(
  escrow: EscrowRow | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = recurringVisitCaptureScope(escrow);
  if (!scope) return fn();
  try {
    return await withRecurringVisitOrderLock(scope.parentTaskId, scope.visitId, fn, {
      waitMs: REFUND_LOCK_WAIT_MS,
    });
  } catch (error) {
    if (error instanceof ConflictError && /already being created/i.test(error.message)) {
      throw new ConflictError('A refund or payment for this visit is in progress. Please try again.');
    }
    throw error;
  }
}

export type EscrowLookup =
  | { escrow: EscrowRow }
  | { escrow: null; reason: 'not_found' | 'ambiguous' | 'payment_mismatch' };

/** The escrow that holds this Razorpay payment. Never falls back to a task's newest payment. */
export async function findEscrowForRazorpayPayment(params: {
  razorpayPaymentId?: string | null;
  escrowDbId?: string | null;
}): Promise<EscrowLookup> {
  const paymentId = str(params.razorpayPaymentId);
  const escrowDbId = str(params.escrowDbId);
  if (escrowDbId) {
    const row = await prisma.escrow.findUnique({ where: { id: escrowDbId } });
    if (!row) return { escrow: null, reason: 'not_found' };
    if (paymentId && str(row.razorpayPaymentId) !== paymentId) {
      return { escrow: null, reason: 'payment_mismatch' };
    }
    return { escrow: row };
  }
  if (!paymentId) return { escrow: null, reason: 'not_found' };
  const rows = await prisma.escrow.findMany({ where: { razorpayPaymentId: paymentId }, take: 2 });
  if (rows.length === 0) return { escrow: null, reason: 'not_found' };
  if (rows.length > 1) return { escrow: null, reason: 'ambiguous' };
  return { escrow: rows[0] };
}

/** Durable operator record for a refund state that must not be auto-resolved. */
export async function flagRefundReconciliation(
  escrow: EscrowRow,
  kind: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const jobId = `reconciliation_${kind}_${escrow.escrowId}`;
  const scope = recurringVisitCaptureScope(escrow);
  await prisma.jobQueue.upsert({
    where: { jobId },
    create: {
      jobId,
      jobType: RECONCILIATION_JOB_TYPE,
      entityType: 'escrow',
      entityId: escrow.id,
      payload: {
        kind,
        escrowId: escrow.escrowId,
        escrowStatus: escrow.status,
        razorpayPaymentId: escrow.razorpayPaymentId ?? null,
        taskId: escrow.taskId,
        visitId: scope?.visitId ?? null,
        ...details,
      } as Prisma.InputJsonValue,
      status: 'pending',
      maxAttempts: 1,
      nextRetryAt: new Date(),
      priority: 10,
    },
    update: {},
  });
  logger.error('Refund needs reconciliation', {
    kind,
    escrowId: escrow.escrowId,
    escrowStatus: escrow.status,
    razorpayPaymentId: escrow.razorpayPaymentId,
    ...details,
  });
}

export type EscrowRefundOutcome = 'refunded' | 'already_refunded' | 'reconciliation_required';

/**
 * Marks one escrow refunded with a write conditional on the status that was inspected.
 * Already refunded is success; released (paid out) is never overwritten.
 */
export async function markEscrowRefunded(
  escrow: EscrowRow,
  context: { source: string; razorpayRefundId?: string | null },
): Promise<{ outcome: EscrowRefundOutcome; escrow: EscrowRow }> {
  let current = escrow;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = str(current.status).toLowerCase();
    if (status === 'refunded') return { outcome: 'already_refunded', escrow: current };
    if (status === 'released') {
      await flagRefundReconciliation(current, 'refund_after_release', {
        source: context.source,
        razorpayRefundId: context.razorpayRefundId ?? null,
      });
      return { outcome: 'reconciliation_required', escrow: current };
    }
    const updated = await prisma.escrow.updateMany({
      where: { id: current.id, status: current.status },
      data: { status: 'refunded', refundedAt: new Date() },
    });
    const latest = await prisma.escrow.findUnique({ where: { id: current.id } });
    if (!latest) break;
    if (updated.count > 0) {
      logger.info('Escrow marked refunded', {
        escrowId: latest.escrowId,
        previousStatus: current.status,
        source: context.source,
        razorpayRefundId: context.razorpayRefundId,
      });
      return { outcome: 'refunded', escrow: latest };
    }
    current = latest;
  }
  await flagRefundReconciliation(current, 'refund_state_contended', { source: context.source });
  return { outcome: 'reconciliation_required', escrow: current };
}

export type RecurringVisitRefundSyncStatus =
  | 'synced'
  | 'in_progress'
  | 'retry_scheduled'
  | 'needs_reconciliation'
  | 'skipped';

export function recurringVisitRefundSyncJobId(escrowId: string): string {
  return `recurring_visit_refund_sync_${escrowId}`;
}

/**
 * Tells task-service that this refunded escrow no longer pays its visit, at most once per escrow.
 * Duplicate captures are skipped: they were never bound to the visit.
 */
export async function ensureRecurringVisitRefundSync(escrowDbId: string): Promise<{
  status: RecurringVisitRefundSyncStatus;
  error?: string;
}> {
  const escrow = await prisma.escrow.findUnique({ where: { id: escrowDbId } });
  if (!escrow) return { status: 'skipped', error: 'Escrow not found' };
  const scope = recurringVisitCaptureScope(escrow);
  if (!scope || isDuplicateVisitPaymentEscrow(escrow)) return { status: 'skipped' };
  if (str(escrow.status) !== 'refunded') {
    return { status: 'skipped', error: 'Escrow is not refunded' };
  }

  const jobId = recurringVisitRefundSyncJobId(escrow.escrowId);
  await prisma.jobQueue.upsert({
    where: { jobId },
    create: {
      jobId,
      jobType: RECURRING_VISIT_REFUND_SYNC_JOB_TYPE,
      entityType: 'escrow',
      entityId: escrow.id,
      payload: {
        eventId: jobId,
        parentTaskId: scope.parentTaskId,
        visitId: scope.visitId,
        escrowId: escrow.escrowId,
        razorpayPaymentId: escrow.razorpayPaymentId ?? null,
        refundStatus: 'refunded',
      },
      status: 'pending',
      maxAttempts: SYNC_MAX_ATTEMPTS,
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
        { status: 'processing', updatedAt: { lt: new Date(Date.now() - SYNC_CLAIM_STALE_MS) } },
      ],
    },
    data: { status: 'processing', attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) {
    const job = await prisma.jobQueue.findUnique({ where: { jobId } });
    if (job?.status === 'completed') return { status: 'synced' };
    if (job?.status === 'failed') return { status: 'needs_reconciliation', error: job.lastError ?? undefined };
    return { status: 'in_progress' };
  }

  const finish = (data: Record<string, unknown>) => prisma.jobQueue.update({ where: { jobId }, data });

  try {
    await TaskServiceClient.notifyRecurringVisitPaymentRefunded({
      parentTaskId: scope.parentTaskId,
      visitId: scope.visitId,
      escrowId: escrow.escrowId,
      razorpayPaymentId: str(escrow.razorpayPaymentId) || undefined,
      eventId: jobId,
    });
    await finish({ status: 'completed', completedAt: new Date(), lastError: null });
    return { status: 'synced' };
  } catch (error: any) {
    const httpStatus = Number(error?.response?.status) || 0;
    const message = str(error?.response?.data?.error || error?.message) || 'Task service unavailable';
    // 4xx (except conflict / rate limit) means task-service will never accept this event.
    const permanent = httpStatus >= 400 && httpStatus < 500 && httpStatus !== 409 && httpStatus !== 429;
    const job = await prisma.jobQueue.findUnique({ where: { jobId } });
    const exhausted = (job?.attemptCount ?? 0) >= (job?.maxAttempts ?? SYNC_MAX_ATTEMPTS);
    if (permanent || exhausted) {
      await finish({ status: 'failed', lastError: `Needs reconciliation: ${message}`, completedAt: new Date() });
      logger.error('Recurring visit refund sync failed permanently; needs reconciliation', {
        escrowId: escrow.escrowId,
        parentTaskId: scope.parentTaskId,
        visitId: scope.visitId,
        httpStatus,
        error: message,
      });
      return { status: 'needs_reconciliation', error: message };
    }
    await finish({
      status: 'pending',
      lastError: message,
      nextRetryAt: new Date(Date.now() + SYNC_RETRY_DELAY_MS),
    });
    logger.warn('Recurring visit refund sync failed; will retry', {
      escrowId: escrow.escrowId,
      parentTaskId: scope.parentTaskId,
      visitId: scope.visitId,
      attempts: job?.attemptCount,
      error: message,
    });
    return { status: 'retry_scheduled', error: message };
  }
}

/** Never throws: a refund that already happened must not be reported as failed. */
export async function syncRecurringVisitRefundSafely(escrowDbId: string): Promise<RecurringVisitRefundSyncStatus> {
  try {
    return (await ensureRecurringVisitRefundSync(escrowDbId)).status;
  } catch (error: any) {
    logger.error('Recurring visit refund sync could not be recorded', {
      escrowDbId,
      error: error?.message || String(error),
    });
    return 'needs_reconciliation';
  }
}

/** Retries due refund syncs (for a job worker or operator). */
export async function retryPendingRecurringVisitRefundSyncs(limit = 20): Promise<{
  synced: number;
  pending: number;
}> {
  const jobs = await prisma.jobQueue.findMany({
    where: {
      jobType: RECURRING_VISIT_REFUND_SYNC_JOB_TYPE,
      OR: [
        { status: 'pending', nextRetryAt: { lte: new Date() } },
        { status: 'processing', updatedAt: { lt: new Date(Date.now() - SYNC_CLAIM_STALE_MS) } },
      ],
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  });
  let synced = 0;
  let pending = 0;
  for (const job of jobs) {
    const outcome = await ensureRecurringVisitRefundSync(String(job.entityId));
    if (outcome.status === 'synced') synced += 1;
    else pending += 1;
  }
  return { synced, pending };
}

function paise(value: unknown): number {
  const n = Number(value?.toString?.() ?? value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

async function refundedPaiseForPayment(razorpayPaymentId: string): Promise<number> {
  const rows = await prisma.refund.findMany({
    where: { paymentId: razorpayPaymentId, status: { in: ['processing', 'completed'] } },
  });
  return rows.reduce((sum: number, row: { refundAmount: unknown }) => sum + paise(row.refundAmount), 0);
}

function escrowCapturedPaise(escrow: EscrowRow): number {
  const amount = Number(escrow.amount?.toString?.() ?? escrow.amount);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount) : paise(escrow.amountInRupees);
}

/** Response shape of a Razorpay refund entity, rebuilt from the local refund record. */
function refundEntityFromRecord(row: EscrowRow): Record<string, unknown> {
  return {
    id: row.razorpayRefundId,
    entity: 'refund',
    amount: paise(row.refundAmount),
    currency: 'INR',
    payment_id: row.paymentId,
    status: 'processed',
  };
}

async function recordDirectRefund(
  escrow: EscrowRow,
  razorpayPaymentId: string,
  refund: Record<string, any> | undefined,
): Promise<{ outcome: EscrowRefundOutcome | 'partial' }> {
  const razorpayRefundId = str(refund?.id);
  const refundPaise = Number(refund?.amount);
  if (razorpayRefundId && Number.isFinite(refundPaise) && refundPaise > 0) {
    const existing = await prisma.refund.findUnique({ where: { razorpayRefundId } });
    if (!existing) {
      const amount = new Prisma.Decimal((refundPaise / 100).toFixed(2));
      try {
        await prisma.$transaction(async (tx: any) => {
          const row = await tx.refund.create({
            data: {
              refundId: `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              escrowId: escrow.id,
              taskId: escrow.taskId,
              paymentId: razorpayPaymentId,
              razorpayRefundId,
              refundAmount: amount,
              reason: 'Direct refund',
              status: 'completed',
              completedAt: new Date(),
            },
          });
          const latest = await tx.ledger.findFirst({
            where: { escrowId: escrow.id },
            orderBy: { createdAt: 'desc' },
          });
          const before = latest?.balanceAfter
            ? new Prisma.Decimal(latest.balanceAfter.toString())
            : new Prisma.Decimal('0.00');
          await tx.ledger.create({
            data: {
              transactionId: `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              escrowId: escrow.id,
              refundId: row.id,
              taskId: escrow.taskId,
              type: 'refund',
              amount: amount.neg(),
              balanceBefore: before,
              balanceAfter: before.sub(amount),
              description: 'Direct refund',
              metadata: { razorpayRefundId, source: 'payment_refund_api' },
            },
          });
        });
      } catch (error: any) {
        if (error?.code !== 'P2002') throw error;
      }
    }
  }

  const refundedPaise = await refundedPaiseForPayment(razorpayPaymentId);
  if (refundedPaise < escrowCapturedPaise(escrow)) {
    await flagRefundReconciliation(escrow, 'partial_refund', {
      source: 'payment_refund_api',
      razorpayRefundId: razorpayRefundId || null,
      refundedPaise,
    });
    return { outcome: 'partial' };
  }
  const marked = await markEscrowRefunded(escrow, {
    source: 'payment_refund_api',
    razorpayRefundId: razorpayRefundId || null,
  });
  return { outcome: marked.outcome };
}

type RazorpayRefundResult = { success: boolean; refund?: any; error?: string };

export type DirectRefundOutcome<T extends RazorpayRefundResult> =
  | { kind: 'issued'; result: T }
  | { kind: 'already_refunded'; refund: Record<string, unknown> }
  | { kind: 'rejected'; error: string };

/**
 * POST /payment/refund for a recurring visit payment: refuses paid-out or already refunded
 * payments and partial amounts, records the refund once and marks only that escrow refunded.
 * Other payments keep the existing direct Razorpay refund behaviour.
 */
export async function issueDirectRefund<T extends RazorpayRefundResult>(
  razorpayPaymentId: string,
  issueRefund: () => Promise<T>,
  options: { requestedPaise?: number | null } = {},
): Promise<DirectRefundOutcome<T>> {
  const paymentId = str(razorpayPaymentId);
  const found = await findEscrowForRazorpayPayment({ razorpayPaymentId: paymentId });
  if (!found.escrow || !isRecurringVisitEscrow(found.escrow)) {
    if (!found.escrow && found.reason === 'ambiguous') {
      logger.error('Direct refund: several escrows share one Razorpay payment id', { razorpayPaymentId: paymentId });
    }
    return { kind: 'issued', result: await issueRefund() };
  }

  let syncEscrowDbId: string | null = null;
  const outcome = await withRecurringEscrowRefundLock(found.escrow, async (): Promise<DirectRefundOutcome<T>> => {
    const escrow = await prisma.escrow.findUnique({ where: { id: found.escrow.id } });
    if (!escrow || str(escrow.razorpayPaymentId) !== paymentId) {
      return { kind: 'rejected', error: 'Payment record changed; please retry' };
    }
    const status = str(escrow.status).toLowerCase();
    if (status === 'released') {
      return { kind: 'rejected', error: 'This visit payment was already paid out; refund needs manual review' };
    }
    if (status === 'refunded') {
      syncEscrowDbId = escrow.id;
      const existing = await prisma.refund.findFirst({
        where: { paymentId, status: { in: ['processing', 'completed'] }, razorpayRefundId: { not: null } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) return { kind: 'already_refunded', refund: refundEntityFromRecord(existing) };
      return { kind: 'rejected', error: 'Payment already refunded' };
    }

    // A partial refund would leave the visit counted as paid in full; only the whole remaining
    // visit payment can be refunded here.
    if (options.requestedPaise != null) {
      const requested = Number(options.requestedPaise);
      const refundable = escrowCapturedPaise(escrow) - (await refundedPaiseForPayment(paymentId));
      if (!Number.isFinite(requested) || requested <= 0) {
        return { kind: 'rejected', error: 'Refund amount must be a positive number' };
      }
      if (requested > refundable) {
        return { kind: 'rejected', error: 'Refund amount exceeds the refundable visit payment' };
      }
      if (requested < refundable) {
        return {
          kind: 'rejected',
          error: 'Partial refunds of a recurring visit payment are not supported; refund the full visit payment',
        };
      }
    }

    const result = await issueRefund();
    if (!result.success) return { kind: 'issued', result };
    const recorded = await recordDirectRefund(escrow, paymentId, result.refund);
    if (recorded.outcome === 'refunded' || recorded.outcome === 'already_refunded') {
      syncEscrowDbId = escrow.id;
    }
    return { kind: 'issued', result };
  });

  if (syncEscrowDbId) await syncRecurringVisitRefundSafely(syncEscrowDbId);
  return outcome;
}

export type UserDirectRefundOutcome =
  | { kind: 'already_refunded'; refund: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'rejected'; error: string };

/**
 * POST /payment/refund relayed for an app user. The payment must be an escrow the user paid for,
 * and a user never starts a new refund here: refunds of active or cancelled bookings go through
 * the cancellation flow, which applies the cancellation policy. Asking again for a refund that
 * already happened returns the recorded refund.
 */
export async function resolveUserDirectRefund(
  razorpayPaymentId: string,
  callerUids: string[],
): Promise<UserDirectRefundOutcome> {
  const paymentId = str(razorpayPaymentId);
  const found = await findEscrowForRazorpayPayment({ razorpayPaymentId: paymentId });
  if (!found.escrow) return { kind: 'not_found' };
  const escrow = found.escrow;
  const poster = str(escrow.posterUid);
  if (!poster || !callerUids.includes(poster)) return { kind: 'forbidden' };

  const status = str(escrow.status).toLowerCase();
  if (status === 'released') {
    return { kind: 'rejected', error: 'This payment was already paid out; a refund needs manual review' };
  }
  if (status === 'refunded') {
    const existing = await prisma.refund.findFirst({
      where: { paymentId, status: { in: ['processing', 'completed'] }, razorpayRefundId: { not: null } },
      orderBy: { createdAt: 'desc' },
    });
    if (isRecurringVisitEscrow(escrow)) await syncRecurringVisitRefundSafely(escrow.id);
    if (existing) return { kind: 'already_refunded', refund: refundEntityFromRecord(existing) };
    return { kind: 'rejected', error: 'Payment already refunded' };
  }
  return {
    kind: 'rejected',
    error: 'Refunds for a booking are issued by cancelling the task or visit',
  };
}

type RefundWebhookPayment = { id?: string; amount?: number; amount_refunded?: number; status?: string };

function paymentFullyRefunded(payment: RefundWebhookPayment | undefined): boolean | null {
  if (!payment) return null;
  if (str(payment.status).toLowerCase() === 'refunded') return true;
  const amount = Number(payment.amount);
  const refunded = Number(payment.amount_refunded);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(refunded)) return null;
  return refunded >= amount;
}

/**
 * Razorpay refund webhook for a recurring visit payment. Idempotent: an escrow already refunded
 * only re-ensures the (deduplicated) task-service sync; nothing else is written.
 */
export async function syncRecurringEscrowFromRefundWebhook(params: {
  razorpayRefundId?: string | null;
  razorpayPaymentId?: string | null;
  payment?: RefundWebhookPayment;
}): Promise<{ outcome: EscrowRefundOutcome | 'skipped'; sync?: RecurringVisitRefundSyncStatus }> {
  const razorpayRefundId = str(params.razorpayRefundId);
  const localRefund = razorpayRefundId
    ? await prisma.refund.findUnique({ where: { razorpayRefundId } })
    : null;
  const paymentId = str(params.razorpayPaymentId) || str(localRefund?.paymentId);
  if (!paymentId) return { outcome: 'skipped' };

  const found = await findEscrowForRazorpayPayment({
    razorpayPaymentId: paymentId,
    escrowDbId: localRefund?.escrowId,
  });
  if (!found.escrow) {
    if (found.reason !== 'not_found') {
      logger.error('Refund webhook: escrow for the refunded payment is not unique', {
        razorpayRefundId,
        razorpayPaymentId: paymentId,
        reason: found.reason,
      });
    }
    return { outcome: 'skipped' };
  }
  const escrow = found.escrow;
  if (!isRecurringVisitEscrow(escrow)) return { outcome: 'skipped' };

  if (str(escrow.status).toLowerCase() === 'refunded') {
    return { outcome: 'already_refunded', sync: await syncRecurringVisitRefundSafely(escrow.id) };
  }

  const full = paymentFullyRefunded(params.payment);
  if (full !== true) {
    await flagRefundReconciliation(escrow, full === false ? 'partial_refund' : 'refund_unverified', {
      source: 'razorpay_webhook',
      razorpayRefundId: razorpayRefundId || null,
    });
    return { outcome: 'reconciliation_required' };
  }

  const marked = await markEscrowRefunded(escrow, { source: 'razorpay_webhook', razorpayRefundId });
  if (marked.outcome === 'reconciliation_required') return { outcome: marked.outcome };
  if (marked.outcome === 'refunded' && !localRefund) {
    await flagRefundReconciliation(marked.escrow, 'unrecorded_refund', {
      source: 'razorpay_webhook',
      razorpayRefundId: razorpayRefundId || null,
    });
  }
  return { outcome: marked.outcome, sync: await syncRecurringVisitRefundSafely(escrow.id) };
}

/**
 * Repairs stale recurring refund state without guessing: completed refunds whose escrow is still
 * held, refunded escrows whose visit was never told, and unrefunded duplicate captures. Partial
 * or unverifiable cases are flagged for review, never refunded or reassigned automatically.
 */
export async function reconcileRecurringVisitRefundState(options: { limit?: number; lookbackDays?: number } = {}): Promise<{
  escrowsMarkedRefunded: number;
  flaggedForReview: number;
  visitSyncs: number;
  duplicateRefunds: number;
}> {
  const limit = options.limit ?? 50;
  const since = new Date(Date.now() - (options.lookbackDays ?? 30) * 24 * 60 * 60 * 1000);
  const result = { escrowsMarkedRefunded: 0, flaggedForReview: 0, visitSyncs: 0, duplicateRefunds: 0 };

  // A: completed refund recorded, escrow still active.
  const refunds = await prisma.refund.findMany({
    where: { status: 'completed', escrowId: { not: null }, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: limit * 4,
  });
  const seenEscrows = new Set<string>();
  for (const refund of refunds) {
    const escrowDbId = str(refund.escrowId);
    if (!escrowDbId || seenEscrows.has(escrowDbId)) continue;
    seenEscrows.add(escrowDbId);
    const escrow = await prisma.escrow.findUnique({ where: { id: escrowDbId } });
    if (!escrow || !isRecurringVisitEscrow(escrow)) continue;
    const status = str(escrow.status).toLowerCase();
    if (status === 'refunded') continue;
    if (str(escrow.razorpayPaymentId) !== str(refund.paymentId)) {
      await flagRefundReconciliation(escrow, 'refund_payment_mismatch', { refundId: refund.refundId });
      result.flaggedForReview += 1;
      continue;
    }
    if (status === 'released' || (await refundedPaiseForPayment(refund.paymentId)) < escrowCapturedPaise(escrow)) {
      await flagRefundReconciliation(escrow, status === 'released' ? 'refund_after_release' : 'partial_refund', {
        refundId: refund.refundId,
        source: 'reconciliation',
      });
      result.flaggedForReview += 1;
      continue;
    }
    const marked = await markEscrowRefunded(escrow, { source: 'reconciliation', razorpayRefundId: refund.razorpayRefundId });
    if (marked.outcome === 'refunded') result.escrowsMarkedRefunded += 1;
  }

  // B / C: refunded escrow whose visit sync never completed (task-service rebinds a replacement).
  const refundedEscrows = await prisma.escrow.findMany({
    where: { status: 'refunded', refundedAt: { gte: since } },
    orderBy: { refundedAt: 'asc' },
    take: limit * 4,
  });
  for (const escrow of refundedEscrows) {
    if (result.visitSyncs >= limit) break;
    if (!isRecurringVisitEscrow(escrow) || isDuplicateVisitPaymentEscrow(escrow)) continue;
    const job = await prisma.jobQueue.findUnique({ where: { jobId: recurringVisitRefundSyncJobId(escrow.escrowId) } });
    if (job && job.status !== 'pending') continue;
    if (job && job.nextRetryAt > new Date()) continue;
    const outcome = await ensureRecurringVisitRefundSync(escrow.id);
    if (outcome.status === 'synced') result.visitSyncs += 1;
  }

  // D: duplicate capture still holding money.
  const duplicates = await prisma.escrow.findMany({
    where: { errorCode: DUPLICATE_VISIT_PAYMENT_CODE, status: 'cancelled', paymentStatus: 'captured' },
    take: limit,
  });
  for (const duplicate of duplicates) {
    const job = await prisma.jobQueue.findUnique({ where: { jobId: duplicateRefundJobId(duplicate.escrowId) } });
    if (job) continue;
    const outcome = await ensureDuplicateVisitPaymentRefund(duplicate.id);
    if (outcome.status === 'refunded') result.duplicateRefunds += 1;
  }
  result.duplicateRefunds += (await retryPendingDuplicateVisitPaymentRefunds(limit)).refunded;

  return result;
}
