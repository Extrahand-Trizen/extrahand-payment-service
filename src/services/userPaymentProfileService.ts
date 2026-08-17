/**
 * User Payment Profile Service
 *
 * Manages cached user payment profiles for fast earnings/payment queries.
 * Handles incremental updates when transactions occur.
 */

import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';
import { partnerVisibleNowWhere } from '../utils/bookNowPartnerPayoutVisibility';

const PENDING_STATUSES = new Set(['pending', 'processing']);

function isPendingStatus(status: string | null | undefined): boolean {
  return PENDING_STATUSES.has(String(status || '').toLowerCase());
}

/**
 * Update user payment profile incrementally when a transaction occurs.
 * This keeps the cache up-to-date without recalculating everything.
 */
export async function updateUserPaymentProfile(
  userId: string,
  update: {
    type: 'payout' | 'payment' | 'refund' | 'compensation';
    amount: Prisma.Decimal;
    payoutId?: string;
    escrowId?: string;
    refundId?: string;
    metadata?: Record<string, any>;
  }
): Promise<void> {
  try {
    const { type, amount, payoutId } = update;

    const currentProfile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    const updateData: Prisma.UserPaymentProfileUpdateInput = {
      lastUpdatedAt: new Date(),
    };

    switch (type) {
      case 'payout':
        updateData.totalEarnings = { increment: amount };
        updateData.fromPayouts = { increment: amount };
        updateData.payoutCount = { increment: 1 };
        updateData.lastPayoutDate = new Date();

        if (payoutId && currentProfile) {
          const payout = await prisma.payout.findUnique({
            where: { payoutId },
            select: { netAmount: true },
          });

          if (payout) {
            const currentCount = currentProfile.payoutCount || 0;
            const currentAverage = currentProfile.averagePayout || new Prisma.Decimal('0');
            const currentLargest = currentProfile.largestPayout || new Prisma.Decimal('0');
            const currentSmallest = currentProfile.smallestPayout || new Prisma.Decimal('0');

            const newCount = currentCount + 1;
            const newAverage =
              currentCount > 0
                ? currentAverage.mul(currentCount).plus(amount).dividedBy(newCount)
                : amount;

            updateData.averagePayout = newAverage;
            updateData.largestPayout = amount.greaterThan(currentLargest) ? amount : currentLargest;
            updateData.smallestPayout =
              currentCount === 0 || amount.lessThan(currentSmallest) ? amount : currentSmallest;
          }
        } else if (payoutId && !currentProfile) {
          const payout = await prisma.payout.findUnique({
            where: { payoutId },
            select: { netAmount: true },
          });
          if (payout) {
            updateData.averagePayout = payout.netAmount;
            updateData.largestPayout = payout.netAmount;
            updateData.smallestPayout = payout.netAmount;
          }
        }
        break;

      case 'compensation':
        updateData.totalEarnings = { increment: amount };
        updateData.fromCompensation = { increment: amount };
        updateData.compensationCount = { increment: 1 };
        break;

      case 'payment':
        updateData.totalPayments = { increment: amount };
        updateData.paymentCount = { increment: 1 };
        updateData.lastPaymentDate = new Date();
        break;

      case 'refund':
        updateData.totalRefunds = { increment: amount };
        updateData.refundCount = { increment: 1 };
        break;
    }

    await prisma.userPaymentProfile.upsert({
      where: { userId },
      update: updateData,
      create: {
        userId,
        totalEarnings: type === 'payout' || type === 'compensation' ? amount : new Prisma.Decimal('0'),
        fromPayouts: type === 'payout' ? amount : new Prisma.Decimal('0'),
        fromCompensation: type === 'compensation' ? amount : new Prisma.Decimal('0'),
        payoutCount: type === 'payout' ? 1 : 0,
        compensationCount: type === 'compensation' ? 1 : 0,
        totalPayments: type === 'payment' ? amount : new Prisma.Decimal('0'),
        paymentCount: type === 'payment' ? 1 : 0,
        totalRefunds: type === 'refund' ? amount : new Prisma.Decimal('0'),
        refundCount: type === 'refund' ? 1 : 0,
        pendingPayouts: new Prisma.Decimal('0'),
        pendingPayoutCount: 0,
        lastPayoutDate: type === 'payout' ? new Date() : null,
        lastPaymentDate: type === 'payment' ? new Date() : null,
        averagePayout: updateData.averagePayout as Prisma.Decimal | null | undefined,
        largestPayout: updateData.largestPayout as Prisma.Decimal | null | undefined,
        smallestPayout: updateData.smallestPayout as Prisma.Decimal | null | undefined,
        lastUpdatedAt: new Date(),
      },
    });

    logger.debug('✅ Updated UserPaymentProfile', {
      userId,
      type,
      amount: amount.toString(),
    });
  } catch (error: any) {
    logger.error('❌ Error updating UserPaymentProfile:', {
      userId,
      error: error.message,
    });
  }
}

/**
 * Idempotent pending/completed cache updates when a payout status changes.
 * previousStatus=null means newly created row.
 */
