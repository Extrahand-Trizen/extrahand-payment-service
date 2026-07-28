/**
 * Delete referral ExtraCoin transactions and recalc wallet balances for user IDs.
 * Usage: npx ts-node --require dotenv/config scripts/clear-referral-coins-by-user.ts uid1 uid2
 */
import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma';

dotenv.config();

const REFERRAL_SOURCES = ['referral_welcome', 'referral_signup', 'referral_task_bonus'];

async function recalcWallet(userId: string, walletRole: string) {
  const earned = await prisma.extraCoinTransaction.aggregate({
    where: { userId, walletRole, type: 'earned', status: 'completed' },
    _sum: { coins: true, rupeeValue: true, remainingCoins: true, remainingRupees: true },
  });

  const used = await prisma.extraCoinTransaction.aggregate({
    where: { userId, walletRole, type: 'redeemed', status: 'completed' },
    _sum: { coins: true },
  });

  const balanceCoins = earned._sum.remainingCoins ?? new Prisma.Decimal(0);
  const balanceRupees = earned._sum.remainingRupees ?? new Prisma.Decimal(0);
  const lifetimeEarnedCoins = earned._sum.coins ?? new Prisma.Decimal(0);
  const lifetimeUsedCoins = used._sum.coins ?? new Prisma.Decimal(0);

  await prisma.extraCoinWallet.upsert({
    where: { userId_walletRole: { userId, walletRole } },
    create: {
      userId,
      walletRole,
      balanceCoins,
      balanceRupees,
      lifetimeEarnedCoins,
      lifetimeUsedCoins,
    },
    update: {
      balanceCoins,
      balanceRupees,
      lifetimeEarnedCoins,
      lifetimeUsedCoins,
      lastUpdatedAt: new Date(),
    },
  });
}

async function main() {
  const userIds = process.argv.slice(2).filter(Boolean);
  if (!userIds.length) {
    throw new Error('Provide at least one Firebase uid');
  }

  await prisma.$connect();

  for (const userId of userIds) {
    const allEarned = await prisma.extraCoinTransaction.findMany({
      where: { userId, type: 'earned', status: 'completed' },
      select: {
        id: true,
        transactionId: true,
        walletRole: true,
        coins: true,
        metadata: true,
      },
    });

    const referralTxs = allEarned.filter((tx) => {
      const source = String((tx.metadata as { source?: string } | null)?.source || '');
      return REFERRAL_SOURCES.some((s) => source === s || source.startsWith('referral_'));
    });

    console.log(`\n--- ${userId}: referral transactions ---`);
    console.log(referralTxs);

    if (referralTxs.length) {
      const deleted = await prisma.extraCoinTransaction.deleteMany({
        where: { id: { in: referralTxs.map((t) => t.id) } },
      });
      console.log('Deleted transactions:', deleted.count);
    }

    const walletRoles = [...new Set(referralTxs.map((t) => t.walletRole))];
    for (const role of walletRoles) {
      await recalcWallet(userId, role);
      console.log('Recalculated wallet:', userId, role);
    }
  }

  await prisma.$disconnect();
  console.log('\nDone.');
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
