/**
 * User Payment Profile Service
 * 
 * Manages cached user payment profiles for fast earnings/payment queries
 * Handles incremental updates when transactions occur
 */

import { prisma, prismaDev } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';

/**
 * Update user payment profile incrementally when a transaction occurs
 * This keeps the cache up-to-date without recalculating everything
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
    const { type, amount, payoutId, escrowId, refundId, metadata } = update;

    // Get current profile or create if doesn't exist
    const currentProfile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    const updateData: Prisma.UserPaymentProfileUpdateInput = {
      lastUpdatedAt: new Date(),
    };

    switch (type) {
      case 'payout':
        // Increment earnings from payouts
        updateData.totalEarnings = {
          increment: amount,
        };
        updateData.fromPayouts = {
          increment: amount,
        };
        updateData.payoutCount = {
          increment: 1,
        };
        updateData.lastPayoutDate = new Date();

        // Update stats incrementally (much faster than fetching all payouts)
        if (payoutId && currentProfile) {
          const payout = await prisma.payout.findUnique({
            where: { payoutId },
            select: { netAmount: true },
          });

          if (payout) {
            // Incremental calculation: Update average, largest, smallest without fetching all payouts
            const currentCount = currentProfile.payoutCount || 0;
            const currentAverage = currentProfile.averagePayout || new Prisma.Decimal('0');
            const currentLargest = currentProfile.largestPayout || new Prisma.Decimal('0');
            const currentSmallest = currentProfile.smallestPayout || new Prisma.Decimal('0');

            // Calculate new average incrementally: (old_avg * old_count + new_amount) / new_count
            const newCount = currentCount + 1;
            const newAverage = currentCount > 0
              ? currentAverage.mul(currentCount).plus(amount).dividedBy(newCount)
              : amount;

            // Update largest and smallest
            const newLargest = amount.greaterThan(currentLargest) ? amount : currentLargest;
            const newSmallest = currentCount === 0 || amount.lessThan(currentSmallest)
              ? amount
              : currentSmallest;

            updateData.averagePayout = newAverage;
            updateData.largestPayout = newLargest;
            updateData.smallestPayout = newSmallest;
          }
        } else if (payoutId && !currentProfile) {
          // First payout - stats are simple
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
        // Increment earnings from compensation
        updateData.totalEarnings = {
          increment: amount,
        };
        updateData.fromCompensation = {
          increment: amount,
        };
        updateData.compensationCount = {
          increment: 1,
        };
        break;

      case 'payment':
        // Increment payments (as poster)
        updateData.totalPayments = {
          increment: amount,
        };
        updateData.paymentCount = {
          increment: 1,
        };
        updateData.lastPaymentDate = new Date();
        break;

      case 'refund':
        // Increment refunds (as poster)
        updateData.totalRefunds = {
          increment: amount,
        };
        updateData.refundCount = {
          increment: 1,
        };
        break;
    }

    // Update or create profile
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
    // Don't throw - profile update failure shouldn't break transaction
  }
}

/**
 * Recalculate user payment profile from scratch
 * Use this when cache might be stale or for data migration
 */
