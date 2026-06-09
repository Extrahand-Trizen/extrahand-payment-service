import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';

const SUCCESSFUL_ESCROW_PAYMENT_STATUSES = new Set(['held', 'released']);
const SUCCESSFUL_PAYOUT_STATUSES = new Set(['completed', 'released']);

export interface Transaction {
  id: string;
  transactionId: string;
  type: 'payment' | 'payout' | 'refund' | 'compensation' | 'fee' | 'escrow' | 'cancellation_penalty';
  amount: string;
  status: string;
  description?: string;
  date: string;
  /** Same instant as `date` — for clients that read createdAt on invoices */
  createdAt?: string;
  relatedEntityId?: string; // escrowId, payoutId, refundId, etc.
  metadata?: Record<string, any>;
  // User-friendly categorization
  category?: 'earnings' | 'payments'; // earnings = money received, payments = money spent
}

type PosterPaymentLineItem = {
  escrowId?: string;
  amount: string;
  date: string;
  paymentKind: 'initial' | 'additional';
  paymentLabel: string;
  requestId?: string | null;
};

function pickStringField(em: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = em[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Names/phones persisted on escrow metadata for invoices and history. */
function partySnapshotFromEscrowMeta(em: Record<string, unknown>): Record<string, string> {
  const performerName = pickStringField(em, [
    'performerNameSnapshot',
    'performerName',
    'taskerNameSnapshot',
    'taskerName',
    'assigneeName',
    'helperName',
  ]);
  const posterName = pickStringField(em, [
    'posterNameSnapshot',
    'posterName',
    'customerName',
    'requesterName',
  ]);
  const performerPhone = pickStringField(em, ['performerPhone', 'taskerPhone', 'assigneePhone']);
  const posterPhone = pickStringField(em, ['posterPhone', 'customerPhone', 'requesterPhone']);

  const out: Record<string, string> = {};
  if (performerName) {
    out.performerName = performerName;
    out.performerNameSnapshot = performerName;
    out.taskerName = performerName;
    out.assigneeName = performerName;
  }
  if (posterName) {
    out.posterName = posterName;
    out.posterNameSnapshot = posterName;
    out.customerName = posterName;
    out.requesterName = posterName;
  }
  if (performerPhone) {
    out.performerPhone = performerPhone;
    out.taskerPhone = performerPhone;
  }
  if (posterPhone) out.posterPhone = posterPhone;
  return out;
}

function resolveEscrowPaymentDate(escrow: { heldAt: Date | null; createdAt: Date }): string {
  return (escrow.heldAt ?? escrow.createdAt).toISOString();
}

function withTransactionTimestamps(
  row: Transaction,
  eventDate: string,
  extraMeta?: Record<string, unknown>
): Transaction {
  const metadata = {
    ...(row.metadata || {}),
    ...(extraMeta || {}),
    date: eventDate,
    transactionDate: eventDate,
    paidAt: (extraMeta as Record<string, unknown>)?.paidAt ?? eventDate,
  };
  return {
    ...row,
    date: eventDate,
    createdAt: eventDate,
    metadata,
  };
}

function resolvePosterPaymentKind(em: Record<string, unknown>): 'initial' | 'additional' {
  if (em.type === 'additional_payment' || em.paymentKind === 'additional') {
    return 'additional';
  }
  return 'initial';
}

function posterPaymentLabel(kind: 'initial' | 'additional'): string {
  return kind === 'additional'
    ? 'Additional payment (helper request)'
    : 'Original task payment';
}

function buildPosterPaymentLineItem(row: Transaction): PosterPaymentLineItem {
  const md = (row.metadata || {}) as Record<string, unknown>;
  const kind = resolvePosterPaymentKind(md);
  const amountNum = Number(row.amount);
  const amount =
    Number.isFinite(amountNum) && amountNum > 0
      ? amountNum
      : Number(md.totalPaid ?? md.amountInRupees ?? 0);
  return {
    escrowId: row.relatedEntityId,
    amount: (Number.isFinite(amount) ? amount : 0).toFixed(2),
    date: row.date,
    paymentKind: kind,
    paymentLabel:
      typeof md.paymentLabel === 'string' && md.paymentLabel.trim().length > 0
        ? md.paymentLabel.trim()
        : posterPaymentLabel(kind),
    requestId:
      typeof md.requestId === 'string' && md.requestId.trim().length > 0
        ? md.requestId.trim()
        : null,
  };
}

function sumLineItemsByKind(
  items: PosterPaymentLineItem[],
  kind: 'initial' | 'additional',
): number {
  return items
    .filter((i) => i.paymentKind === kind)
    .reduce((acc, i) => acc + Number(i.amount), 0);
}

/**
 * Counter-offer flows can create multiple escrow rows for the same task (each Razorpay order).
 * Posters should see one "payment" line per task: prefer higher lifecycle status, then newest.
 */
function dedupePosterEscrowPaymentRows(transactions: Transaction[]): Transaction[] {
  const kept: Transaction[] = [];
  const posterEscrowsByTask = new Map<string, Transaction[]>();

  for (const t of transactions) {
    const isPosterEscrow =
      t.type === 'escrow' &&
      t.category === 'payments' &&
      t.metadata &&
      typeof (t.metadata as { taskId?: unknown }).taskId === 'string' &&
      String((t.metadata as { taskId: string }).taskId).length > 0;

    if (isPosterEscrow) {
      const taskId = String((t.metadata as { taskId: string }).taskId);
      const arr = posterEscrowsByTask.get(taskId) || [];
      arr.push(t);
      posterEscrowsByTask.set(taskId, arr);
    } else {
      kept.push(t);
    }
  }

  const rankStatus = (status: string): number => {
    const s = (status || '').toLowerCase();
    if (s === 'released') return 5;
    if (s === 'held') return 4;
    if (s === 'refunded') return 3;
    if (s === 'pending') return 2;
    if (s === 'cancelled') return 0;
    return 1;
  };

  for (const [, rows] of posterEscrowsByTask) {
    if (rows.length === 1) {
      kept.push(rows[0]);
      continue;
    }
    const sorted = [...rows].sort((a, b) => {
      const dr = rankStatus(b.status) - rankStatus(a.status);
      if (dr !== 0) return dr;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
    kept.push(sorted[0]);
  }

  return kept;
}

/**
 * Get all transactions for a user
 * Combines data from:
 * - Escrows (as poster or performer)
 * - Payouts (as performer)
 * - Refunds (affecting user)
 * - Ledger entries (all financial movements)
 */
export async function getUserTransactions(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    type?: Transaction['type'];
    status?: string;
    category?: 'earnings' | 'payments' | 'all'; // Simple filter: earnings (money received) or payments (money spent)
    /** Extra profile identifiers (e.g. Mongo _id + Firebase uid) so legacy escrows still match */
    linkedUserIds?: string[];
  }
): Promise<{
  success: boolean;
  transactions?: Transaction[];
  total?: number;
  error?: string;
}> {
  try {
    const parsedLimit = Number(options?.limit ?? 50);
    const parsedOffset = Number(options?.offset ?? 0);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.floor(parsedLimit), 1), 100) : 50;
    const offset = Number.isFinite(parsedOffset) ? Math.max(Math.floor(parsedOffset), 0) : 0;
    const startDate = options?.startDate;
    const endDate = options?.endDate;
    const typeFilter = options?.type;
    const statusFilter = options?.status;
    const categoryFilter = options?.category; // New: earnings or payments filter
    const uidList = [
      ...new Set(
        [userId, ...(options?.linkedUserIds || [])].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0
        )
      ),
    ];

    logger.info(
      `[TransactionHistory] Fetching transactions for userIds ${uidList.join(',')} category: ${categoryFilter || 'all'}`
    );

    const transactions: Transaction[] = [];

    if (uidList.length === 0) {
      return { success: false, error: 'User ID is required' };
    }

    // 1. Get escrows where user is poster or performer
    // Apply database-level filtering for better performance
    const escrowWhere: Prisma.EscrowWhereInput = {
      OR: [{ posterUid: { in: uidList } }, { performerUid: { in: uidList } }],
    };

    if (startDate || endDate) {
      escrowWhere.createdAt = {};
      if (startDate) escrowWhere.createdAt.gte = startDate;
      if (endDate) escrowWhere.createdAt.lte = endDate;
    }

    if (statusFilter) {
      escrowWhere.status = statusFilter;
    }

    // Keep a small headroom for post-merge in-memory filters/dedupe without
    // allowing unbounded overfetch windows under high traffic.
    const fetchLimit = Math.min(Math.max(limit + 20, 50), 120);

    const escrows = await prisma.escrow.findMany({
      where: escrowWhere,
      include: {
        payouts: {
          where:
            categoryFilter === 'earnings'
              ? { performerUid: { in: uidList }, status: statusFilter || undefined }
              : undefined,
        },
        refunds: {
          where: statusFilter ? { status: statusFilter } : undefined,
        }
      },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      skip: offset
    });

    // Preload standalone payouts (escrowId = null) once so we can:
    // 1) render them later
    // 2) suppress duplicate performer "pending earnings" escrow rows for same task
    const standalonePayouts =
      !typeFilter || typeFilter === 'payout'
        ? await prisma.payout.findMany({
            where: {
              performerUid: { in: uidList },
              escrowId: null,
              ...(statusFilter ? { status: statusFilter } : {}),
              ...(startDate || endDate
                ? {
                    createdAt: {
                      ...(startDate ? { gte: startDate } : {}),
                      ...(endDate ? { lte: endDate } : {}),
                    },
                  }
                : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: fetchLimit,
          })
        : [];

    // Convert escrows to transactions
    // IMPORTANT: Always add all transactions with their correct category, then filter after
    escrows.forEach((escrow) => {
      const isPoster = uidList.includes(escrow.posterUid);
      const isPerformer = escrow.performerUid ? uidList.includes(escrow.performerUid) : false;
      const escrowStatusNormalized = String(escrow.status || '').trim().toLowerCase();
      const escrowMeta =
        escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
          ? (escrow.metadata as Record<string, unknown>)
          : {};
      const amountBreakdown =
        escrowMeta.amountBreakdown &&
        typeof escrowMeta.amountBreakdown === 'object' &&
        !Array.isArray(escrowMeta.amountBreakdown)
          ? (escrowMeta.amountBreakdown as Record<string, unknown>)
          : {};
      const toDecimal = (value: unknown): Prisma.Decimal | null => {
        if (value == null) return null;
        try {
          return new Prisma.Decimal(String(value));
        } catch {
          return null;
        }
      };
      const normalizePercent = (value: Prisma.Decimal | null): Prisma.Decimal | null => {
        if (!value) return null;
        const one = new Prisma.Decimal('1');
        const hundred = new Prisma.Decimal('100');
        return value.greaterThan(one) ? value.div(hundred) : value;
      };
      const totalPaid = new Prisma.Decimal(escrow.amountInRupees.toString());
      const extraCoinsDiscount =
        toDecimal(escrowMeta.pendingCustomerCoinDiscountRupees) ||
        toDecimal(escrowMeta.customerCoinDiscountRupees) ||
        toDecimal(amountBreakdown.extraCoinsDiscount) ||
        new Prisma.Decimal('0');
      const configuredPlatformPct = normalizePercent(toDecimal(escrow.appliedPlatformFeePercent));
      const configuredGstPct = normalizePercent(toDecimal(escrow.appliedGstPercent));
      const derivedTaskAmount = (() => {
        if (!configuredPlatformPct) return null;
        const gstPct = configuredGstPct || new Prisma.Decimal('0');
        const multiplier = new Prisma.Decimal('1').plus(
          configuredPlatformPct.mul(new Prisma.Decimal('1').plus(gstPct))
        );
        if (multiplier.lessThanOrEqualTo(0)) return null;
        return totalPaid.div(multiplier).toDecimalPlaces(2);
      })();
      const taskAmount =
        toDecimal((escrow as { taskAmount?: unknown }).taskAmount) ||
        toDecimal(amountBreakdown.taskAmount) ||
        toDecimal(escrowMeta.taskAmount) ||
        (extraCoinsDiscount.greaterThan(0) ? totalPaid.plus(extraCoinsDiscount).toDecimalPlaces(2) : null) ||
        derivedTaskAmount ||
        totalPaid;
      const platformFee =
        toDecimal(amountBreakdown.platformFee) ||
        toDecimal(escrowMeta.platformFee) ||
        (configuredPlatformPct ? taskAmount.mul(configuredPlatformPct).toDecimalPlaces(2) : null) ||
        new Prisma.Decimal('0');
      const gstAmount =
        toDecimal(amountBreakdown.gst) ||
        toDecimal(escrowMeta.gstAmount) ||
        toDecimal(escrowMeta.platformFeeGst) ||
        ((configuredGstPct || configuredGstPct === null) && configuredPlatformPct
          ? taskAmount.mul(configuredPlatformPct).mul(configuredGstPct || new Prisma.Decimal('0')).toDecimalPlaces(2)
          : null) ||
        new Prisma.Decimal('0');
      const feesAndTaxes = platformFee.plus(gstAmount);
      const inferredFeesAndTaxes = totalPaid.minus(taskAmount);
      const normalizedFeesAndTaxes = inferredFeesAndTaxes.greaterThan(0)
        ? inferredFeesAndTaxes
        : new Prisma.Decimal('0');
      const finalPlatformFee = feesAndTaxes.greaterThan(0)
        ? platformFee
        : normalizedFeesAndTaxes;
      const finalGst = feesAndTaxes.greaterThan(0)
        ? gstAmount
        : new Prisma.Decimal('0');
      const latestRefund = escrow.refunds
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const latestCompletedRefund = escrow.refunds
        .filter((refund) => refund.status === 'completed')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      const em = escrowMeta as Record<string, any>;
      const taskTitleSnapshot =
        typeof em.taskTitleSnapshot === 'string' && em.taskTitleSnapshot.trim().length > 0
          ? em.taskTitleSnapshot.trim()
          : typeof em.taskTitle === 'string' && em.taskTitle.trim().length > 0
            ? em.taskTitle.trim()
            : undefined;
      const taskCategorySnapshot =
        typeof em.taskCategorySnapshot === 'string' && em.taskCategorySnapshot.trim().length > 0
          ? em.taskCategorySnapshot.trim()
          : typeof escrow.taskCategory === 'string' && escrow.taskCategory.trim().length > 0
            ? escrow.taskCategory.trim()
            : typeof em.taskCategory === 'string' && em.taskCategory.trim().length > 0
              ? em.taskCategory.trim()
              : undefined;
      const taskDescriptionSnapshot =
        typeof em.taskDescription === 'string' && em.taskDescription.trim().length > 0
          ? em.taskDescription.trim()
          : undefined;

      // Escrow creation (payment) - only show if user is poster (money paid)
      // If user is performer, they'll see the payout instead
      // Default history should represent successful money movement only. When caller
      // explicitly asks for a status filter, respect it (including cancelled/pending).
      const includePosterEscrowInDefaultList =
        Boolean(statusFilter) || SUCCESSFUL_ESCROW_PAYMENT_STATUSES.has(escrowStatusNormalized);
      if (
        (!typeFilter || typeFilter === 'payment' || typeFilter === 'escrow') &&
        isPoster &&
        includePosterEscrowInDefaultList
      ) {
        const paymentKind = resolvePosterPaymentKind(em);
        const paymentLabel = posterPaymentLabel(paymentKind);
        const lineAmount = totalPaid.toString();
        const lineTaskAmount = taskAmount.toString();
        const lineCoinDiscount = extraCoinsDiscount.toDecimalPlaces(2).toString();
        const requestId =
          typeof em.requestId === 'string' && em.requestId.trim().length > 0
            ? em.requestId.trim()
            : undefined;
        const paymentEventDate = resolveEscrowPaymentDate(escrow);
        const partySnapshot = partySnapshotFromEscrowMeta(em);
        const paymentLineItems: PosterPaymentLineItem[] = [
          {
            escrowId: escrow.escrowId,
            amount: lineAmount,
            date: paymentEventDate,
            paymentKind,
            paymentLabel,
            requestId: requestId ?? null,
          },
        ];

        // Always add payment transactions when user is the poster (they paid)
        transactions.push(
          withTransactionTimestamps(
            {
              id: escrow.id,
              transactionId: escrow.escrowId,
              type: 'escrow',
              amount: escrow.amountInRupees.toString(),
              status: escrow.status,
              description: taskTitleSnapshot
                ? paymentKind === 'additional'
                  ? `Additional payment — ${
                      taskTitleSnapshot.length > 100
                        ? `${taskTitleSnapshot.slice(0, 97)}...`
                        : taskTitleSnapshot
                    }`
                  : `Original payment — ${
                      taskTitleSnapshot.length > 100
                        ? `${taskTitleSnapshot.slice(0, 97)}...`
                        : taskTitleSnapshot
                    }`
                : paymentLabel,
              date: paymentEventDate,
              relatedEntityId: escrow.escrowId,
              category: 'payments', // Money spent
              metadata: {
                taskId: escrow.taskId,
                ...(taskTitleSnapshot
                  ? {
                      taskTitle: taskTitleSnapshot,
                      taskTitleSnapshot,
                    }
                  : {}),
                ...(taskCategorySnapshot ? { taskCategory: taskCategorySnapshot, taskCategorySnapshot } : {}),
                ...(taskDescriptionSnapshot ? { taskDescription: taskDescriptionSnapshot } : {}),
                ...(typeof em.snapshotVersion === 'number' ? { snapshotVersion: em.snapshotVersion } : {}),
                ...(typeof em.capturedAt === 'string' ? { capturedAt: em.capturedAt } : {}),
                ...(em.type ? { type: em.type } : {}),
                paymentKind,
                paymentLabel,
                paymentLineItems,
                ...(paymentKind === 'initial'
                  ? { originalTaskPaymentAmount: lineAmount }
                  : { additionalPaymentAmount: lineAmount }),
                ...(requestId ? { requestId } : {}),
                ...(escrow.applicationId ? { applicationId: escrow.applicationId } : {}),
                role: 'poster',
                performerUid: escrow.performerUid,
                posterUid: escrow.posterUid,
                razorpayOrderId: escrow.razorpayOrderId,
                razorpayPaymentId: escrow.razorpayPaymentId ?? undefined,
                amountInRupees: escrow.amountInRupees.toString(),
                escrowStatus: escrow.status,
                heldAt: escrow.heldAt?.toISOString() ?? undefined,
                // Customer pays work amount only; platform fee + GST are deducted from helper payout.
                taskAmount: lineTaskAmount,
                platformFee: '0',
                gstAmount: '0',
                totalPaid: lineAmount,
                extraCoinsDiscount: lineCoinDiscount,
                extraCoinsDiscountRupees: lineCoinDiscount,
                amountBreakdown: {
                  taskAmount: lineTaskAmount,
                  platformFee: '0',
                  gst: '0',
                  extraCoinsDiscount: lineCoinDiscount,
                  totalPaid: lineAmount,
                },
                refundedAmount: latestCompletedRefund?.refundAmount?.toString() || '0',
                latestRefundAmount: latestRefund?.refundAmount?.toString() || '0',
                latestRefundStatus: latestRefund?.status || null,
                latestCancellationFee: latestRefund?.cancellationFee?.toString() || '0',
                latestCancelledBy: latestRefund?.cancelledBy || null,
                appliedPlatformFeePercent: configuredPlatformPct?.toString() || null,
                appliedGstPercent: configuredGstPct?.toString() || null,
                ...partySnapshot,
              },
            },
            paymentEventDate,
            {
              paidAt: escrow.heldAt?.toISOString() ?? paymentEventDate,
              heldAt: escrow.heldAt?.toISOString(),
            }
          )
        );
      }

      // Payouts from this escrow (money earned) — only real payout records are shown.
      escrow.payouts.forEach((payout) => {
        if ((!typeFilter || typeFilter === 'payout') && uidList.includes(payout.performerUid)) {
          // Always add payout transactions when user is the performer (they earned)
          
          // Extract penalty information from payout metadata
          const payoutRawMeta = (payout as { metadata?: unknown }).metadata;
          const payoutMetadata =
            payoutRawMeta && typeof payoutRawMeta === 'object' && !Array.isArray(payoutRawMeta)
              ? (payoutRawMeta as Record<string, any>)
              : {};
          const penaltyDeducted = payoutMetadata.penaltyDeducted || '0.00';
          const penaltyLines = Array.isArray(payoutMetadata.penaltyLines) ? payoutMetadata.penaltyLines : [];
          
          const payoutDate = (payout.completedAt ?? payout.createdAt).toISOString();
          const partySnapshotPayout = partySnapshotFromEscrowMeta(em);
          transactions.push(
            withTransactionTimestamps(
              {
                id: payout.id,
                transactionId: payout.payoutId,
                type: 'payout',
                amount: payout.netAmount.toString(),
                status: payout.status,
                description: taskTitleSnapshot
                  ? `Money received — ${taskTitleSnapshot.length > 100 ? `${taskTitleSnapshot.slice(0, 97)}...` : taskTitleSnapshot}`
                  : `Money received from task ${escrow.taskId}`,
                date: payoutDate,
                relatedEntityId: payout.escrowId || undefined,
                category: 'earnings', // Money received
                metadata: {
                  taskId: escrow.taskId,
                  ...(taskTitleSnapshot
                    ? {
                        taskTitle: taskTitleSnapshot,
                        taskTitleSnapshot,
                      }
                    : {}),
                  ...(taskCategorySnapshot
                    ? { taskCategory: taskCategorySnapshot, taskCategorySnapshot }
                    : {}),
                  ...(taskDescriptionSnapshot ? { taskDescription: taskDescriptionSnapshot } : {}),
                  taskAmount: payout.amount.toString(),
                  totalPaid: payout.amount.toString(),
                  grossAmount: payout.amount.toString(),
                  platformFee: payout.platformCommission.toString(),
                  platformFeeGst: payout.gstOnCommission.toString(),
                  gstAmount: payout.gstOnCommission.toString(),
                  platformCommission: payout.platformCommission.toString(),
                  gstOnCommission: payout.gstOnCommission.toString(),
                  tds: payout.tds?.toString() || '0',
                  netAmount: payout.netAmount.toString(),
                  amountBreakdown: {
                    taskAmount: payout.amount.toString(),
                    platformFee: payout.platformCommission.toString(),
                    gst: payout.gstOnCommission.toString(),
                    totalDeductions: payout.platformCommission
                      .add(payout.gstOnCommission)
                      .add(payout.tds || 0)
                      .toString(),
                    netAmount: payout.netAmount.toString(),
                  },
                  penaltyDeducted: penaltyDeducted,
                  penaltyLines: penaltyLines,
                  penaltiesAppliedAt: payoutMetadata.penaltiesAppliedAt || null,
                  posterUid: escrow.posterUid,
                  performerUid: escrow.performerUid,
                  role: 'performer',
                  ...partySnapshotPayout,
                },
              },
              payoutDate
            )
          );
        }
      });

      // Refunds from this escrow
      escrow.refunds.forEach((refund) => {
        if (!typeFilter || typeFilter === 'refund' || typeFilter === 'compensation') {
          // Any refund credited to the poster (regardless of who cancelled the task)
          const isPosterRefund = uidList.includes(escrow.posterUid);
          const isPerformerCompensation =
            Boolean(escrow.performerUid) &&
            uidList.includes(escrow.performerUid!) &&
            refund.cancelledBy === 'poster' &&
            refund.toOtherParty;

          if (isPosterRefund) {
            // Poster gets refund (money back) - this is a payment-related transaction
            transactions.push({
              id: refund.id,
              transactionId: refund.refundId,
              type: 'refund',
              amount: refund.refundAmount.toString(),
              status: refund.status,
              description: taskTitleSnapshot
                ? `Refund — ${taskTitleSnapshot.length > 100 ? `${taskTitleSnapshot.slice(0, 97)}...` : taskTitleSnapshot}`
                : `Money returned for cancelled task ${escrow.taskId}`,
              date: refund.createdAt.toISOString(),
              relatedEntityId: refund.escrowId || undefined,
              category: 'payments', // Money returned (related to payment)
              metadata: {
                taskId: escrow.taskId,
                ...(taskTitleSnapshot
                  ? {
                      taskTitle: taskTitleSnapshot,
                      taskTitleSnapshot,
                    }
                  : {}),
                ...(taskCategorySnapshot
                  ? { taskCategory: taskCategorySnapshot, taskCategorySnapshot }
                  : {}),
                ...(taskDescriptionSnapshot ? { taskDescription: taskDescriptionSnapshot } : {}),
                cancellationFee: refund.cancellationFee?.toString() || '0',
                refundAmount: refund.refundAmount.toString(),
                toOtherParty: refund.toOtherParty?.toString() || '0',
                toPlatform: refund.toPlatform?.toString() || '0',
                cancelledBy: refund.cancelledBy,
                reason: refund.reason,
                originalAmount: escrow.amountInRupees.toString(),
                taskAmount: taskAmount.toString(),
                platformFee: finalPlatformFee.toString(),
                gstAmount: finalGst.toString(),
                totalPaid: totalPaid.toString(),
              }
            });
          } else if (isPerformerCompensation) {
            // Performer gets compensation (money earned) - this is an earnings transaction
            transactions.push({
              id: refund.id,
              transactionId: refund.refundId,
              type: 'compensation',
              amount: (refund.toOtherParty?.toString() || '0'),
              status: refund.status,
              description: taskTitleSnapshot
                ? `Compensation — ${taskTitleSnapshot.length > 100 ? `${taskTitleSnapshot.slice(0, 97)}...` : taskTitleSnapshot}`
                : `Money from cancelled task ${escrow.taskId}`,
              date: refund.createdAt.toISOString(),
              relatedEntityId: refund.escrowId || undefined,
              category: 'earnings', // Money received
              metadata: {
                taskId: escrow.taskId,
                ...(taskTitleSnapshot
                  ? {
                      taskTitle: taskTitleSnapshot,
                      taskTitleSnapshot,
                    }
                  : {}),
                ...(taskCategorySnapshot
                  ? { taskCategory: taskCategorySnapshot, taskCategorySnapshot }
                  : {}),
                ...(taskDescriptionSnapshot ? { taskDescription: taskDescriptionSnapshot } : {}),
                cancellationFee: refund.cancellationFee?.toString() || '0',
                refundAmount: refund.refundAmount.toString(),
                toOtherParty: refund.toOtherParty?.toString() || '0',
                toPlatform: refund.toPlatform?.toString() || '0',
                cancelledBy: refund.cancelledBy,
                reason: refund.reason
              }
            });
          }
        }
      });
    });

    // Tasker cancellation penalties — optional DB features must not break core history
    if (!typeFilter || typeFilter === 'cancellation_penalty') {
      try {
        const penalties = await prisma.performerCancellationPenalty.findMany({
          where: {
            performerUid: { in: uidList },
            status: 'pending',
            remainingAmount: { gt: new Prisma.Decimal(0) },
          },
          orderBy: { createdAt: 'desc' },
          take: fetchLimit,
        });

        penalties.forEach((pen: (typeof penalties)[number]) => {
          transactions.push({
            id: pen.id,
            transactionId: pen.penaltyId,
            type: 'cancellation_penalty',
            amount: pen.remainingAmount.toString(),
            status: 'pending',
            description: pen.taskTitle
              ? `Cancellation penalty — ${pen.taskTitle}`
              : `Cancellation penalty for task ${pen.taskId}`,
            date: pen.cancelledAt.toISOString(),
            relatedEntityId: pen.penaltyId,
            category: 'payments',
            metadata: {
              taskId: pen.taskId,
              taskTitle: pen.taskTitle,
              penaltyId: pen.penaltyId,
              originalPenaltyAmount: pen.amount.toString(),
              remainingAmount: pen.remainingAmount.toString(),
              feePercentage: pen.feePercentage?.toString(),
              reason: pen.reason,
              escrowStatus: 'pending_penalty',
            },
          });
        });
      } catch (penErr: any) {
        logger.warn('[TransactionHistory] Skipping cancellation_penalty rows', {
          message: penErr?.message,
        });
      }
    }

    // Include payouts that are not linked to an escrow (RazorpayX-only flow)
    if (!typeFilter || typeFilter === 'payout') {
      try {
        standalonePayouts.forEach((payout) => {
          const payoutStandaloneMeta = (payout as { metadata?: unknown }).metadata;
          const pm =
            payoutStandaloneMeta &&
            typeof payoutStandaloneMeta === 'object' &&
            !Array.isArray(payoutStandaloneMeta)
              ? (payoutStandaloneMeta as Record<string, unknown>)
              : {};
          const penaltyDeducted =
            typeof pm.penaltyDeducted === 'string'
              ? Number.parseFloat(pm.penaltyDeducted)
              : typeof pm.penaltyDeducted === 'number'
              ? pm.penaltyDeducted
              : 0;
          const grossFromPenalty = Number.isFinite(penaltyDeducted) && penaltyDeducted > 0
            ? new Prisma.Decimal(payout.netAmount.toString()).add(new Prisma.Decimal(penaltyDeducted.toString())).toString()
            : payout.amount.toString();
          transactions.push({
            id: payout.id,
            transactionId: payout.payoutId,
            type: 'payout',
            amount: payout.netAmount.toString(),
            status: payout.status,
            description: payout.description || 'Task payout credited',
            date: payout.createdAt.toISOString(),
            relatedEntityId: payout.payoutId,
            category: 'earnings',
            metadata: {
              taskAmount: grossFromPenalty,
              totalPaid: grossFromPenalty,
              grossAmount: grossFromPenalty,
              platformFee: payout.platformCommission.toString(),
              platformFeeGst: payout.gstOnCommission.toString(),
              gstAmount: payout.gstOnCommission.toString(),
              platformCommission: payout.platformCommission.toString(),
              gstOnCommission: payout.gstOnCommission.toString(),
              tds: payout.tds?.toString() || '0',
              netAmount: payout.netAmount.toString(),
              amountBreakdown: {
                taskAmount: grossFromPenalty,
                platformFee: payout.platformCommission.toString(),
                gst: payout.gstOnCommission.toString(),
                totalDeductions: payout.platformCommission
                  .add(payout.gstOnCommission)
                  .add(payout.tds || 0)
                  .toString(),
                netAmount: payout.netAmount.toString(),
              },
              ...pm,
            },
          });
        });
      } catch (payoutErr: any) {
        logger.warn('[TransactionHistory] Skipping standalone payout rows', {
          message: payoutErr?.message,
        });
      }
    }

    // 2. Fees are now hidden - they're already deducted in netAmount
    // Individual fee entries are not shown to keep the UI clean
    // Fees are included in the payout metadata for detailed breakdown when needed

    const dedupedTransactions = dedupePosterEscrowPaymentRows(transactions);

    // 3. Sort all transactions by date (newest first)
    dedupedTransactions.sort((a, b) => {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    // 4. Apply filters if specified (in-memory filtering for category/type)
    // Note: Category and type filters are complex (depend on user role) so we filter in memory
    // But we've already applied status filter at database level where possible
    let filteredTransactions = dedupedTransactions;

    logger.debug(`[TransactionHistory] Total transactions before filtering: ${filteredTransactions.length}`);
    
    // Apply category filter (earnings/payments) - in memory due to complexity
    if (categoryFilter && categoryFilter !== 'all') {
      const beforeCount = filteredTransactions.length;
      filteredTransactions = filteredTransactions.filter(t => {
        if (!t.category) {
          logger.warn(`[TransactionHistory] Transaction ${t.id} missing category, skipping from filter`);
          return false;
        }
        return t.category === categoryFilter;
      });
      
      logger.info(`[TransactionHistory] Category filter '${categoryFilter}' applied: ${beforeCount} -> ${filteredTransactions.length} transactions`);
    }
    
    // Apply type filter (in memory)
    if (typeFilter) {
      filteredTransactions = filteredTransactions.filter(t => t.type === typeFilter);
    }
    
    // Status filter already applied at database level, but double-check in case of edge cases
    if (statusFilter) {
      filteredTransactions = filteredTransactions.filter(t => t.status === statusFilter);
    }

    // 5. Get total count for pagination (before slicing)
    const total = filteredTransactions.length;

    // 6. Apply pagination on final filtered rows.
    const paginatedTransactions = filteredTransactions.slice(offset, offset + limit);

    logger.info(`[TransactionHistory] Returning ${paginatedTransactions.length} transactions (total: ${total}) after pagination`);

    return {
      success: true,
      transactions: paginatedTransactions,
      total
    };
  } catch (error: any) {
    logger.error('Error fetching user transactions:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch transactions'
    };
  }
}

/**
 * Get transaction summary for a user
 */
export async function getTransactionSummary(
  userId: string,
  startDate?: Date,
  endDate?: Date,
  linkedUserIds?: string[]
): Promise<{
  success: boolean;
  summary?: {
    totalPayments: string;
    totalPayouts: string;
    totalRefunds: string;
    totalCompensation: string;
    totalFees: string;
    totalSpent: string;
    netEarnings: string;
    transactionCount: number;
  };
  error?: string;
}> {
  try {
    const uidList = [
      ...new Set(
        [userId, ...(linkedUserIds || [])].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0
        )
      ),
    ];

    const escrowWhere: Prisma.EscrowWhereInput = {
      posterUid: { in: uidList },
      status: { in: Array.from(SUCCESSFUL_ESCROW_PAYMENT_STATUSES) },
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    const payoutWhere: Prisma.PayoutWhereInput = {
      performerUid: { in: uidList },
      status: { in: Array.from(SUCCESSFUL_PAYOUT_STATUSES) },
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    const refundWhere: Prisma.RefundWhereInput = {
      status: 'completed',
      escrow: {
        OR: [{ posterUid: { in: uidList } }, { performerUid: { in: uidList } }],
      },
      ...(startDate || endDate
        ? {
            createdAt: {
              ...(startDate ? { gte: startDate } : {}),
              ...(endDate ? { lte: endDate } : {}),
            },
          }
        : {}),
    };

    const [payoutsAgg, refundsAgg, compensationAgg] = await Promise.all([
      prisma.payout.aggregate({
        where: payoutWhere,
        _sum: { netAmount: true },
        _count: { id: true },
      }),
      prisma.refund.aggregate({
        where: {
          ...refundWhere,
          escrow: { posterUid: { in: uidList } },
        },
        _sum: { refundAmount: true },
        _count: { id: true },
      }),
      prisma.refund.aggregate({
        where: {
          ...refundWhere,
          cancelledBy: 'poster',
          toOtherParty: { not: null },
          escrow: { performerUid: { in: uidList } },
        },
        _sum: { toOtherParty: true },
        _count: { id: true },
      }),
    ]);

    // One logical "payment" per task for posters (matches dedupe in getUserTransactions).
    const posterEscrowsLatest = await prisma.escrow.findMany({
      where: escrowWhere,
      select: { taskId: true, amountInRupees: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const seenPaymentTask = new Set<string>();
    let totalPayments = new Prisma.Decimal('0');
    let paymentEscrowCount = 0;
    for (const row of posterEscrowsLatest) {
      if (seenPaymentTask.has(row.taskId)) continue;
      seenPaymentTask.add(row.taskId);
      totalPayments = totalPayments.add(row.amountInRupees);
      paymentEscrowCount += 1;
    }

    const totalPayouts = payoutsAgg._sum.netAmount || new Prisma.Decimal('0');
    const totalRefunds = refundsAgg._sum.refundAmount || new Prisma.Decimal('0');
    const totalCompensation = compensationAgg._sum.toOtherParty || new Prisma.Decimal('0');
    const totalFees = new Prisma.Decimal('0');
    const transactionCount =
      paymentEscrowCount +
      (payoutsAgg._count.id || 0) +
      (refundsAgg._count.id || 0) +
      (compensationAgg._count.id || 0);

    // Net earnings = payouts + compensation - fees
    const netEarnings = totalPayouts.plus(totalCompensation).minus(totalFees);

    // Net spent = payments minus completed refunds (so cancelled payments show ₹0)
    const totalSpent = Prisma.Decimal.max(
      new Prisma.Decimal('0'),
      totalPayments.minus(totalRefunds),
    );

    return {
      success: true,
      summary: {
        totalPayments: totalPayments.toString(),
        totalPayouts: totalPayouts.toString(),
        totalRefunds: totalRefunds.toString(),
        totalCompensation: totalCompensation.toString(),
        totalFees: totalFees.toString(),
        totalSpent: totalSpent.toString(),
        netEarnings: netEarnings.toString(),
        transactionCount
      }
    };
  } catch (error: any) {
    logger.error('Error calculating transaction summary:', error);
    return {
      success: false,
      error: error.message || 'Failed to calculate transaction summary'
    };
  }
}