export async function applyPayoutStatusToProfile(
  userId: string,
  previousStatus: string | null,
  newStatus: string,
  netAmount: Prisma.Decimal,
  payoutId?: string,
): Promise<void> {
  try {
    const prev = String(previousStatus || '').toLowerCase() || null;
    const next = String(newStatus || '').toLowerCase();
    if (prev === next) return;

    const wasPending = isPendingStatus(prev);
    const isPending = isPendingStatus(next);
    const becameCompleted = next === 'completed' && prev !== 'completed';

    if (wasPending !== isPending) {
      await prisma.userPaymentProfile.upsert({
        where: { userId },
        create: {
          userId,
          pendingPayouts: isPending ? netAmount : new Prisma.Decimal('0'),
          pendingPayoutCount: isPending ? 1 : 0,
          lastUpdatedAt: new Date(),
        },
        update: {
          lastUpdatedAt: new Date(),
          ...(wasPending && !isPending
            ? {
                pendingPayouts: { decrement: netAmount },
                pendingPayoutCount: { decrement: 1 },
              }
            : {
                pendingPayouts: { increment: netAmount },
                pendingPayoutCount: { increment: 1 },
              }),
        },
      });

      if (wasPending && !isPending) {
        await prisma.$executeRaw`
          UPDATE "UserPaymentProfile"
          SET
            "pendingPayouts" = GREATEST("pendingPayouts", 0),
            "pendingPayoutCount" = GREATEST("pendingPayoutCount", 0)
          WHERE "userId" = ${userId}
        `;
      }
    }

    if (becameCompleted) {
      await updateUserPaymentProfile(userId, {
        type: 'payout',
        amount: netAmount,
        payoutId,
      });
    }
  } catch (error: any) {
    logger.error('❌ Error applying payout status to profile:', {
      userId,
      previousStatus,
      newStatus,
      error: error.message,
    });
  }
}

/**
 * Earnings-only recalculate for Overview SWR background seed.
 * Parallel aggregates: completed payouts, last payout, compensation, pending.
 */
