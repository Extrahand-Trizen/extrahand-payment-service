import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { getExtraCoinsWallet } from './extraCoinsService';
import { getTransactionSummary, getUserTransactions } from './transactionHistoryService';
import { razorpay } from '../config/razorpay';
import crypto from 'crypto';
import { getFeeStructure, listCategoryFeeConfigs, upsertCategoryFeeConfig } from './feeConfigService';

type DateRange = { from?: Date; to?: Date };

function buildCreatedAtFilter(range: DateRange): { gte?: Date; lte?: Date } | undefined {
  const filter: { gte?: Date; lte?: Date } = {};
  if (range.from) filter.gte = range.from;
  if (range.to) filter.lte = range.to;
  return Object.keys(filter).length > 0 ? filter : undefined;
}

function decimalToString(value: Prisma.Decimal | null | undefined): string {
  return (value || new Prisma.Decimal(0)).toString();
}

export async function getDashboardOverview(range: DateRange) {
  const createdAt = buildCreatedAtFilter(range);

  // Filter clause to exclude team-test escrows (used for pay-in metrics and counts)
  const realEscrowWhere = {
    ...(createdAt ? { createdAt } : {}),
    NOT: {
      metadata: {
        path: ['teamTest'],
        equals: true,
      },
    },
  };

  // Filter clause to exclude team-test payouts (payout metadata.teamTest)
  const realPayoutWhere = {
    ...(createdAt ? { createdAt } : {}),
    NOT: {
      metadata: {
        path: ['teamTest'],
        equals: true,
      },
    },
  };

  // Refunds are linked to escrows — exclude refunds whose escrow is a team test
  const realRefundWhere = {
    ...(createdAt ? { createdAt } : {}),
    status: 'completed',
    escrow: {
      NOT: {
        metadata: {
          path: ['teamTest'],
          equals: true,
        },
      },
    },
  };

  // Ledger revenue: exclude entries linked to team-test escrows
  const realLedgerWhere = {
    ...(createdAt ? { createdAt } : {}),
    type: 'platform_commission',
    escrow: {
      NOT: {
        metadata: {
          path: ['teamTest'],
          equals: true,
        },
      },
    },
  };

  const [
    escrowAgg,
    payoutAgg,
    refundAgg,
    ledgerRevenueAgg,
    paymentSuccessCount,
    paymentFailedCount,
    payoutSuccessCount,
    payoutFailedCount,
  ] = await Promise.all([
    prisma.escrow.aggregate({
      where: realEscrowWhere,
      _sum: { amountInRupees: true },
      _count: { id: true },
    }),
    prisma.payout.aggregate({
      where: realPayoutWhere,
      _sum: { netAmount: true },
      _count: { id: true },
    }),
    prisma.refund.aggregate({
      where: realRefundWhere,
      _sum: { refundAmount: true },
      _count: { id: true },
    }),
    prisma.ledger.aggregate({
      where: realLedgerWhere,
      _sum: { amount: true },
    }),
    // Payment success/fail counts: only real escrows
    prisma.escrow.count({
      where: { ...realEscrowWhere, paymentStatus: 'captured' },
    }),
    prisma.escrow.count({
      where: { ...realEscrowWhere, paymentStatus: 'failed' },
    }),
    // Payout success/fail counts: only real payouts
    prisma.payout.count({
      where: { ...realPayoutWhere, status: 'completed' },
    }),
    prisma.payout.count({
      where: { ...realPayoutWhere, status: 'failed' },
    }),
  ]);

  const paymentTotal = paymentSuccessCount + paymentFailedCount;
  const payoutTotal = payoutSuccessCount + payoutFailedCount;

  return {
    gmv: decimalToString(escrowAgg._sum.amountInRupees),
    totalPayins: escrowAgg._count.id,
    totalPayouts: decimalToString(payoutAgg._sum.netAmount),
    payoutCount: payoutAgg._count.id,
    totalRefunds: decimalToString(refundAgg._sum.refundAmount),
    refundCount: refundAgg._count.id,
    revenue: decimalToString(ledgerRevenueAgg._sum.amount),
    paymentSuccessRate: paymentTotal > 0 ? Number(((paymentSuccessCount / paymentTotal) * 100).toFixed(2)) : 0,
    payoutSuccessRate: payoutTotal > 0 ? Number(((payoutSuccessCount / payoutTotal) * 100).toFixed(2)) : 0,
  };
}

