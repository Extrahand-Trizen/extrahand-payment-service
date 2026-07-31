import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';
import {
  recalculateUserEarningsProfile,
  recalculateUserPaymentProfile,
  isProfileStale,
} from './userPaymentProfileService';
import { partnerVisibleNowWhere } from '../utils/bookNowPartnerPayoutVisibility';

const EARNINGS_LABELS = {
  fromPayouts: 'From Completed Tasks',
  fromCompensation: 'From Cancellations',
} as const;

type EarningsPayload = {
  totalEarnings: string;
  fromPayouts: string;
  fromCompensation: string;
  pendingPayouts: string;
  pendingPayoutCount: number;
  totalPayouts: number;
  totalCompensations: number;
  labels: {
    fromPayouts: string;
    fromCompensation: string;
  };
};

function zeroEarnings(): EarningsPayload {
  return {
    totalEarnings: '0',
    fromPayouts: '0',
    fromCompensation: '0',
    pendingPayouts: '0',
    pendingPayoutCount: 0,
    totalPayouts: 0,
    totalCompensations: 0,
    labels: { ...EARNINGS_LABELS },
  };
}

function fromProfileRow(profile: {
  totalEarnings: Prisma.Decimal;
  fromPayouts: Prisma.Decimal;
  fromCompensation: Prisma.Decimal;
  pendingPayouts?: Prisma.Decimal | null;
  pendingPayoutCount?: number | null;
  payoutCount: number;
  compensationCount: number;
}): EarningsPayload {
  return {
    totalEarnings: profile.totalEarnings.toString(),
    fromPayouts: profile.fromPayouts.toString(),
    fromCompensation: profile.fromCompensation.toString(),
    pendingPayouts: (profile.pendingPayouts || new Prisma.Decimal('0')).toString(),
    pendingPayoutCount: profile.pendingPayoutCount || 0,
    totalPayouts: profile.payoutCount,
    totalCompensations: profile.compensationCount,
    labels: { ...EARNINGS_LABELS },
  };
}

function scheduleEarningsRecalc(userId: string, reason: string): void {
  void recalculateUserEarningsProfile(userId).catch((err: any) => {
    logger.warn('[EarningsService] Background earnings recalc failed', {
      userId,
      reason,
      error: err?.message,
    });
  });
}

async function livePendingAggregate(
  uidList: string[],
): Promise<{ pendingPayouts: Prisma.Decimal; pendingPayoutCount: number }> {
  const now = new Date();
  const pendingAgg = await prisma.payout.aggregate({
    where: {
      performerUid: { in: uidList },
      status: { in: ['pending', 'processing'] },
      AND: [partnerVisibleNowWhere(now)],
    },
    _sum: { netAmount: true },
    _count: { _all: true },
  });
  return {
    pendingPayouts: pendingAgg._sum.netAmount || new Prisma.Decimal('0'),
    pendingPayoutCount: pendingAgg._count._all || 0,
  };
}

async function liveAggregateFallback(uidList: string[]): Promise<EarningsPayload> {
  const now = new Date();
  const visible = partnerVisibleNowWhere(now);
  const [payoutsAgg, compensationsAgg, pendingAgg] = await Promise.all([
    prisma.payout.aggregate({
      where: {
        performerUid: { in: uidList },
        status: 'completed',
        AND: [visible],
      },
      _sum: { netAmount: true },
      _count: { _all: true },
    }),
    prisma.refund.aggregate({
      where: {
        escrow: { performerUid: { in: uidList } },
        cancelledBy: 'poster',
        toOtherParty: { not: null },
        status: 'completed',
      },
      _sum: { toOtherParty: true },
      _count: { _all: true },
    }),
    livePendingAggregate(uidList),
  ]);

  const fromPayouts = payoutsAgg._sum.netAmount || new Prisma.Decimal('0');
  const fromCompensation = compensationsAgg._sum.toOtherParty || new Prisma.Decimal('0');

  return {
    totalEarnings: fromPayouts.plus(fromCompensation).toString(),
    fromPayouts: fromPayouts.toString(),
    fromCompensation: fromCompensation.toString(),
    pendingPayouts: pendingAgg.pendingPayouts.toString(),
    pendingPayoutCount: pendingAgg.pendingPayoutCount,
    totalPayouts: payoutsAgg._count._all || 0,
    totalCompensations: compensationsAgg._count._all || 0,
    labels: { ...EARNINGS_LABELS },
  };
}