export async function recalculateUserEarningsProfile(userId: string): Promise<void> {
  try {
    const now = new Date();
    const visible = partnerVisibleNowWhere(now);
    const [payoutStats, lastPayout, compensationStats, pendingStats] = await Promise.all([
      prisma.payout.aggregate({
        where: { performerUid: userId, status: 'completed', AND: [visible] },
        _sum: { netAmount: true },
        _count: { id: true },
        _avg: { netAmount: true },
        _min: { netAmount: true },
        _max: { netAmount: true },
      }),
      prisma.payout.findFirst({
        where: { performerUid: userId, status: 'completed', AND: [visible] },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.refund.aggregate({
        where: {
          escrow: { performerUid: userId },
          cancelledBy: 'poster',
          toOtherParty: { not: null },
          status: 'completed',
        },
        _sum: { toOtherParty: true },
        _count: { id: true },
      }),
      prisma.payout.aggregate({
        where: {
          performerUid: userId,
          status: { in: ['pending', 'processing'] },
          AND: [visible],
        },
        _sum: { netAmount: true },
        _count: { id: true },
      }),
    ]);

    const fromPayouts = payoutStats._sum?.netAmount || new Prisma.Decimal('0');
    const fromCompensation = compensationStats._sum?.toOtherParty || new Prisma.Decimal('0');
    const totalEarnings = fromPayouts.plus(fromCompensation);
    const pendingPayouts = pendingStats._sum?.netAmount || new Prisma.Decimal('0');
    const pendingPayoutCount = pendingStats._count?.id || 0;

    await prisma.userPaymentProfile.upsert({
      where: { userId },
      update: {
        totalEarnings,
        fromPayouts,
        fromCompensation,
        payoutCount: payoutStats._count.id || 0,
        compensationCount: compensationStats._count.id || 0,
        pendingPayouts,
        pendingPayoutCount,
        averagePayout: payoutStats._avg.netAmount || null,
        largestPayout: payoutStats._max.netAmount || null,
        smallestPayout: payoutStats._min.netAmount || null,
        lastPayoutDate: lastPayout?.createdAt || null,
        lastUpdatedAt: new Date(),
      },
      create: {
        userId,
        totalEarnings,
        fromPayouts,
        fromCompensation,
        payoutCount: payoutStats._count.id || 0,
        compensationCount: compensationStats._count.id || 0,
        pendingPayouts,
        pendingPayoutCount,
        averagePayout: payoutStats._avg.netAmount || null,
        largestPayout: payoutStats._max.netAmount || null,
        smallestPayout: payoutStats._min.netAmount || null,
        lastPayoutDate: lastPayout?.createdAt || null,
      },
    });

    logger.info('✅ Recalculated UserPaymentProfile (earnings-only)', { userId });
  } catch (error: any) {
    logger.error('❌ Error recalculating earnings UserPaymentProfile:', {
      userId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Full profile recalculate (admin / migration / explicit repair).
 * Prefer recalculateUserEarningsProfile for Overview background seeding.
 */
export async function recalculateUserPaymentProfile(userId: string): Promise<void> {
  try {
    const now = new Date();
    const visible = partnerVisibleNowWhere(now);
    const [
      payoutStats,
      lastPayout,
      compensationStats,
      paymentStats,
      lastPayment,
      refundStats,
      feeStats,
      pendingStats,
    ] = await Promise.all([
      prisma.payout.aggregate({
        where: { performerUid: userId, status: 'completed', AND: [visible] },
        _sum: { netAmount: true },
        _count: { id: true },
        _avg: { netAmount: true },
        _min: { netAmount: true },
        _max: { netAmount: true },
      }),
      prisma.payout.findFirst({
        where: { performerUid: userId, status: 'completed', AND: [visible] },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.refund.aggregate({
        where: {
          escrow: { performerUid: userId },
          cancelledBy: 'poster',
          toOtherParty: { not: null },
          status: 'completed',
        },
        _sum: { toOtherParty: true },
        _count: { id: true },
      }),
      prisma.escrow.aggregate({
        where: { posterUid: userId },
        _sum: { amountInRupees: true },
        _count: { id: true },
      }),
      prisma.escrow.findFirst({
        where: { posterUid: userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.refund.aggregate({
        where: {
          escrow: { posterUid: userId },
          status: 'completed',
        },
        _sum: { refundAmount: true },
        _count: { id: true },
      }),
      prisma.ledger.aggregate({
        where: {
          escrow: {
            OR: [{ posterUid: userId }, { performerUid: userId }],
          },
          type: {
            in: [
              'platform_commission',
              'gst',
              'tds',
              'cancellation_fee',
              'platform_fee',
              'razorpay_fee',
            ],
          },
        },
        _sum: { amount: true },
      }),
      prisma.payout.aggregate({
        where: {
          performerUid: userId,
          status: { in: ['pending', 'processing'] },
          AND: [visible],
        },
        _sum: { netAmount: true },
        _count: { id: true },
      }),
    ]);

    const fromPayouts = payoutStats._sum.netAmount || new Prisma.Decimal('0');
    const fromCompensation = compensationStats._sum.toOtherParty || new Prisma.Decimal('0');
    const totalEarnings = fromPayouts.plus(fromCompensation);
    const totalPayments = paymentStats._sum.amountInRupees || new Prisma.Decimal('0');
    const totalRefunds = refundStats._sum.refundAmount || new Prisma.Decimal('0');
    const totalFees = feeStats._sum.amount?.abs() || new Prisma.Decimal('0');
    const pendingPayouts = pendingStats._sum.netAmount || new Prisma.Decimal('0');

    await prisma.userPaymentProfile.upsert({
      where: { userId },
      update: {
        totalEarnings,
        fromPayouts,
        fromCompensation,
        payoutCount: payoutStats._count.id || 0,
        compensationCount: compensationStats._count.id || 0,
        totalPayments,
        paymentCount: paymentStats._count.id || 0,
        totalRefunds,
        refundCount: refundStats._count.id || 0,
        totalFees,
        pendingPayouts,
        pendingPayoutCount: pendingStats._count.id || 0,
        averagePayout: payoutStats._avg.netAmount || null,
        largestPayout: payoutStats._max.netAmount || null,
        smallestPayout: payoutStats._min.netAmount || null,
        lastPayoutDate: lastPayout?.createdAt || null,
        lastPaymentDate: lastPayment?.createdAt || null,
        lastUpdatedAt: new Date(),
      },
      create: {
        userId,
        totalEarnings,
        fromPayouts,
        fromCompensation,
        payoutCount: payoutStats._count.id || 0,
        compensationCount: compensationStats._count.id || 0,
        totalPayments,
        paymentCount: paymentStats._count.id || 0,
        totalRefunds,
        refundCount: refundStats._count.id || 0,
        totalFees,
        pendingPayouts,
        pendingPayoutCount: pendingStats._count.id || 0,
        averagePayout: payoutStats._avg.netAmount || null,
        largestPayout: payoutStats._max.netAmount || null,
        smallestPayout: payoutStats._min.netAmount || null,
        lastPayoutDate: lastPayout?.createdAt || null,
        lastPaymentDate: lastPayment?.createdAt || null,
      },
    });

    logger.info('✅ Recalculated UserPaymentProfile', { userId });
  } catch (error: any) {
    logger.error('❌ Error recalculating UserPaymentProfile:', {
      userId,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Profiles older than this are treated as stale: Overview returns a live
 * aggregate and re-seeds the denormalized cache in the background.
 * Keep this short so processing → completed is self-healing even if an
 * incremental applyPayoutStatusToProfile update was missed.
 */
const PROFILE_STALE_MS = 2 * 60 * 1000; // 2 minutes

export function isProfileStale(lastUpdatedAt: Date): boolean {
  return lastUpdatedAt.getTime() < Date.now() - PROFILE_STALE_MS;
}