export async function getDashboardPayouts(params: {
  status?: string;
  performerUid?: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}) {
  const createdAt = buildCreatedAtFilter({ from: params.from, to: params.to });
  const where: any = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.performerUid ? { performerUid: params.performerUid } : {}),
    ...(params.source ? { source: params.source } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.payout.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      skip: params.offset,
    }),
    prisma.payout.count({ where }),
  ]);

  return { items, total };
}

export async function getDashboardRefunds(params: {
  status?: string;
  cancelledBy?: string;
  taskId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}) {
  const createdAt = buildCreatedAtFilter({ from: params.from, to: params.to });
  const where: any = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.cancelledBy ? { cancelledBy: params.cancelledBy } : {}),
    ...(params.taskId ? { escrow: { taskId: params.taskId } } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.refund.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      skip: params.offset,
      include: { escrow: true }, // needed to read Escrow.metadata.teamTest (mirrors pay-ins approach)
    }),
    prisma.refund.count({ where }),
  ]);

  // Expose teamTest from the linked Escrow's metadata (same as transactions/pay-ins)
  const itemsWithTeamTest = items.map((item: any) => {
    const escrowMeta =
      item.escrow?.metadata && typeof item.escrow.metadata === 'object'
        ? (item.escrow.metadata as Record<string, unknown>)
        : {};
    return {
      ...item,
      teamTest: escrowMeta.teamTest === true,
    };
  });

  return { items: itemsWithTeamTest, total };
}