/**
 * Overlay live pending onto a cached earnings payload.
 * Pending/processing → completed transitions must not leave the Overview stuck
 * on denormalized UserPaymentProfile.pendingPayouts.
 */
function withLivePending(
  base: EarningsPayload,
  live: { pendingPayouts: Prisma.Decimal; pendingPayoutCount: number },
): EarningsPayload {
  return {
    ...base,
    pendingPayouts: live.pendingPayouts.toString(),
    pendingPayoutCount: live.pendingPayoutCount,
  };
}

/**
 * Get total earnings for a user.
 * Cache-first for completed totals; always live-read pending/processing so the
 * Overview never shows a payout as "Processing" after it completed.
 * When the profile is stale/missing, return a full live aggregate (and seed cache).
 */
export async function getUserEarnings(
  userId: string,
  linkedUserIds?: string[],
): Promise<{
  success: boolean;
  earnings?: EarningsPayload;
  error?: string;
}> {
  const started = Date.now();
  let path:
    | 'cache'
    | 'stale_live'
    | 'miss_live'
    | 'linked_merge'
    | 'linked_stale_live'
    | 'fallback_aggregate' = 'miss_live';

  try {
    const uidList = [
      ...new Set(
        [userId, ...(linkedUserIds || [])].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0,
        ),
      ),
    ];

    if (uidList.length === 0) {
      return { success: false, error: 'User ID is required' };
    }

    if (uidList.length > 1) {
      const profiles = await prisma.userPaymentProfile.findMany({
        where: { userId: { in: uidList } },
      });

      const anyStale =
        profiles.length === 0 ||
        profiles.length < uidList.length ||
        profiles.some((p) => isProfileStale(p.lastUpdatedAt));

      if (anyStale) {
        path = profiles.length === 0 ? 'fallback_aggregate' : 'linked_stale_live';
        const earnings = await liveAggregateFallback(uidList);
        for (const uid of uidList) {
          scheduleEarningsRecalc(uid, path);
        }
        logger.info('[EarningsService] getUserEarnings', {
          userId,
          path,
          durationMs: Date.now() - started,
          linkedCount: uidList.length,
          profileCount: profiles.length,
        });
        return { success: true, earnings };
      }

      path = 'linked_merge';
      let fromPayouts = new Prisma.Decimal('0');
      let fromCompensation = new Prisma.Decimal('0');
      let totalPayouts = 0;
      let totalCompensations = 0;

      for (const p of profiles) {
        fromPayouts = fromPayouts.plus(p.fromPayouts);
        fromCompensation = fromCompensation.plus(p.fromCompensation);
        totalPayouts += p.payoutCount;
        totalCompensations += p.compensationCount;
      }

      const livePending = await livePendingAggregate(uidList);
      const earnings = withLivePending(
        {
          totalEarnings: fromPayouts.plus(fromCompensation).toString(),
          fromPayouts: fromPayouts.toString(),
          fromCompensation: fromCompensation.toString(),
          pendingPayouts: '0',
          pendingPayoutCount: 0,
          totalPayouts,
          totalCompensations,
          labels: { ...EARNINGS_LABELS },
        },
        livePending,
      );

      const cachedPending = profiles.reduce(
        (sum, p) => sum.plus((p as { pendingPayouts?: Prisma.Decimal }).pendingPayouts || 0),
        new Prisma.Decimal('0'),
      );
      if (!cachedPending.equals(livePending.pendingPayouts)) {
        for (const uid of uidList) {
          scheduleEarningsRecalc(uid, 'linked_pending_drift');
        }
      }

      logger.info('[EarningsService] getUserEarnings', {
        userId,
        path,
        durationMs: Date.now() - started,
        linkedCount: uidList.length,
        profileCount: profiles.length,
        livePending: livePending.pendingPayouts.toString(),
      });

      return { success: true, earnings };
    }

    let profile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    if (!profile || isProfileStale(profile.lastUpdatedAt)) {
      logger.debug('UserPaymentProfile missing or stale, recalculating...', {
        userId,
        hasProfile: !!profile,
        isStale: profile ? isProfileStale(profile.lastUpdatedAt) : true,
      });
      try {
        await recalculateUserPaymentProfile(userId);
        profile = await prisma.userPaymentProfile.findUnique({
          where: { userId },
        });
      } catch (recalcError: any) {
        logger.warn('UserPaymentProfile recalculation failed, using aggregate fallback', {
          userId,
          error: recalcError?.message,
        });
      }
    }

    if (profile) {
      if (isProfileStale(profile.lastUpdatedAt)) {
        path = 'stale_live';
        const earnings = await liveAggregateFallback([userId]);
        scheduleEarningsRecalc(userId, 'stale');
        logger.info('[EarningsService] getUserEarnings', {
          userId,
          path,
          durationMs: Date.now() - started,
        });
        return { success: true, earnings };
      }

      path = 'cache';
      const livePending = await livePendingAggregate([userId]);
      const earnings = withLivePending(fromProfileRow(profile), livePending);

      if (!profile.pendingPayouts.equals(livePending.pendingPayouts)) {
        scheduleEarningsRecalc(userId, 'pending_drift');
      }

      logger.info('[EarningsService] getUserEarnings', {
        userId,
        path,
        durationMs: Date.now() - started,
        livePending: livePending.pendingPayouts.toString(),
      });
      return { success: true, earnings };
    }

    path = 'miss_live';
    const earnings = await liveAggregateFallback([userId]);
    scheduleEarningsRecalc(userId, 'miss');
    logger.info('[EarningsService] getUserEarnings', {
      userId,
      path,
      durationMs: Date.now() - started,
    });
    return { success: true, earnings };
  } catch (error: any) {
    logger.error('Error getting user earnings:', {
      error: error.message,
      durationMs: Date.now() - started,
      path,
    });
    return {
      success: false,
      error: error.message || 'Failed to get earnings',
    };
  }
}

