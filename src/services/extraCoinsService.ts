import { Prisma } from '@prisma/client';
import mongoose from 'mongoose';
import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { issueGrant } from '../rewards/grants/GrantExecutor';
import type { GrantSpec } from '../rewards/types/GrantSpec';
import { UserServiceClient } from '../clients/UserServiceClient';
import { paymentRewardsFlags } from '../config/rewardsFlags';
import { parseWalletRole, type WalletRole } from '../rewards/utils/walletRole';

export type { WalletRole };

/** 1 ExtraCoin = ₹1 redeemable (must match user-service RewardProgram.coinEconomics.coinValueInr) */
const COIN_VALUE_INR = new Prisma.Decimal('1.00');
const COIN_EXPIRY_DAYS = 180;
const EXPIRING_SOON_DAYS = 7;
const DEFAULT_WALLET_ROLE: WalletRole = 'tasker';

const ZERO = new Prisma.Decimal('0.00');
const ONE = new Prisma.Decimal('1.00');

function toDecimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(String(value));
}

function maxDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.greaterThan(b) ? a : b;
}

function minDecimal(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return a.lessThan(b) ? a : b;
}

function generateCoinTransactionId(prefix: 'earned' | 'redeemed' | 'expired'): string {
  return `xcoin_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeWalletRole(role?: WalletRole | string): WalletRole {
  return parseWalletRole(role, DEFAULT_WALLET_ROLE);
}

function getBaseRewardPercent(taskAmount: Prisma.Decimal): Prisma.Decimal {
  if (taskAmount.lessThan(new Prisma.Decimal('200'))) return ZERO;
  if (taskAmount.lessThan(new Prisma.Decimal('400'))) return new Prisma.Decimal('0.05');
  if (taskAmount.lessThan(new Prisma.Decimal('800'))) return new Prisma.Decimal('0.10');
  if (taskAmount.lessThan(new Prisma.Decimal('1500'))) return new Prisma.Decimal('0.15');
  return new Prisma.Decimal('0.20');
}

async function getPerformerCoinContext(uid: string): Promise<{
  rating: Prisma.Decimal;
  ratingMultiplier: Prisma.Decimal;
  skillCertificateBonusPct: Prisma.Decimal;
}> {
  if (!uid) {
    return {
      rating: ZERO,
      ratingMultiplier: new Prisma.Decimal('0.80'),
      skillCertificateBonusPct: ZERO,
    };
  }

  if (paymentRewardsFlags.USE_USER_SERVICE_REWARD_CONTEXT) {
    const ctx = await UserServiceClient.getRewardContext(uid);
    if (ctx) {
      const rating = new Prisma.Decimal(Math.max(ctx.rating, 0).toFixed(2));
      return {
        rating,
        ratingMultiplier: new Prisma.Decimal(ctx.ratingMultiplier.toFixed(4)),
        skillCertificateBonusPct: new Prisma.Decimal(ctx.skillCertificateBonusPct.toFixed(4)),
      };
    }
    // Fail-open: user-service unreachable — use safe defaults so payout/earn is not blocked
    return {
      rating: ZERO,
      ratingMultiplier: new Prisma.Decimal('0.80'),
      skillCertificateBonusPct: ZERO,
    };
  }

  if (mongoose.connection.readyState !== 1) {
    return {
      rating: ZERO,
      ratingMultiplier: new Prisma.Decimal('0.80'),
      skillCertificateBonusPct: ZERO,
    };
  }

  try {
    const profileCollection = mongoose.connection.collection('profiles');
    const profile =
      (await profileCollection.findOne({ uid })) ||
      (mongoose.isValidObjectId(uid)
        ? await profileCollection.findOne({ _id: new mongoose.Types.ObjectId(uid) })
        : null);

    if (!profile) {
      return {
        rating: ZERO,
        // Missing profile should behave like an unrated user, not a hard block.
        ratingMultiplier: new Prisma.Decimal('0.80'),
        skillCertificateBonusPct: ZERO,
      };
    }

    const rawRating =
      typeof profile.rating === 'number' || typeof profile.rating === 'string'
        ? Number(profile.rating)
        : 0;
    const totalReviews =
      typeof profile.totalReviews === 'number' || typeof profile.totalReviews === 'string'
        ? Number(profile.totalReviews)
        : 0;

    const normalizedRating = Number.isFinite(rawRating) ? Math.max(rawRating, 0) : 0;
    const rating = new Prisma.Decimal(normalizedRating.toFixed(2));
    
    let ratingMultiplier: Prisma.Decimal;
    if (totalReviews === 0) {
      // Unrated users get a default base multiplier of 0.80
      ratingMultiplier = new Prisma.Decimal('0.80');
    } else {
      ratingMultiplier = rating.greaterThanOrEqualTo(new Prisma.Decimal('3.50'))
        ? minDecimal(rating.div(new Prisma.Decimal('5')).toDecimalPlaces(4), ONE)
        : ZERO;
    }

    const skillList =
      profile.skills &&
      typeof profile.skills === 'object' &&
      Array.isArray((profile.skills as { list?: unknown[] }).list)
        ? ((profile.skills as { list: Array<Record<string, unknown>> }).list || [])
        : [];

    const hasCertifiedSkill = skillList.some((skill) => {
      const directCertified = Boolean(skill?.certified === true || skill?.verified === true);
      const certificates = Array.isArray(skill?.certificates) ? skill.certificates : [];
      const hasVerifiedCertificate = certificates.some((certificate) => {
        if (!certificate || typeof certificate !== 'object') return false;
        const status = String((certificate as { status?: unknown }).status || '').toLowerCase();
        return status === 'verified';
      });
      return directCertified || hasVerifiedCertificate;
    });

    return {
      rating,
      ratingMultiplier,
      skillCertificateBonusPct: hasCertifiedSkill ? new Prisma.Decimal('0.10') : ZERO,
    };
  } catch (error) {
    logger.warn('[extraCoins] Failed to read performer profile context', { uid, error });
    return {
      rating: ZERO,
      ratingMultiplier: new Prisma.Decimal('0.80'),
      skillCertificateBonusPct: ZERO,
    };
  }
}

export async function expireExtraCoins(userId: string, walletRole: WalletRole = DEFAULT_WALLET_ROLE): Promise<{
  success: boolean;
  expiredCoins: string;
  expiredRupees: string;
  error?: string;
}> {
  try {
    if (!userId) {
      return { success: false, expiredCoins: '0.00', expiredRupees: '0.00', error: 'User ID is required' };
    }

    const now = new Date();
    const role = normalizeWalletRole(walletRole);
    const expiredEarnRows = await prisma.extraCoinTransaction.findMany({
      where: {
        userId,
        walletRole: role,
        type: 'earned',
        status: 'completed',
        expiresAt: { lt: now },
        remainingRupees: { gt: ZERO },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (expiredEarnRows.length === 0) {
      return { success: true, expiredCoins: '0.00', expiredRupees: '0.00' };
    }

    let totalExpiredCoins = ZERO;
    let totalExpiredRupees = ZERO;

    await prisma.$transaction(async (tx) => {
      for (const row of expiredEarnRows) {
        const rowExpiredRupees = toDecimal(row.remainingRupees || ZERO).toDecimalPlaces(2);
        if (rowExpiredRupees.lessThanOrEqualTo(ZERO)) continue;

        const rowExpiredCoins = toDecimal(row.remainingCoins || rowExpiredRupees.div(COIN_VALUE_INR)).toDecimalPlaces(2);

        totalExpiredCoins = totalExpiredCoins.plus(rowExpiredCoins).toDecimalPlaces(2);
        totalExpiredRupees = totalExpiredRupees.plus(rowExpiredRupees).toDecimalPlaces(2);

        await tx.extraCoinTransaction.update({
          where: { id: row.id },
          data: {
            remainingCoins: ZERO,
            remainingRupees: ZERO,
          },
        });

        await tx.extraCoinTransaction.create({
          data: {
            transactionId: generateCoinTransactionId('expired'),
            userId,
            walletRole: role,
            type: 'expired',
            status: 'completed',
            coins: rowExpiredCoins,
            rupeeValue: rowExpiredRupees,
            sourcePayoutId: row.sourcePayoutId || undefined,
            taskId: row.taskId || undefined,
            metadata: {
              sourceTransactionId: row.transactionId,
              sourceCreatedAt: row.createdAt.toISOString(),
              expiredAt: now.toISOString(),
            } as Prisma.JsonObject,
          },
        });
      }

      await tx.extraCoinWallet.upsert({
        where: { userId_walletRole: { userId, walletRole: role } },
        update: {
          balanceCoins: { decrement: totalExpiredCoins },
          balanceRupees: { decrement: totalExpiredRupees },
          lastUpdatedAt: now,
        },
        create: {
          userId,
          walletRole: role,
          balanceCoins: ZERO,
          balanceRupees: ZERO,
          lifetimeEarnedCoins: ZERO,
          lifetimeUsedCoins: ZERO,
          lastUpdatedAt: now,
        },
      });
    });

    return {
      success: true,
      expiredCoins: totalExpiredCoins.toString(),
      expiredRupees: totalExpiredRupees.toString(),
    };
  } catch (error: any) {
    logger.error('[extraCoins] Failed to expire ExtraCoins', { userId, walletRole, error });
    return {
      success: false,
      expiredCoins: '0.00',
      expiredRupees: '0.00',
      error: error?.message || 'Failed to expire ExtraCoins',
    };
  }
}

/**
 * Read-only estimate of redeemable coins (no wallet mutation).
 * Uses wallet balance and open earned lots so checkout matches capture redemption.
 */
export async function previewExtraCoinsRedemption(params: {
  userId: string;
  maxRedeemRupees: Prisma.Decimal;
  walletRole?: WalletRole;
}): Promise<{
  redeemableRupees: string;
  redeemableCoins: string;
}> {
  const walletRole = normalizeWalletRole(params.walletRole || 'tasker');
  const { userId } = params;

  await expireExtraCoins(userId, walletRole);

  const capRupees = maxDecimal(params.maxRedeemRupees.toDecimalPlaces(2), ZERO);
  if (capRupees.lessThanOrEqualTo(ZERO)) {
    return { redeemableRupees: '0.00', redeemableCoins: '0.00' };
  }

  const wallet = await prisma.extraCoinWallet.findUnique({
    where: { userId_walletRole: { userId, walletRole } },
  });
  const walletRupees = toDecimal(wallet?.balanceRupees || ZERO).toDecimalPlaces(2);
  if (walletRupees.lessThanOrEqualTo(ZERO)) {
    return { redeemableRupees: '0.00', redeemableCoins: '0.00' };
  }

  const earnRows = await prisma.extraCoinTransaction.findMany({
    where: {
      userId,
      walletRole,
      type: 'earned',
      status: 'completed',
      remainingRupees: { gt: ZERO },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { remainingRupees: true },
  });

  let earnAvailableRupees = ZERO;
  for (const row of earnRows) {
    earnAvailableRupees = earnAvailableRupees
      .plus(toDecimal(row.remainingRupees || ZERO).toDecimalPlaces(2))
      .toDecimalPlaces(2);
  }

  if (earnAvailableRupees.lessThanOrEqualTo(ZERO)) {
    return { redeemableRupees: '0.00', redeemableCoins: '0.00' };
  }

  const redeemRupees = minDecimal(walletRupees, minDecimal(capRupees, earnAvailableRupees)).toDecimalPlaces(2);
  if (redeemRupees.lessThanOrEqualTo(ZERO)) {
    return { redeemableRupees: '0.00', redeemableCoins: '0.00' };
  }

  return {
    redeemableRupees: redeemRupees.toString(),
    redeemableCoins: redeemRupees.div(COIN_VALUE_INR).toDecimalPlaces(2).toString(),
  };
}

export async function applyExtraCoinsForPayout(params: {
  userId: string;
  payoutId: string;
  taskId: string;
  maxRedeemRupees: Prisma.Decimal;
  walletRole?: WalletRole;
}): Promise<{
  success: boolean;
  redeemedCoins: string;
  redeemedRupees: string;
  sources: Array<{
    transactionId: string;
    redeemedCoins: string;
    redeemedRupees: string;
  }>;
  duplicate?: boolean;
  error?: string;
}> {
  const { userId, payoutId, taskId, maxRedeemRupees } = params;
  const walletRole = normalizeWalletRole(params.walletRole || 'tasker');

  try {
    const existingRedeem = await prisma.extraCoinTransaction.findFirst({
      where: {
        userId,
        walletRole,
        type: 'redeemed',
        status: 'completed',
        sourcePayoutId: payoutId,
      },
      select: {
        coins: true,
        rupeeValue: true,
        metadata: true,
      },
    });

    if (existingRedeem) {
      const metadata =
        existingRedeem.metadata && typeof existingRedeem.metadata === 'object' && !Array.isArray(existingRedeem.metadata)
          ? (existingRedeem.metadata as Record<string, unknown>)
          : {};
      const sourceEarnTransactions = Array.isArray(metadata.sourceEarnTransactions)
        ? metadata.sourceEarnTransactions
        : [];

      return {
        success: true,
        redeemedCoins: existingRedeem.coins.toString(),
        redeemedRupees: existingRedeem.rupeeValue.toString(),
        sources: sourceEarnTransactions.map((source: any) => ({
          transactionId: String(source?.transactionId || ''),
          redeemedCoins: String(source?.redeemedCoins || '0.00'),
          redeemedRupees: String(source?.redeemedRupees || '0.00'),
        })),
        duplicate: true,
      };
    }

    await expireExtraCoins(userId, walletRole);

    const capRupees = maxDecimal(maxRedeemRupees.toDecimalPlaces(2), ZERO);
    if (capRupees.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        redeemedCoins: '0.00',
        redeemedRupees: '0.00',
        sources: [],
      };
    }

    const wallet = await prisma.extraCoinWallet.findUnique({
      where: { userId_walletRole: { userId, walletRole } },
    });
    const walletRupees = toDecimal(wallet?.balanceRupees || ZERO).toDecimalPlaces(2);

    if (walletRupees.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        redeemedCoins: '0.00',
        redeemedRupees: '0.00',
        sources: [],
      };
    }

    const redeemRupees = minDecimal(walletRupees, capRupees).toDecimalPlaces(2);
    if (redeemRupees.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        redeemedCoins: '0.00',
        redeemedRupees: '0.00',
        sources: [],
      };
    }

    const earnRows = await prisma.extraCoinTransaction.findMany({
      where: {
        userId,
        walletRole,
        type: 'earned',
        status: 'completed',
        remainingRupees: { gt: ZERO },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });

    if (earnRows.length === 0) {
      return {
        success: true,
        redeemedCoins: '0.00',
        redeemedRupees: '0.00',
        sources: [],
      };
    }

    let remainingToRedeem = redeemRupees;
    let totalRedeemedRupees = ZERO;
    let totalRedeemedCoins = ZERO;
    const sourceRows: Array<{
      id: string;
      transactionId: string;
      newRemainingRupees: Prisma.Decimal;
      newRemainingCoins: Prisma.Decimal;
      redeemedRupees: Prisma.Decimal;
      redeemedCoins: Prisma.Decimal;
    }> = [];

    for (const row of earnRows) {
      if (remainingToRedeem.lessThanOrEqualTo(ZERO)) break;

      const rowRemainingRupees = toDecimal(row.remainingRupees || ZERO).toDecimalPlaces(2);
      if (rowRemainingRupees.lessThanOrEqualTo(ZERO)) continue;

      const takeRupees = minDecimal(rowRemainingRupees, remainingToRedeem).toDecimalPlaces(2);
      const takeCoins = takeRupees.div(COIN_VALUE_INR).toDecimalPlaces(2);

      const rowRemainingCoins = toDecimal(row.remainingCoins || rowRemainingRupees.div(COIN_VALUE_INR)).toDecimalPlaces(2);
      const newRemainingRupees = rowRemainingRupees.minus(takeRupees).toDecimalPlaces(2);
      const newRemainingCoins = maxDecimal(rowRemainingCoins.minus(takeCoins).toDecimalPlaces(2), ZERO);

      sourceRows.push({
        id: row.id,
        transactionId: row.transactionId,
        newRemainingRupees,
        newRemainingCoins,
        redeemedRupees: takeRupees,
        redeemedCoins: takeCoins,
      });

      totalRedeemedRupees = totalRedeemedRupees.plus(takeRupees).toDecimalPlaces(2);
      totalRedeemedCoins = totalRedeemedCoins.plus(takeCoins).toDecimalPlaces(2);
      remainingToRedeem = remainingToRedeem.minus(takeRupees).toDecimalPlaces(2);
   }

    if (totalRedeemedRupees.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        redeemedCoins: '0.00',
        redeemedRupees: '0.00',
        sources: [],
      };
    }

    await prisma.$transaction(async (tx) => {
      for (const source of sourceRows) {
        await tx.extraCoinTransaction.update({
          where: { id: source.id },
          data: {
            remainingRupees: source.newRemainingRupees,
            remainingCoins: source.newRemainingCoins,
          },
        });
      }

      await tx.extraCoinTransaction.create({
        data: {
          transactionId: generateCoinTransactionId('redeemed'),
          userId,
          walletRole,
          type: 'redeemed',
          status: 'completed',
          coins: totalRedeemedCoins,
          rupeeValue: totalRedeemedRupees,
          sourcePayoutId: payoutId,
          taskId,
          metadata: {
            payoutId,
            sourceEarnTransactions: sourceRows.map((source) => ({
              transactionId: source.transactionId,
              redeemedCoins: source.redeemedCoins.toString(),
              redeemedRupees: source.redeemedRupees.toString(),
            })),
          } as Prisma.JsonObject,
        },
      });

      await tx.extraCoinWallet.upsert({
        where: { userId_walletRole: { userId, walletRole } },
        update: {
          balanceCoins: { decrement: totalRedeemedCoins },
          balanceRupees: { decrement: totalRedeemedRupees },
          lifetimeUsedCoins: { increment: totalRedeemedCoins },
          lastUpdatedAt: new Date(),
        },
        create: {
          userId,
          walletRole,
          balanceCoins: ZERO,
          balanceRupees: ZERO,
          lifetimeEarnedCoins: ZERO,
          lifetimeUsedCoins: totalRedeemedCoins,
          lastUpdatedAt: new Date(),
        },
      });
    });

    return {
      success: true,
      redeemedCoins: totalRedeemedCoins.toString(),
      redeemedRupees: totalRedeemedRupees.toString(),
      sources: sourceRows.map((source) => ({
        transactionId: source.transactionId,
        redeemedCoins: source.redeemedCoins.toString(),
        redeemedRupees: source.redeemedRupees.toString(),
      })),
    };
  } catch (error: any) {
    logger.error('[extraCoins] Failed to redeem ExtraCoins', {
      userId,
      payoutId,
      walletRole,
      error,
    });
    return {
      success: false,
      redeemedCoins: '0.00',
      redeemedRupees: '0.00',
      sources: [],
      error: error?.message || 'Failed to redeem ExtraCoins',
    };
  }
}

export async function applyExtraCoinsForBooking(params: {
  userId: string;
  bookingId: string;
  taskId: string;
  maxRedeemRupees: Prisma.Decimal;
}): Promise<{
  success: boolean;
  redeemedCoins: string;
  redeemedRupees: string;
  sources: Array<{
    transactionId: string;
    redeemedCoins: string;
    redeemedRupees: string;
  }>;
  duplicate?: boolean;
  error?: string;
}> {
  return applyExtraCoinsForPayout({
    userId: params.userId,
    payoutId: `booking:${params.bookingId}`,
    taskId: params.taskId,
    maxRedeemRupees: params.maxRedeemRupees,
    walletRole: 'poster',
  });
}

export async function awardExtraCoinsForCompletedTask(params: {
  userId: string;
  payoutId: string;
  taskId: string;
  taskAmountRupees: Prisma.Decimal;
  platformFeeRupees: Prisma.Decimal;
  walletRole?: WalletRole;
}): Promise<{
  success: boolean;
  awardedCoins: string;
  awardedRupees: string;
  details: {
    baseRewardPercent: string;
    rating: string;
    ratingMultiplier: string;
    onboardingBonusPct: string;
    skillCertificateBonusPct: string;
    totalBonusMultiplier: string;
  };
  reason?: string;
  error?: string;
}> {
  const { userId, payoutId, taskId, taskAmountRupees, platformFeeRupees } = params;
  const walletRole = normalizeWalletRole(params.walletRole || 'tasker');

  try {
    await expireExtraCoins(userId, walletRole);

    const baseRewardPercent = getBaseRewardPercent(taskAmountRupees).toDecimalPlaces(4);
    if (baseRewardPercent.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        awardedCoins: '0.00',
        awardedRupees: '0.00',
        details: {
          baseRewardPercent: baseRewardPercent.toString(),
          rating: '0.00',
          ratingMultiplier: '0.00',
          onboardingBonusPct: '0.00',
          skillCertificateBonusPct: '0.00',
          totalBonusMultiplier: '1.00',
        },
        reason: 'task_value_below_threshold',
      };
    }

    const profileContext = await getPerformerCoinContext(userId);
    if (profileContext.ratingMultiplier.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        awardedCoins: '0.00',
        awardedRupees: '0.00',
        details: {
          baseRewardPercent: baseRewardPercent.toString(),
          rating: profileContext.rating.toString(),
          ratingMultiplier: profileContext.ratingMultiplier.toString(),
          onboardingBonusPct: '0.00',
          skillCertificateBonusPct: profileContext.skillCertificateBonusPct.toString(),
          totalBonusMultiplier: '1.00',
        },
        reason: 'rating_below_minimum',
      };
    }

    const completedTaskCount = await prisma.payout.count({
      where: {
        performerUid: userId,
        type: 'task_completion',
        status: { in: ['processing', 'completed'] },
      },
    });

    const onboardingBonusPct = completedTaskCount <= 10
      ? new Prisma.Decimal('0.50')
      : ZERO;

    const totalBonusMultiplier = ONE
      .plus(onboardingBonusPct)
      .plus(profileContext.skillCertificateBonusPct)
      .toDecimalPlaces(4);

    const rewardRupees = platformFeeRupees
      .mul(baseRewardPercent)
      .mul(profileContext.ratingMultiplier)
      .mul(totalBonusMultiplier)
      .toDecimalPlaces(2);

    if (rewardRupees.lessThanOrEqualTo(ZERO)) {
      return {
        success: true,
        awardedCoins: '0.00',
        awardedRupees: '0.00',
        details: {
          baseRewardPercent: baseRewardPercent.toString(),
          rating: profileContext.rating.toString(),
          ratingMultiplier: profileContext.ratingMultiplier.toString(),
          onboardingBonusPct: onboardingBonusPct.toString(),
          skillCertificateBonusPct: profileContext.skillCertificateBonusPct.toString(),
          totalBonusMultiplier: totalBonusMultiplier.toString(),
        },
        reason: 'computed_zero_reward',
      };
    }

    const rewardCoins = rewardRupees.div(COIN_VALUE_INR).toDecimalPlaces(2);
    const expiresAt = new Date(Date.now() + COIN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const detailsPayload = {
      baseRewardPercent: baseRewardPercent.toString(),
      rating: profileContext.rating.toString(),
      ratingMultiplier: profileContext.ratingMultiplier.toString(),
      onboardingBonusPct: onboardingBonusPct.toString(),
      skillCertificateBonusPct: profileContext.skillCertificateBonusPct.toString(),
      totalBonusMultiplier: totalBonusMultiplier.toString(),
    };

    const grantResult = await issueGrant({
      idempotencyKey: `task:earn:${taskId}:${userId}`,
      recipientUid: userId,
      walletRole,
      coins: rewardCoins.toString(),
      rupeeValue: rewardRupees.toString(),
      expiresAt: expiresAt.toISOString(),
      taskId,
      sourcePayoutId: payoutId,
      metadata: {
        source: 'task_completion',
        taskId,
        taskAmount: taskAmountRupees.toString(),
        platformFee: platformFeeRupees.toString(),
        ...detailsPayload,
        coinValueInr: COIN_VALUE_INR.toString(),
        formula: 'coins = (platformFee * basePercent) * ratingMultiplier * (1 + bonuses) / coinValueInr (1 coin = ₹1)',
      },
    });

    if (!grantResult.success) {
      return {
        success: false,
        awardedCoins: '0.00',
        awardedRupees: '0.00',
        details: { ...detailsPayload, totalBonusMultiplier: totalBonusMultiplier.toString() },
        error: grantResult.error || 'Failed to award ExtraCoins',
      };
    }

    return {
      success: true,
      awardedCoins: grantResult.coins,
      awardedRupees: grantResult.rupeeValue,
      details: detailsPayload,
      ...(grantResult.duplicate ? { reason: 'already_awarded' as const } : {}),
    };
  } catch (error: any) {
    logger.error('[extraCoins] Failed to award ExtraCoins', {
      userId,
      payoutId,
      taskId,
      walletRole,
      error,
    });
    return {
      success: false,
      awardedCoins: '0.00',
      awardedRupees: '0.00',
      details: {
        baseRewardPercent: '0.00',
        rating: '0.00',
        ratingMultiplier: '0.00',
        onboardingBonusPct: '0.00',
        skillCertificateBonusPct: '0.00',
        totalBonusMultiplier: '1.00',
      },
      error: error?.message || 'Failed to award ExtraCoins',
    };
  }
}

async function backfillMissingExtraCoinsForWallet(
  userId: string,
  walletRole: WalletRole = 'tasker'
): Promise<void> {
  if (!userId) return;

  const payouts = await prisma.payout.findMany({
    where: {
      performerUid: userId,
      type: 'task_completion',
      status: 'completed',
    },
    orderBy: { createdAt: 'asc' },
    select: {
      payoutId: true,
      performerUid: true,
      amount: true,
      platformCommission: true,
      metadata: true,
    },
  });

  for (const payout of payouts) {
    const metadata =
      payout.metadata && typeof payout.metadata === 'object' && !Array.isArray(payout.metadata)
        ? (payout.metadata as Record<string, unknown>)
        : {};
    const taskId = typeof metadata.taskId === 'string' ? metadata.taskId : '';

    if (!taskId) continue;

    await awardExtraCoinsForCompletedTask({
      userId: payout.performerUid,
      payoutId: payout.payoutId,
      taskId,
      taskAmountRupees: new Prisma.Decimal(String(metadata.taskAmount || payout.amount || '0')),
      platformFeeRupees: new Prisma.Decimal(String(metadata.platformFee || payout.platformCommission || '0')),
      walletRole,
    });
  }
}

export async function getExtraCoinsWallet(
  userId: string,
  linkedUserIds?: string[],
  walletRole: WalletRole = DEFAULT_WALLET_ROLE
): Promise<{
  success: boolean;
  wallet?: {
    coinToRupee: string;
    totalCoins: string;
    totalRupeeValue: string;
    lifetimeEarnedCoins: string;
    lifetimeUsedCoins: string;
    lifetimeExpiredCoins: string;
    earnedHistory: Array<{
      transactionId: string;
      coins: string;
      rupeeValue: string;
      taskId?: string;
      sourcePayoutId?: string;
      createdAt: string;
      expiresAt?: string;
      remainingCoins?: string;
      remainingRupees?: string;
      metadata?: Record<string, unknown>;
    }>;
    usedHistory: Array<{
      transactionId: string;
      coins: string;
      rupeeValue: string;
      taskId?: string;
      sourcePayoutId?: string;
      createdAt: string;
      metadata?: Record<string, unknown>;
    }>;
    expiringSoon: Array<{
      transactionId: string;
      coins: string;
      rupeeValue: string;
      expiresAt: string;
      taskId?: string;
      sourcePayoutId?: string;
      createdAt: string;
    }>;
  };
  error?: string;
}> {
  try {
    const role = normalizeWalletRole(walletRole);
    const allUserIds = Array.from(
      new Set(
        [userId, ...(linkedUserIds || [])]
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter((id) => id.length > 0)
      )
    );

    if (allUserIds.length === 0) {
      return {
        success: false,
        error: 'User ID is required',
      };
    }

    // Expire stale coins only — awards happen at payout completion (payoutService), not on read.
    await Promise.all(allUserIds.map((id) => expireExtraCoins(id, role)));

    const now = new Date();
    const expiringSoonDate = new Date(now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);

    const walletWhere =
      allUserIds.length === 1
        ? { userId: allUserIds[0], walletRole: role }
        : { userId: { in: allUserIds }, walletRole: role };

    const [walletRows, lifetimeExpiredAgg, earnedRows, usedRows, expiringRows] = await Promise.all([
      prisma.extraCoinWallet.findMany({ where: walletWhere }),
      prisma.extraCoinTransaction.aggregate({
        where: { ...walletWhere, type: 'expired', status: 'completed' },
        _sum: { coins: true },
      }),
      prisma.extraCoinTransaction.findMany({
        where: { ...walletWhere, type: 'earned', status: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.extraCoinTransaction.findMany({
        where: { ...walletWhere, type: 'redeemed', status: 'completed' },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
      prisma.extraCoinTransaction.findMany({
        where: {
          ...walletWhere,
          type: 'earned',
          status: 'completed',
          remainingRupees: { gt: ZERO },
          expiresAt: {
            gte: now,
            lte: expiringSoonDate,
          },
        },
        orderBy: { expiresAt: 'asc' },
      }),
    ]);

    const mergedWallet = walletRows.reduce(
      (acc, row) => {
        acc.balanceCoins = acc.balanceCoins.plus(toDecimal(row.balanceCoins || ZERO));
        acc.balanceRupees = acc.balanceRupees.plus(toDecimal(row.balanceRupees || ZERO));
        acc.lifetimeEarnedCoins = acc.lifetimeEarnedCoins.plus(toDecimal(row.lifetimeEarnedCoins || ZERO));
        acc.lifetimeUsedCoins = acc.lifetimeUsedCoins.plus(toDecimal(row.lifetimeUsedCoins || ZERO));
        return acc;
      },
      {
        balanceCoins: ZERO,
        balanceRupees: ZERO,
        lifetimeEarnedCoins: ZERO,
        lifetimeUsedCoins: ZERO,
      }
    );

    return {
      success: true,
      wallet: {
        coinToRupee: COIN_VALUE_INR.toString(),
        totalCoins: mergedWallet.balanceCoins.toDecimalPlaces(2).toString(),
        totalRupeeValue: mergedWallet.balanceRupees.toDecimalPlaces(2).toString(),
        lifetimeEarnedCoins: mergedWallet.lifetimeEarnedCoins.toDecimalPlaces(2).toString(),
        lifetimeUsedCoins: mergedWallet.lifetimeUsedCoins.toDecimalPlaces(2).toString(),
        lifetimeExpiredCoins: toDecimal(lifetimeExpiredAgg._sum.coins || ZERO).toDecimalPlaces(2).toString(),
        earnedHistory: earnedRows.map((row) => ({
          transactionId: row.transactionId,
          coins: row.coins.toString(),
          rupeeValue: row.rupeeValue.toString(),
          taskId: row.taskId || undefined,
          sourcePayoutId: row.sourcePayoutId || undefined,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString(),
          remainingCoins: row.remainingCoins?.toString(),
          remainingRupees: row.remainingRupees?.toString(),
          metadata:
            row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
              ? (row.metadata as Record<string, unknown>)
              : undefined,
        })),
        usedHistory: usedRows.map((row) => ({
          transactionId: row.transactionId,
          coins: row.coins.toString(),
          rupeeValue: row.rupeeValue.toString(),
          taskId: row.taskId || undefined,
          sourcePayoutId: row.sourcePayoutId || undefined,
          createdAt: row.createdAt.toISOString(),
          metadata:
            row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
              ? (row.metadata as Record<string, unknown>)
              : undefined,
        })),
        expiringSoon: expiringRows.map((row) => ({
          transactionId: row.transactionId,
          coins: toDecimal(row.remainingCoins || ZERO).toDecimalPlaces(2).toString(),
          rupeeValue: toDecimal(row.remainingRupees || ZERO).toDecimalPlaces(2).toString(),
          expiresAt: row.expiresAt?.toISOString() || now.toISOString(),
          taskId: row.taskId || undefined,
          sourcePayoutId: row.sourcePayoutId || undefined,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    };
  } catch (error: any) {
    logger.error('[extraCoins] Failed to fetch wallet data', { userId, error });
    return {
      success: false,
      error: error?.message || 'Failed to fetch ExtraCoins wallet',
    };
  }
}