export async function recalculateUserPaymentProfile(
  userId: string
): Promise<void> {
  try {
    // Calculate from payouts
    const payoutStats = await prisma.payout.aggregate({
      where: {
        performerUid: userId,
        status: 'completed',
      },
      _sum: { netAmount: true },
      _count: { id: true },
      _avg: { netAmount: true },
      _min: { netAmount: true },
      _max: { netAmount: true },
    });

    const lastPayout = await prisma.payout.findFirst({
      where: {
        performerUid: userId,
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    // Calculate from compensation
    const compensationStats = await prisma.refund.aggregate({
      where: {
        escrow: { performerUid: userId },
        cancelledBy: 'poster',
        toOtherParty: { not: null },
        status: 'completed',
      },
      _sum: { toOtherParty: true },
      _count: { id: true },
    });

    // Calculate payments
    const paymentStats = await prisma.escrow.aggregate({
      where: { posterUid: userId },
      _sum: { amountInRupees: true },
      _count: { id: true },
    });

    const lastPayment = await prisma.escrow.findFirst({
      where: { posterUid: userId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    // Calculate refunds
    const refundStats = await prisma.refund.aggregate({
      where: {
        escrow: { posterUid: userId },
        status: 'completed',
      },
      _sum: { refundAmount: true },
      _count: { id: true },
    });

    // Calculate fees
    const feeStats = await prisma.ledger.aggregate({
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
    });

    let fromPayouts = payoutStats._sum.netAmount || new Prisma.Decimal('0');
    let fromCompensation = compensationStats._sum.toOtherParty || new Prisma.Decimal('0');
    let totalPayouts = payoutStats._count.id || 0;
    let totalCompensations = compensationStats._count.id || 0;
    let totalPayments = paymentStats._sum.amountInRupees || new Prisma.Decimal('0');
    let paymentCount = paymentStats._count.id || 0;
    let totalRefunds = refundStats._sum.refundAmount || new Prisma.Decimal('0');
    let refundCount = refundStats._count.id || 0;
    let totalFees = feeStats._sum.amount?.abs() || new Prisma.Decimal('0');

    // Merge from DEV DB
    if (prismaDev) {
      try {
        const [devPayouts, devComp, devPayments, devRefunds, devFees] = await Promise.all([
          prismaDev.payout.aggregate({ where: { performerUid: userId, status: 'completed' }, _sum: { netAmount: true }, _count: { id: true } }),
          prismaDev.refund.aggregate({ where: { escrow: { performerUid: userId }, cancelledBy: 'poster', toOtherParty: { not: null }, status: 'completed' }, _sum: { toOtherParty: true }, _count: { id: true } }),
          prismaDev.escrow.aggregate({ where: { posterUid: userId }, _sum: { amountInRupees: true }, _count: { id: true } }),
          prismaDev.refund.aggregate({ where: { escrow: { posterUid: userId }, status: 'completed' }, _sum: { refundAmount: true }, _count: { id: true } }),
          prismaDev.ledger.aggregate({ where: { escrow: { OR: [{ posterUid: userId }, { performerUid: userId }] }, type: { in: ['platform_commission', 'gst', 'tds', 'cancellation_fee', 'platform_fee', 'razorpay_fee'] } }, _sum: { amount: true } })
        ]);
        if ((devPayouts._count.id || 0) > totalPayouts) {
          fromPayouts = fromPayouts.plus(devPayouts._sum.netAmount || new Prisma.Decimal('0'));
          totalPayouts += devPayouts._count.id || 0;
        }
        if ((devComp._count.id || 0) > totalCompensations) {
          fromCompensation = fromCompensation.plus(devComp._sum.toOtherParty || new Prisma.Decimal('0'));
          totalCompensations += devComp._count.id || 0;
        }
        if ((devPayments._count.id || 0) > paymentCount) {
          totalPayments = totalPayments.plus(devPayments._sum.amountInRupees || new Prisma.Decimal('0'));
          paymentCount += devPayments._count.id || 0;
        }
        if ((devRefunds._count.id || 0) > refundCount) {
          totalRefunds = totalRefunds.plus(devRefunds._sum.refundAmount || new Prisma.Decimal('0'));
          refundCount += devRefunds._count.id || 0;
        }
        if (devFees._sum.amount) {
          totalFees = totalFees.plus(devFees._sum.amount.abs());
        }
      } catch (devErr: any) {
        logger.warn('DEV DB merge failed during profile recalculate', { error: devErr.message });
      }
    }

    const totalEarnings = fromPayouts.plus(fromCompensation);

    // Update or create profile
    await prisma.userPaymentProfile.upsert({
      where: { userId },
      update: {
        totalEarnings,
        fromPayouts,
        fromCompensation,
        payoutCount: totalPayouts,
        compensationCount: totalCompensations,
        totalPayments,
        paymentCount,
        totalRefunds,
        refundCount,
        totalFees,
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
        payoutCount: totalPayouts,
        compensationCount: totalCompensations,
        totalPayments,
        paymentCount,
        totalRefunds,
        refundCount,
        totalFees,
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
 * Check if profile cache is stale (older than 1 hour)
 */
export function isProfileStale(lastUpdatedAt: Date): boolean {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return lastUpdatedAt < oneHourAgo;
}