/**
 * Get earnings breakdown by period (monthly) via SQL GROUP BY.
 */
export async function getEarningsByPeriod(
  userId: string,
  startDate?: Date,
  endDate?: Date,
): Promise<{
  success: boolean;
  earnings?: Array<{
    period: string;
    totalEarnings: string;
    fromPayouts: string;
    fromCompensation: string;
    payoutCount: number;
    compensationCount: number;
    labels?: {
      fromPayouts: string;
      fromCompensation: string;
    };
  }>;
  error?: string;
}> {
  try {
    const payoutDateFilter =
      startDate && endDate
        ? Prisma.sql`AND p."createdAt" >= ${startDate} AND p."createdAt" <= ${endDate}`
        : startDate
          ? Prisma.sql`AND p."createdAt" >= ${startDate}`
          : endDate
            ? Prisma.sql`AND p."createdAt" <= ${endDate}`
            : Prisma.empty;
    const refundDateFilter =
      startDate && endDate
        ? Prisma.sql`AND r."createdAt" >= ${startDate} AND r."createdAt" <= ${endDate}`
        : startDate
          ? Prisma.sql`AND r."createdAt" >= ${startDate}`
          : endDate
            ? Prisma.sql`AND r."createdAt" <= ${endDate}`
            : Prisma.empty;

    const [payoutRows, compensationRows] = await Promise.all([
      prisma.$queryRaw<Array<{ period: string; total: Prisma.Decimal; count: bigint }>>`
        SELECT
          to_char(date_trunc('month', p."createdAt"), 'YYYY-MM') AS period,
          COALESCE(SUM(p."netAmount"), 0) AS total,
          COUNT(*)::bigint AS count
        FROM "Payout" p
        WHERE p."performerUid" = ${userId}
          AND p."status" IN ('completed', 'processing')
          ${payoutDateFilter}
        GROUP BY date_trunc('month', p."createdAt")
        ORDER BY period ASC
      `,
      prisma.$queryRaw<Array<{ period: string; total: Prisma.Decimal; count: bigint }>>`
        SELECT
          to_char(date_trunc('month', r."createdAt"), 'YYYY-MM') AS period,
          COALESCE(SUM(r."toOtherParty"), 0) AS total,
          COUNT(*)::bigint AS count
        FROM "Refund" r
        INNER JOIN "Escrow" e ON e."id" = r."escrowId"
        WHERE e."performerUid" = ${userId}
          AND r."cancelledBy" = 'poster'
          AND r."toOtherParty" IS NOT NULL
          AND r."status" = 'completed'
          ${refundDateFilter}
        GROUP BY date_trunc('month', r."createdAt")
        ORDER BY period ASC
      `,
    ]);

    const monthlyPayouts: Record<string, { total: Prisma.Decimal; count: number }> = {};
    for (const row of payoutRows) {
      monthlyPayouts[row.period] = {
        total: new Prisma.Decimal(row.total ?? 0),
        count: Number(row.count ?? 0),
      };
    }

    const monthlyCompensations: Record<string, { total: Prisma.Decimal; count: number }> = {};
    for (const row of compensationRows) {
      monthlyCompensations[row.period] = {
        total: new Prisma.Decimal(row.total ?? 0),
        count: Number(row.count ?? 0),
      };
    }

    const allMonths = new Set([
      ...Object.keys(monthlyPayouts),
      ...Object.keys(monthlyCompensations),
    ]);

    const earnings = Array.from(allMonths)
      .sort()
      .map((period) => {
        const payoutData = monthlyPayouts[period] || {
          total: new Prisma.Decimal('0'),
          count: 0,
        };
        const compensationData = monthlyCompensations[period] || {
          total: new Prisma.Decimal('0'),
          count: 0,
        };
        const totalEarnings = payoutData.total.plus(compensationData.total);

        return {
          period,
          totalEarnings: totalEarnings.toString(),
          fromPayouts: payoutData.total.toString(),
          fromCompensation: compensationData.total.toString(),
          payoutCount: payoutData.count,
          compensationCount: compensationData.count,
          labels: {
            fromPayouts: 'Completed Works',
            fromCompensation: 'Cancellations',
          },
        };
      });

    return { success: true, earnings };
  } catch (error: any) {
    logger.error('Error calculating earnings by period:', error);
    return {
      success: false,
      error: error.message || 'Failed to calculate earnings by period',
    };
  }
}

