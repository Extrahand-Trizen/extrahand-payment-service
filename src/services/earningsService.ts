import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';
import {
  recalculateUserPaymentProfile,
  isProfileStale,
} from './userPaymentProfileService';

/**
 * Get total earnings for a user
 * Uses UserPaymentProfile cache for fast access, falls back to calculation if missing/stale
 * Includes:
 * - Completed payouts (netAmount after fees)
 * - Cancellation compensation (toOtherParty when poster cancels)
 */
export async function getUserEarnings(userId: string): Promise<{
  success: boolean;
  earnings?: {
    totalEarnings: string;
    fromPayouts: string;
    fromCompensation: string;
    totalPayouts: number;
    totalCompensations: number;
    labels?: {
      fromPayouts: string;
      fromCompensation: string;
    };
  };
  error?: string;
}> {
  try {
    // Try cache first
    let profile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    // If missing or stale, recalculate
    if (!profile || (profile && isProfileStale(profile.lastUpdatedAt))) {
      logger.debug('UserPaymentProfile missing or stale, recalculating...', {
        userId,
        hasProfile: !!profile,
        isStale: profile ? isProfileStale(profile.lastUpdatedAt) : true,
      });
      await recalculateUserPaymentProfile(userId);
      profile = await prisma.userPaymentProfile.findUnique({
        where: { userId },
      });
    }

    // If still no profile (user has no transactions), return zeros
    if (!profile) {
      return {
        success: true,
        earnings: {
          totalEarnings: '0',
          fromPayouts: '0',
          fromCompensation: '0',
          totalPayouts: 0,
          totalCompensations: 0,
          labels: {
            fromPayouts: 'From Completed Tasks',
            fromCompensation: 'From Cancellations',
          },
        },
      };
    }

    // Return from cache with user-friendly labels
    return {
      success: true,
      earnings: {
        totalEarnings: profile.totalEarnings.toString(),
        fromPayouts: profile.fromPayouts.toString(),
        fromCompensation: profile.fromCompensation.toString(),
        totalPayouts: profile.payoutCount,
        totalCompensations: profile.compensationCount,
        labels: {
          fromPayouts: 'From Completed Tasks',
          fromCompensation: 'From Cancellations',
        },
      },
    };
  } catch (error: any) {
    logger.error('Error getting user earnings:', error);
    return {
      success: false,
      error: error.message || 'Failed to get earnings',
    };
  }
}

/**
 * Get earnings breakdown by period (monthly)
 */
export async function getEarningsByPeriod(
  userId: string,
  startDate?: Date,
  endDate?: Date
): Promise<{
  success: boolean;
  earnings?: Array<{
    period: string; // YYYY-MM format
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
    const whereClause: Prisma.PayoutWhereInput = {
      performerUid: userId,
      status: 'completed'
    };

    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) whereClause.createdAt.gte = startDate;
      if (endDate) whereClause.createdAt.lte = endDate;
    }

    // Get all payouts grouped by month
    const payouts = await prisma.payout.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' }
    });

    // Group payouts by month
    const monthlyPayouts: Record<string, { total: Prisma.Decimal; count: number }> = {};
    
    payouts.forEach(payout => {
      const monthKey = payout.createdAt.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyPayouts[monthKey]) {
        monthlyPayouts[monthKey] = { total: new Prisma.Decimal('0'), count: 0 };
      }
      monthlyPayouts[monthKey].total = monthlyPayouts[monthKey].total.plus(payout.netAmount);
      monthlyPayouts[monthKey].count += 1;
    });

    // Get compensations grouped by month
    const compensationWhere: Prisma.RefundWhereInput = {
      escrow: {
        performerUid: userId
      },
      cancelledBy: 'poster',
      toOtherParty: { not: null },
      status: 'completed'
    };

    if (startDate || endDate) {
      compensationWhere.createdAt = {};
      if (startDate) compensationWhere.createdAt.gte = startDate;
      if (endDate) compensationWhere.createdAt.lte = endDate;
    }

    const compensations = await prisma.refund.findMany({
      where: compensationWhere,
      include: { escrow: true },
      orderBy: { createdAt: 'asc' }
    });

    // Group compensations by month
    const monthlyCompensations: Record<string, { total: Prisma.Decimal; count: number }> = {};
    
    compensations.forEach(refund => {
      const monthKey = refund.createdAt.toISOString().substring(0, 7); // YYYY-MM
      if (!monthlyCompensations[monthKey]) {
        monthlyCompensations[monthKey] = { total: new Prisma.Decimal('0'), count: 0 };
      }
      monthlyCompensations[monthKey].total = monthlyCompensations[monthKey].total.plus(refund.toOtherParty || new Prisma.Decimal('0'));
      monthlyCompensations[monthKey].count += 1;
    });

    // Combine and format results
    const allMonths = new Set([
      ...Object.keys(monthlyPayouts),
      ...Object.keys(monthlyCompensations)
    ]);

    const earnings = Array.from(allMonths)
      .sort()
      .map(period => {
        const payoutData = monthlyPayouts[period] || { total: new Prisma.Decimal('0'), count: 0 };
        const compensationData = monthlyCompensations[period] || { total: new Prisma.Decimal('0'), count: 0 };
        const totalEarnings = payoutData.total.plus(compensationData.total);

        return {
          period,
          totalEarnings: totalEarnings.toString(),
          fromPayouts: payoutData.total.toString(),
          fromCompensation: compensationData.total.toString(),
          payoutCount: payoutData.count,
          compensationCount: compensationData.count,
          labels: {
            fromPayouts: 'Completed Tasks',
            fromCompensation: 'Cancellations',
          },
        };
      });

    return {
      success: true,
      earnings
    };
  } catch (error: any) {
    logger.error('Error calculating earnings by period:', error);
    return {
      success: false,
      error: error.message || 'Failed to calculate earnings by period'
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
    // Get total earnings (uses cache)
    const earningsResult = await getUserEarnings(userId);
    if (!earningsResult.success || !earningsResult.earnings) {
      return earningsResult;
    }

    // Get profile for stats (cached)
    let profile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
    });

    // If missing or stale, recalculate
    if (!profile || (profile && isProfileStale(profile.lastUpdatedAt))) {
      await recalculateUserPaymentProfile(userId);
      profile = await prisma.userPaymentProfile.findUnique({
        where: { userId },
      });
    }

    // If no profile, return zeros
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

    // Get last compensation date (not cached, but infrequent query)
    const lastCompensation = await prisma.refund.findFirst({
      where: {
        escrow: {
          performerUid: userId,
        },
        cancelledBy: 'poster',
        toOtherParty: { not: null },
        status: 'completed',
      },
      orderBy: { createdAt: 'desc' },
    });
    const lastCompensationDate = lastCompensation?.createdAt.toISOString();

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
        lastCompensationDate,
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


