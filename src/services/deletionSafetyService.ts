import { isPostgresConnected } from '../config/database';
import { prisma } from '../config/prisma';

export type TaskDeletionSafetySnapshot = {
  hasSuccessfulPayment: boolean;
  hasEscrow: boolean;
  escrowStatus: string | null;
  hasRefund: boolean;
  refundStatus: string | null;
  /** Informational only — deletion is not blocked on refund status. */
  isRefundFinal: boolean;
  hasPayout: boolean;
  payoutStatus: string | null;
  hasActiveFinancialOperation: boolean;
  safeToHardDelete: boolean;
  safeToSoftDelete: boolean;
  hasFinancialHistory: boolean;
};

const SUCCESSFUL_PAYMENT_STATUSES = new Set(['captured', 'authorized']);
const HELD_OR_SETTLED_ESCROW = new Set(['held', 'released', 'refunded']);
const FINAL_REFUND_STATUSES = new Set(['completed', 'processed', 'success', 'settled', 'credited']);
const ACTIVE_PAYOUT_STATUSES = new Set(['pending', 'processing']);

/**
 * Financial safety snapshot for task / booking deletion decisions.
 * Soft-delete eligibility does NOT depend on refund completion.
 */
export async function getTaskDeletionSafety(
  taskId: string,
  options?: { bookingOrderId?: string },
): Promise<TaskDeletionSafetySnapshot> {
  const empty: TaskDeletionSafetySnapshot = {
    hasSuccessfulPayment: false,
    hasEscrow: false,
    escrowStatus: null,
    hasRefund: false,
    refundStatus: null,
    isRefundFinal: false,
    hasPayout: false,
    payoutStatus: null,
    hasActiveFinancialOperation: false,
    safeToHardDelete: true,
    safeToSoftDelete: true,
    hasFinancialHistory: false,
  };

  if (!isPostgresConnected()) {
    throw new Error('Postgres not connected');
  }

  const trimmedTaskId = String(taskId || '').trim();
  const bookingOrderId = String(options?.bookingOrderId || '').trim();

  const escrowWhere =
    bookingOrderId.length > 0
      ? {
          OR: [{ taskId: trimmedTaskId }, { bookingOrderId }],
        }
      : { taskId: trimmedTaskId };

  const [escrows, payInTransactions, payoutsByTask, refundsByTask] = await Promise.all([
    prisma.escrow.findMany({
      where: escrowWhere,
      orderBy: { createdAt: 'desc' },
      include: {
        refunds: { orderBy: { createdAt: 'desc' }, take: 5 },
        payouts: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
    }),
    prisma.transaction.findMany({
      where: {
        taskId: trimmedTaskId,
        status: { in: ['captured', 'authorized'] },
      },
      take: 5,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.payout.findMany({
      where: {
        OR: [
          { taskId: trimmedTaskId },
          {
            metadata: {
              path: ['taskId'],
              equals: trimmedTaskId,
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.refund.findMany({
      where: { taskId: trimmedTaskId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const primaryEscrow = escrows[0] ?? null;
  const hasEscrow = escrows.length > 0;
  const escrowStatus = primaryEscrow ? String(primaryEscrow.status || '') : null;

  const paymentCapturedOnEscrow = escrows.some(
    (e) =>
      SUCCESSFUL_PAYMENT_STATUSES.has(String(e.paymentStatus || '').toLowerCase()) ||
      HELD_OR_SETTLED_ESCROW.has(String(e.status || '').toLowerCase()),
  );
  const hasSuccessfulPayment = payInTransactions.length > 0 || paymentCapturedOnEscrow;

  const refundRows = [
    ...refundsByTask,
    ...escrows.flatMap((e) => e.refunds || []),
  ];
  const hasRefund = refundRows.length > 0;
  const latestRefund = refundRows.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  const refundStatus = latestRefund ? String(latestRefund.status || '') : null;
  const isRefundFinal = Boolean(
    refundStatus && FINAL_REFUND_STATUSES.has(refundStatus.toLowerCase()),
  );

  const payoutRows = [
    ...payoutsByTask,
    ...escrows.flatMap((e) => e.payouts || []),
  ];
  // Dedupe by payoutId
  const payoutById = new Map(payoutRows.map((p) => [p.payoutId, p]));
  const uniquePayouts = [...payoutById.values()];
  const hasPayout = uniquePayouts.length > 0;
  const latestPayout = uniquePayouts.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  const payoutStatus = latestPayout ? String(latestPayout.status || '') : null;

  const hasActiveFinancialOperation =
    uniquePayouts.some((p) => ACTIVE_PAYOUT_STATUSES.has(String(p.status || '').toLowerCase())) ||
    refundRows.some((r) => String(r.status || '').toLowerCase() === 'processing') ||
    escrows.some((e) => String(e.status || '').toLowerCase() === 'held' && hasSuccessfulPayment);

  const hasFinancialHistory =
    hasEscrow || hasSuccessfulPayment || hasRefund || hasPayout;

  // Hard delete only when there is no financial footprint at all.
  const safeToHardDelete = !hasFinancialHistory;
  // Soft delete is always OK from a money-retention perspective (no refund gate).
  const safeToSoftDelete = true;

  return {
    hasSuccessfulPayment,
    hasEscrow,
    escrowStatus,
    hasRefund,
    refundStatus,
    isRefundFinal,
    hasPayout,
    payoutStatus,
    hasActiveFinancialOperation,
    safeToHardDelete,
    safeToSoftDelete,
    hasFinancialHistory,
  };
}