/**
 * Get earnings statistics for a user
 */
export async function getEarningsStats(userId: string): Promise<{
  success: boolean;
  stats?: {
    totalEarnings: string;
    totalPayouts: number;
    totalCompensations: number;
    averagePayout: string;
    largestPayout: string;
    smallestPayout: string;
    lastPayoutDate?: string;
    lastCompensationDate?: string;
    labels?: {
      totalPayouts: string;
      totalCompensations: string;
      averagePayout: string;
      largestPayout: string;
      smallestPayout: string;
      lastPayout: string;
      lastCompensation: string;
    };
  };
  error?: string;
}> {
  try {
    const earningsResult = await getUserEarnings(userId);
    if (!earningsResult.success || !earningsResult.earnings) {
      return earningsResult as any;
    }

    let profile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    if (!profile || isProfileStale(profile.lastUpdatedAt)) {
      scheduleEarningsRecalc(userId, 'stats_stale_or_miss');
    }

    if (!profile) {
      return {
        success: true,
        stats: {
          totalEarnings: '0',
          totalPayouts: 0,
          totalCompensations: 0,
          averagePayout: '0',
          largestPayout: '0',
          smallestPayout: '0',
          labels: {
            totalPayouts: 'Completed Tasks',
            totalCompensations: 'Cancellations',
            averagePayout: 'Average per Task',
            largestPayout: 'Highest Earning',
            smallestPayout: 'Lowest Earning',
            lastPayout: 'Last Payment',
            lastCompensation: 'Last Cancellation',
          },
        },
      };
    }

    const lastCompensation = await prisma.refund.findFirst({
      where: {
        escrow: { performerUid: userId },
        cancelledBy: 'poster',
        toOtherParty: { not: null },
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      stats: {
        totalEarnings: profile.totalEarnings.toString(),
        totalPayouts: profile.payoutCount,
        totalCompensations: profile.compensationCount,
        averagePayout: profile.averagePayout?.toString() || '0',
        largestPayout: profile.largestPayout?.toString() || '0',
        smallestPayout: profile.smallestPayout?.toString() || '0',
        lastPayoutDate: profile.lastPayoutDate?.toISOString(),
        lastCompensationDate: lastCompensation?.createdAt.toISOString(),
        labels: {
          totalPayouts: 'Completed Tasks',
          totalCompensations: 'Cancellations',
          averagePayout: 'Average per Task',
          largestPayout: 'Highest Earning',
          smallestPayout: 'Lowest Earning',
          lastPayout: 'Last Payment',
          lastCompensation: 'Last Cancellation',
        },
      },
    };
  } catch (error: any) {
    logger.error('Error getting earnings stats:', error);
    return {
      success: false,
      error: error.message || 'Failed to get earnings stats',
    };
  }
}