export async function getDashboardLedger(params: {
  userId?: string;
  taskId?: string;
  type?: string;
  direction?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}) {
  const createdAt = buildCreatedAtFilter({ from: params.from, to: params.to });
  const where: any = {
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.type ? { type: params.type } : {}),
    ...(params.direction ? { direction: params.direction } : {}),
    ...(createdAt ? { createdAt } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.ledger.findMany({
      where,
      include: {
        escrow: true,
        payout: {
          include: {
            escrow: true,
          },
        },
        refund: {
          include: {
            escrow: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit,
      skip: params.offset,
    }),
    prisma.ledger.count({ where }),
  ]);

  const mappedItems = items.map((row: any) => {
    const CustomerUid =
      row.escrow?.posterUid ||
      row.payout?.escrow?.posterUid ||
      row.refund?.escrow?.posterUid ||
      row.userId ||
      null;

    const performerUid =
      row.escrow?.performerUid ||
      row.payout?.performerUid ||
      row.payout?.escrow?.performerUid ||
      row.refund?.escrow?.performerUid ||
      null;

    const taskId =
      row.taskId ||
      row.escrow?.taskId ||
      row.payout?.taskId ||
      row.payout?.escrow?.taskId ||
      row.refund?.taskId ||
      row.refund?.escrow?.taskId ||
      null;

    const { escrow, payout, refund, ...rest } = row;

    return {
      ...rest,
      CustomerUid,
      performerUid,
      taskId,
    };
  });

  return { items: mappedItems, total };
}

export async function getDashboardAnomalies() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [failedPayoutsNoRetry, pendingJobQueuePayouts, escrowsHeldTooLong, paymentsWithoutEscrow] = await Promise.all([
    prisma.payout.findMany({
      where: {
        status: 'failed',
        createdAt: { lte: oneDayAgo },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.jobQueue.findMany({
      where: {
        jobType: 'task_completion_payout',
        status: { in: ['pending', 'processing'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.escrow.findMany({
      where: {
        status: 'held',
        heldAt: { lte: sevenDaysAgo },
      },
      orderBy: { heldAt: 'asc' },
      take: 100,
    }),
    prisma.ledger.findMany({
      where: {
        type: 'payment',
        escrowId: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
  ]);

  return {
    counts: {
      failedPayoutsNoRetry: failedPayoutsNoRetry.length,
      pendingJobQueuePayouts: pendingJobQueuePayouts.length,
      escrowsHeldTooLong: escrowsHeldTooLong.length,
      paymentsWithoutEscrow: paymentsWithoutEscrow.length,
    },
    failedPayoutsNoRetry,
    pendingJobQueuePayouts,
    escrowsHeldTooLong,
    paymentsWithoutEscrow,
  };
}

export async function getDashboardTransactions(params: {
  userId: string;
  linkedUserIds?: string[];
  from?: Date;
  to?: Date;
  type?: 'payment' | 'payout' | 'refund' | 'compensation' | 'fee' | 'escrow' | 'cancellation_penalty';
  status?: string;
  category?: 'earnings' | 'payments' | 'all';
  limit: number;
  offset: number;
}) {
  const result = await getUserTransactions(params.userId, {
    linkedUserIds: params.linkedUserIds,
    startDate: params.from,
    endDate: params.to,
    type: params.type,
    status: params.status,
    category: params.category,
    limit: params.limit,
    offset: params.offset,
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to fetch transactions');
  }

  return { items: result.transactions || [], total: result.total || 0 };
}

export async function getDashboardTransactionTrace(transactionRef: string) {
  const [escrow, payout, refund, ledgerRows] = await Promise.all([
    prisma.escrow.findFirst({
      where: {
        OR: [
          { escrowId: transactionRef },
          { razorpayOrderId: transactionRef },
          { razorpayPaymentId: transactionRef },
        ],
      },
      include: {
        payouts: true,
        refunds: true,
        ledger: { orderBy: { createdAt: 'asc' } },
      },
    }),
    prisma.payout.findFirst({
      where: {
        OR: [{ payoutId: transactionRef }, { bankTransferId: transactionRef }],
      },
    }),
    prisma.refund.findFirst({
      where: {
        OR: [{ refundId: transactionRef }, { paymentId: transactionRef }, { razorpayRefundId: transactionRef }],
      },
    }),
    prisma.ledger.findMany({
      where: {
        OR: [
          { transactionId: transactionRef },
          { razorpayPaymentId: transactionRef },
        ],
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const resolvedEscrow =
    escrow ||
    (payout?.escrowId
      ? await prisma.escrow.findUnique({
          where: { id: payout.escrowId },
          include: { payouts: true, refunds: true, ledger: { orderBy: { createdAt: 'asc' } } },
        })
      : refund?.escrowId
      ? await prisma.escrow.findUnique({
          where: { id: refund.escrowId },
          include: { payouts: true, refunds: true, ledger: { orderBy: { createdAt: 'asc' } } },
        })
      : null);

  const inferredPayout =
    payout ||
    (resolvedEscrow?.payouts.find((p) => p.payoutId === transactionRef || p.bankTransferId === transactionRef) ?? null) ||
    null;
  const inferredRefund =
    refund ||
    (resolvedEscrow?.refunds.find((r) => r.refundId === transactionRef || r.paymentId === transactionRef || r.razorpayRefundId === transactionRef) ??
      null) ||
    null;

  return {
    transactionRef,
    escrow: resolvedEscrow,
    payout: inferredPayout,
    refund: inferredRefund,
    ledger: resolvedEscrow?.ledger?.length ? resolvedEscrow.ledger : ledgerRows,
  };
}

export async function getDashboardUserFinancial(userId: string, linkedUserIds?: string[]) {
  const linked = (linkedUserIds || []).filter((u) => !!u && u !== userId);
  const [profile, summary, wallet, recentPayouts, recentRefunds, bankAccounts] = await Promise.all([
    prisma.userPaymentProfile.findUnique({ where: { userId } }),
    getTransactionSummary(userId, undefined, undefined, linked),
    getExtraCoinsWallet(userId),
    prisma.payout.findMany({
      where: { performerUid: { in: [userId, ...linked] } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.refund.findMany({
      where: {
        escrow: {
          OR: [{ posterUid: { in: [userId, ...linked] } }, { performerUid: { in: [userId, ...linked] } }],
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.bankAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    }),
  ]);

  return {
    userId,
    linkedUserIds: linked,
    profile,
    summary: summary.success ? summary.summary : null,
    wallet: wallet.success ? wallet.wallet : null,
    recentPayouts,
    recentRefunds,
    bankAccounts,
  };
}

export async function getDashboardReconciliation(params: { from: Date; to: Date }) {
  if (params.to < params.from) {
    throw new Error('Invalid date range: "to" must be after "from"');
  }

  const fromEpoch = Math.floor(params.from.getTime() / 1000);
  const toEpoch = Math.floor(params.to.getTime() / 1000);

  // Pull Razorpay payments in pages (max 100/page in Razorpay API)
  const razorpayPayments: any[] = [];
  let skip = 0;
  const pageSize = 100;
  while (true) {
    const page = await (razorpay.payments as any).all({
      from: fromEpoch,
      to: toEpoch,
      count: pageSize,
      skip,
    });
    const items: any[] = page?.items || [];
    razorpayPayments.push(...items);
    if (items.length < pageSize) break;
    skip += pageSize;
  }

  const relevantRazorpay = razorpayPayments.filter((p) => p?.status === 'captured');
  const razorpayPaymentIds = relevantRazorpay
    .map((p) => p.id as string)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const localEscrows = razorpayPaymentIds.length
    ? await prisma.escrow.findMany({
        where: {
          razorpayPaymentId: { in: razorpayPaymentIds },
        },
      })
    : [];

  const localByPaymentId = new Map<string, (typeof localEscrows)[number]>();
  localEscrows.forEach((e) => {
    if (e.razorpayPaymentId) localByPaymentId.set(e.razorpayPaymentId, e);
  });

  const missingInDb: Array<{ razorpayPaymentId: string; razorpayOrderId?: string; amountPaise: number; capturedAt?: number }> = [];
  const amountMismatches: Array<{
    razorpayPaymentId: string;
    localEscrowId: string;
    razorpayAmountPaise: number;
    localAmountPaise: number;
    differencePaise: number;
  }> = [];
  const statusMismatches: Array<{
    razorpayPaymentId: string;
    localEscrowId: string;
    razorpayStatus: string;
    localEscrowStatus: string;
    localPaymentStatus: string | null;
  }> = [];

  let razorpayCapturedTotalPaise = 0;
  let localMatchedTotalPaise = 0;

  for (const payment of relevantRazorpay) {
    const paymentId = payment.id as string;
    const rpAmountPaise = Number(payment.amount || 0);
    razorpayCapturedTotalPaise += rpAmountPaise;

    const local = localByPaymentId.get(paymentId);
    if (!local) {
      missingInDb.push({
        razorpayPaymentId: paymentId,
        razorpayOrderId: payment.order_id as string | undefined,
        amountPaise: rpAmountPaise,
        capturedAt: payment.created_at as number | undefined,
      });
      continue;
    }

    const localAmountPaise = Number(local.amount);
    localMatchedTotalPaise += localAmountPaise;
    if (localAmountPaise !== rpAmountPaise) {
      amountMismatches.push({
        razorpayPaymentId: paymentId,
        localEscrowId: local.escrowId,
        razorpayAmountPaise: rpAmountPaise,
        localAmountPaise,
        differencePaise: rpAmountPaise - localAmountPaise,
      });
    }

    const localLooksCaptured = local.paymentStatus === 'captured' || local.status === 'held' || local.status === 'released' || local.status === 'refunded';
    if (!localLooksCaptured) {
      statusMismatches.push({
        razorpayPaymentId: paymentId,
        localEscrowId: local.escrowId,
        razorpayStatus: String(payment.status || 'unknown'),
        localEscrowStatus: local.status,
        localPaymentStatus: local.paymentStatus || null,
      });
    }
  }

  const inDbNotInRazorpay = localEscrows
    .filter((e) => e.razorpayPaymentId && !razorpayPaymentIds.includes(e.razorpayPaymentId))
    .map((e) => ({
      localEscrowId: e.escrowId,
      razorpayPaymentId: e.razorpayPaymentId!,
      amountPaise: Number(e.amount),
      status: e.status,
      paymentStatus: e.paymentStatus || null,
    }));

  const mismatchAmountPaise =
    missingInDb.reduce((acc, item) => acc + item.amountPaise, 0) +
    amountMismatches.reduce((acc, item) => acc + Math.abs(item.differencePaise), 0);

  return {
    mode: 'payments',
    range: {
      from: params.from.toISOString(),
      to: params.to.toISOString(),
    },
    summary: {
      razorpayCapturedCount: relevantRazorpay.length,
      localMatchedCount: localEscrows.length,
      razorpayCapturedTotalPaise,
      localMatchedTotalPaise,
      totalDifferencePaise: razorpayCapturedTotalPaise - localMatchedTotalPaise,
      mismatchAmountPaise,
      mismatchCount:
        missingInDb.length + amountMismatches.length + statusMismatches.length + inDbNotInRazorpay.length,
    },
    mismatches: {
      missingInDb,
      amountMismatches,
      statusMismatches,
      inDbNotInRazorpay,
    },
  };
}

function paginateArray<T>(arr: T[], page: number, limit: number) {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const safePage = Math.max(page, 1);
  const start = (safePage - 1) * safeLimit;
  const end = start + safeLimit;
  return {
    items: arr.slice(start, end),
    page: safePage,
    limit: safeLimit,
    total: arr.length,
    totalPages: Math.max(Math.ceil(arr.length / safeLimit), 1),
  };
}

async function fetchRazorpayPayments(fromEpoch: number, toEpoch: number) {
  const razorpayPayments: any[] = [];
  let skip = 0;
  const pageSize = 100;
  while (true) {
    const page = await (razorpay.payments as any).all({
      from: fromEpoch,
      to: toEpoch,
      count: pageSize,
      skip,
    });
    const items: any[] = page?.items || [];
    razorpayPayments.push(...items);
    if (items.length < pageSize) break;
    skip += pageSize;
  }
  return razorpayPayments;
}

async function fetchRazorpayOrders(fromEpoch: number, toEpoch: number) {
  const razorpayOrders: any[] = [];
  let skip = 0;
  const pageSize = 100;
  while (true) {
    const page = await (razorpay.orders as any).all({
      from: fromEpoch,
      to: toEpoch,
      count: pageSize,
      skip,
    });
    const items: any[] = page?.items || [];
    razorpayOrders.push(...items);
    if (items.length < pageSize) break;
    skip += pageSize;
  }
  return razorpayOrders;
}

export async function getDashboardReconciliationV2(params: {
  from: Date;
  to: Date;
  mode: 'payments' | 'orders';
  page: number;
  limit: number;
}) {
  if (params.to < params.from) {
    throw new Error('Invalid date range: "to" must be after "from"');
  }

  const fromEpoch = Math.floor(params.from.getTime() / 1000);
  const toEpoch = Math.floor(params.to.getTime() / 1000);

  if (params.mode === 'orders') {
    const razorpayOrders = await fetchRazorpayOrders(fromEpoch, toEpoch);
    const orderIds = razorpayOrders
      .map((o) => o.id as string)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const localEscrows = orderIds.length
      ? await prisma.escrow.findMany({
          where: { razorpayOrderId: { in: orderIds } },
        })
      : [];
    const localByOrderId = new Map<string, (typeof localEscrows)[number]>();
    localEscrows.forEach((e) => localByOrderId.set(e.razorpayOrderId, e));

    const missingInDb: Array<{ razorpayOrderId: string; amountPaise: number; status: string }> = [];
    const amountMismatches: Array<{
      razorpayOrderId: string;
      localEscrowId: string;
      razorpayAmountPaise: number;
      localAmountPaise: number;
      differencePaise: number;
    }> = [];
    const statusMismatches: Array<{
      razorpayOrderId: string;
      localEscrowId: string;
      razorpayStatus: string;
      localEscrowStatus: string;
    }> = [];

    let razorpayOrderTotalPaise = 0;
    let localMatchedTotalPaise = 0;

    for (const order of razorpayOrders) {
      const orderId = String(order.id || '');
      if (!orderId) continue;
      const rpAmountPaise = Number(order.amount || 0);
      razorpayOrderTotalPaise += rpAmountPaise;

      const local = localByOrderId.get(orderId);
      if (!local) {
        missingInDb.push({
          razorpayOrderId: orderId,
          amountPaise: rpAmountPaise,
          status: String(order.status || 'unknown'),
        });
        continue;
      }

      const localAmountPaise = Number(local.amount);
      localMatchedTotalPaise += localAmountPaise;
      if (localAmountPaise !== rpAmountPaise) {
        amountMismatches.push({
          razorpayOrderId: orderId,
          localEscrowId: local.escrowId,
          razorpayAmountPaise: rpAmountPaise,
          localAmountPaise,
          differencePaise: rpAmountPaise - localAmountPaise,
        });
      }

      const orderStatus = String(order.status || 'unknown');
      const localLooksValid =
        (orderStatus === 'paid' && ['held', 'released', 'refunded'].includes(local.status)) ||
        (orderStatus === 'created' && ['pending', 'cancelled'].includes(local.status));
      if (!localLooksValid) {
        statusMismatches.push({
          razorpayOrderId: orderId,
          localEscrowId: local.escrowId,
          razorpayStatus: orderStatus,
          localEscrowStatus: local.status,
        });
      }
    }

    const inDbNotInRazorpay = localEscrows
      .filter((e) => !orderIds.includes(e.razorpayOrderId))
      .map((e) => ({
        localEscrowId: e.escrowId,
        razorpayOrderId: e.razorpayOrderId,
        amountPaise: Number(e.amount),
        status: e.status,
      }));

    const paged = {
      missingInDb: paginateArray(missingInDb, params.page, params.limit),
      amountMismatches: paginateArray(amountMismatches, params.page, params.limit),
      statusMismatches: paginateArray(statusMismatches, params.page, params.limit),
      inDbNotInRazorpay: paginateArray(inDbNotInRazorpay, params.page, params.limit),
    };

    return {
      mode: 'orders' as const,
      range: { from: params.from.toISOString(), to: params.to.toISOString() },
      summary: {
        razorpayCount: razorpayOrders.length,
        localMatchedCount: localEscrows.length,
        razorpayTotalPaise: razorpayOrderTotalPaise,
        localMatchedTotalPaise,
        totalDifferencePaise: razorpayOrderTotalPaise - localMatchedTotalPaise,
        mismatchCount:
          missingInDb.length + amountMismatches.length + statusMismatches.length + inDbNotInRazorpay.length,
      },
      mismatches: paged,
    };
  }

  const razorpayPayments = await fetchRazorpayPayments(fromEpoch, toEpoch);

  const relevantRazorpay = razorpayPayments.filter((p) => p?.status === 'captured');
  const razorpayPaymentIds = relevantRazorpay
    .map((p) => p.id as string)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const localEscrows = razorpayPaymentIds.length
    ? await prisma.escrow.findMany({
        where: {
          razorpayPaymentId: { in: razorpayPaymentIds },
        },
      })
    : [];

  const localByPaymentId = new Map<string, (typeof localEscrows)[number]>();
  localEscrows.forEach((e) => {
    if (e.razorpayPaymentId) localByPaymentId.set(e.razorpayPaymentId, e);
  });

  const missingInDb: Array<{ razorpayPaymentId: string; razorpayOrderId?: string; amountPaise: number; capturedAt?: number }> = [];
  const amountMismatches: Array<{
    razorpayPaymentId: string;
    localEscrowId: string;
    razorpayAmountPaise: number;
    localAmountPaise: number;
    differencePaise: number;
  }> = [];
  const statusMismatches: Array<{
    razorpayPaymentId: string;
    localEscrowId: string;
    razorpayStatus: string;
    localEscrowStatus: string;
    localPaymentStatus: string | null;
  }> = [];

  let razorpayCapturedTotalPaise = 0;
  let localMatchedTotalPaise = 0;

  for (const payment of relevantRazorpay) {
    const paymentId = payment.id as string;
    const rpAmountPaise = Number(payment.amount || 0);
    razorpayCapturedTotalPaise += rpAmountPaise;

    const local = localByPaymentId.get(paymentId);
    if (!local) {
      missingInDb.push({
        razorpayPaymentId: paymentId,
        razorpayOrderId: payment.order_id as string | undefined,
        amountPaise: rpAmountPaise,
        capturedAt: payment.created_at as number | undefined,
      });
      continue;
    }

    const localAmountPaise = Number(local.amount);
    localMatchedTotalPaise += localAmountPaise;
    if (localAmountPaise !== rpAmountPaise) {
      amountMismatches.push({
        razorpayPaymentId: paymentId,
        localEscrowId: local.escrowId,
        razorpayAmountPaise: rpAmountPaise,
        localAmountPaise,
        differencePaise: rpAmountPaise - localAmountPaise,
      });
    }

    const localLooksCaptured = local.paymentStatus === 'captured' || local.status === 'held' || local.status === 'released' || local.status === 'refunded';
    if (!localLooksCaptured) {
      statusMismatches.push({
        razorpayPaymentId: paymentId,
        localEscrowId: local.escrowId,
        razorpayStatus: String(payment.status || 'unknown'),
        localEscrowStatus: local.status,
        localPaymentStatus: local.paymentStatus || null,
      });
    }
  }

  const inDbNotInRazorpay = localEscrows
    .filter((e) => e.razorpayPaymentId && !razorpayPaymentIds.includes(e.razorpayPaymentId))
    .map((e) => ({
      localEscrowId: e.escrowId,
      razorpayPaymentId: e.razorpayPaymentId!,
      amountPaise: Number(e.amount),
      status: e.status,
      paymentStatus: e.paymentStatus || null,
    }));

  const mismatchAmountPaise =
    missingInDb.reduce((acc, item) => acc + item.amountPaise, 0) +
    amountMismatches.reduce((acc, item) => acc + Math.abs(item.differencePaise), 0);

  const paged = {
    missingInDb: paginateArray(missingInDb, params.page, params.limit),
    amountMismatches: paginateArray(amountMismatches, params.page, params.limit),
    statusMismatches: paginateArray(statusMismatches, params.page, params.limit),
    inDbNotInRazorpay: paginateArray(inDbNotInRazorpay, params.page, params.limit),
  };

  return {
    mode: 'payments' as const,
    range: {
      from: params.from.toISOString(),
      to: params.to.toISOString(),
    },
    summary: {
      razorpayCapturedCount: relevantRazorpay.length,
      localMatchedCount: localEscrows.length,
      razorpayCapturedTotalPaise,
      localMatchedTotalPaise,
      totalDifferencePaise: razorpayCapturedTotalPaise - localMatchedTotalPaise,
      mismatchAmountPaise,
      mismatchCount:
        missingInDb.length + amountMismatches.length + statusMismatches.length + inDbNotInRazorpay.length,
    },
    mismatches: paged,
  };
}

export async function retryPayoutById(payoutId: string, actorId = 'system') {
  const payout = await prisma.payout.findUnique({ where: { payoutId } });
  if (!payout) {
    throw new Error('Payout not found');
  }

  // If already completed, do not enqueue retry
  if (payout.status === 'completed') {
    return {
      accepted: false,
      reason: 'Payout is already completed',
      payoutId,
    };
  }

  // If a retry job is already pending/processing, return that instead of creating duplicates
  const existing = await prisma.jobQueue.findFirst({
    where: {
      jobType: 'payout_retry',
      entityType: 'payout',
      entityId: payoutId,
      status: { in: ['pending', 'processing'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return {
      accepted: true,
      alreadyQueued: true,
      jobId: existing.jobId,
      payoutId,
      status: existing.status,
    };
  }

  const jobId = `payout_retry_${payoutId}_${crypto.randomBytes(6).toString('hex')}`;
  const job = await prisma.jobQueue.create({
    data: {
      jobId,
      jobType: 'payout_retry',
      entityType: 'payout',
      entityId: payoutId,
      payload: {
        payoutId,
        actorId,
        requestedAt: new Date().toISOString(),
      } as any,
      attemptCount: 0,
      maxAttempts: 5,
      nextRetryAt: new Date(),
      status: 'pending',
      priority: 10,
    },
  });

  return {
    accepted: true,
    alreadyQueued: false,
    jobId: job.jobId,
    payoutId,
    status: job.status,
  };
}

export async function listAdminTeam() {
  return prisma.adminUser.findMany({
    orderBy: { createdAt: 'desc' },
  });
}

export async function createAdminInvite(params: {
  email: string;
  role: string;
  invitedBy: string;
  expiresInHours?: number;
}) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + (params.expiresInHours ?? 48) * 60 * 60 * 1000);
  const invite = await prisma.adminInvite.create({
    data: {
      email: params.email.toLowerCase().trim(),
      role: params.role,
      token,
      expiresAt,
      invitedBy: params.invitedBy,
    },
  });
  return invite;
}

export async function updateAdminUserRole(id: string, role: string) {
  return prisma.adminUser.update({
    where: { id },
    data: { role },
  });
}

export async function disableAdminUser(id: string) {
  return prisma.adminUser.update({
    where: { id },
    data: { status: 'disabled' },
  });
}

export async function getDashboardFees() {
  const [feeStructure, categories] = await Promise.all([getFeeStructure(), listCategoryFeeConfigs()]);
  return { feeStructure, categories };
}

export async function getDashboardFeeCategories() {
  return listCategoryFeeConfigs();
}

export async function updateDashboardFeeCategory(categoryKey: string, payload: any, actorId = 'system') {
  return upsertCategoryFeeConfig({ ...payload, categoryKey }, actorId);
}

