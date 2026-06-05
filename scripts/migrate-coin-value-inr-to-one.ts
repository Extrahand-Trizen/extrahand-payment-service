/**
 * Align ExtraCoins rupee balances to 1 coin = ₹1 (no deletes).
 *
 * Updates remainingRupees on open earned lots and recomputes wallet balanceRupees.
 * Idempotent: skips rows already at 1:1 (|remainingRupees - remainingCoins| < 0.01).
 *
 * Usage:
 *   npx ts-node scripts/migrate-coin-value-inr-to-one.ts           # dry-run (default)
 *   npx ts-node scripts/migrate-coin-value-inr-to-one.ts --execute
 *   npx ts-node scripts/migrate-coin-value-inr-to-one.ts --execute --userId=<firebaseUid>
 */
import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/prisma';

dotenv.config();

const ZERO = new Prisma.Decimal('0.00');
const TOLERANCE = new Prisma.Decimal('0.01');
const MIGRATION_TAG = 'coinValueInr_1_00_migration';

function toDecimal(value: Prisma.Decimal | string | number | null | undefined): Prisma.Decimal {
  if (value == null) return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(String(value));
}

function isAlreadyOneToOne(remainingCoins: Prisma.Decimal, remainingRupees: Prisma.Decimal): boolean {
  if (remainingCoins.lessThanOrEqualTo(ZERO)) return true;
  return remainingRupees.minus(remainingCoins).abs().lessThanOrEqualTo(TOLERANCE);
}

function mergeMetadata(
  existing: Prisma.JsonValue | null | undefined,
  patch: Record<string, unknown>
): Prisma.JsonObject {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...patch } as Prisma.JsonObject;
}

async function recomputeWalletBalance(userId: string): Promise<{
  balanceCoins: Prisma.Decimal;
  balanceRupees: Prisma.Decimal;
}> {
  const now = new Date();
  const earnedRows = await prisma.extraCoinTransaction.findMany({
    where: { userId, type: 'earned', status: 'completed' },
  });

  let balanceCoins = ZERO;
  let balanceRupees = ZERO;

  for (const row of earnedRows) {
    if (row.expiresAt && row.expiresAt < now) continue;

    const remainingCoins = toDecimal(row.remainingCoins);
    const remainingRupees = toDecimal(row.remainingRupees);
    if (remainingCoins.lessThanOrEqualTo(ZERO) && remainingRupees.lessThanOrEqualTo(ZERO)) {
      continue;
    }

    balanceCoins = balanceCoins.plus(remainingCoins).toDecimalPlaces(2);
    balanceRupees = balanceRupees.plus(remainingRupees).toDecimalPlaces(2);
  }

  return { balanceCoins, balanceRupees };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const userIdArg = args.find((a) => a.startsWith('--userId='))?.split('=')[1]?.trim();

  console.log(`\n[ExtraCoins migration] 1 coin = ₹1 (${execute ? 'EXECUTE' : 'DRY-RUN'})\n`);

  const earnedWhere: Prisma.ExtraCoinTransactionWhereInput = {
    type: 'earned',
    status: 'completed',
    OR: [{ remainingCoins: { gt: ZERO } }, { remainingRupees: { gt: ZERO } }],
    ...(userIdArg ? { userId: userIdArg } : {}),
  };

  const earnedRows = await prisma.extraCoinTransaction.findMany({
    where: earnedWhere,
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
  });

  const txPlans: Array<{
    id: string;
    transactionId: string;
    userId: string;
    remainingCoins: string;
    fromRupees: string;
    toRupees: string;
  }> = [];

  for (const row of earnedRows) {
    const remainingCoins = toDecimal(row.remainingCoins ?? row.coins).toDecimalPlaces(2);
    const remainingRupees = toDecimal(row.remainingRupees ?? row.rupeeValue).toDecimalPlaces(2);

    if (remainingCoins.lessThanOrEqualTo(ZERO) && remainingRupees.lessThanOrEqualTo(ZERO)) {
      continue;
    }

    const targetCoins = remainingCoins.greaterThan(ZERO)
      ? remainingCoins
      : remainingRupees.toDecimalPlaces(2);
    const targetRupees = targetCoins;

    if (isAlreadyOneToOne(targetCoins, remainingRupees)) {
      continue;
    }

    txPlans.push({
      id: row.id,
      transactionId: row.transactionId,
      userId: row.userId,
      remainingCoins: targetCoins.toString(),
      fromRupees: remainingRupees.toString(),
      toRupees: targetRupees.toString(),
    });
  }

  const userIds = Array.from(new Set(txPlans.map((p) => p.userId)));
  const walletPlans: Array<{
    userId: string;
    beforeCoins: string;
    beforeRupees: string;
    afterCoins: string;
    afterRupees: string;
  }> = [];

  const rowsForSimulation = earnedRows.map((row) => ({ ...row }));

  for (const userId of userIds) {
    const wallet = await prisma.extraCoinWallet.findUnique({ where: { userId } });

    if (!execute) {
      for (const plan of txPlans.filter((p) => p.userId === userId)) {
        const row = rowsForSimulation.find((r) => r.id === plan.id);
        if (!row) continue;
        row.remainingRupees = new Prisma.Decimal(plan.toRupees);
        row.remainingCoins = new Prisma.Decimal(plan.remainingCoins);
      }
    }

    let afterCoins = ZERO;
    let afterRupees = ZERO;
    const now = new Date();
    for (const row of rowsForSimulation.filter((r) => r.userId === userId)) {
      if (row.expiresAt && row.expiresAt < now) continue;
      const rc = toDecimal(row.remainingCoins);
      const rr = toDecimal(row.remainingRupees);
      if (rc.lessThanOrEqualTo(ZERO) && rr.lessThanOrEqualTo(ZERO)) continue;
      afterCoins = afterCoins.plus(rc).toDecimalPlaces(2);
      afterRupees = afterRupees.plus(rr).toDecimalPlaces(2);
    }

    walletPlans.push({
      userId,
      beforeCoins: toDecimal(wallet?.balanceCoins).toString(),
      beforeRupees: toDecimal(wallet?.balanceRupees).toString(),
      afterCoins: afterCoins.toString(),
      afterRupees: afterRupees.toString(),
    });
  }

  console.log(`Earned lots to update: ${txPlans.length}`);
  console.log(`Wallets to reconcile: ${userIds.length}\n`);

  if (txPlans.length > 0) {
    console.log('Sample transaction updates (first 10):');
    for (const plan of txPlans.slice(0, 10)) {
      console.log(
        `  ${plan.userId} ${plan.transactionId}: remainingRupees ${plan.fromRupees} -> ${plan.toRupees} (coins=${plan.remainingCoins})`
      );
    }
    if (txPlans.length > 10) console.log(`  ... and ${txPlans.length - 10} more`);
  }

  if (walletPlans.length > 0) {
    console.log('\nWallet balance changes:');
    for (const w of walletPlans.slice(0, 20)) {
      console.log(
        `  ${w.userId}: coins ${w.beforeCoins} -> ${w.afterCoins}, rupees ${w.beforeRupees} -> ${w.afterRupees}`
      );
    }
    if (walletPlans.length > 20) console.log(`  ... and ${walletPlans.length - 20} more wallets`);
  }

  if (!execute) {
    console.log('\nNo changes written. Re-run with --execute to apply.\n');
    await prisma.$disconnect();
    return;
  }

  const migratedAt = new Date().toISOString();
  let updatedTx = 0;

  await prisma.$transaction(async (tx) => {
    for (const plan of txPlans) {
      const row = earnedRows.find((r) => r.id === plan.id);
      if (!row) continue;

      const remainingCoins = toDecimal(plan.remainingCoins);
      const targetRupees = toDecimal(plan.toRupees);
      const priorRupees = toDecimal(plan.fromRupees);

      await tx.extraCoinTransaction.update({
        where: { id: plan.id },
        data: {
          remainingCoins,
          remainingRupees: targetRupees,
          metadata: mergeMetadata(row.metadata, {
            [MIGRATION_TAG]: {
              migratedAt,
              fromRemainingRupees: priorRupees.toString(),
              toRemainingRupees: targetRupees.toString(),
              coinValueInr: '1.00',
            },
          }),
        },
      });
      updatedTx += 1;
    }
  });

  let updatedWallets = 0;
  const allUserIds = userIdArg
    ? [userIdArg]
    : Array.from(
        new Set([
          ...userIds,
          ...(await prisma.extraCoinWallet.findMany({ select: { userId: true } })).map((w) => w.userId),
        ])
      );

  for (const userId of allUserIds) {
    const { balanceCoins, balanceRupees } = await recomputeWalletBalance(userId);
    const wallet = await prisma.extraCoinWallet.findUnique({ where: { userId } });

    if (!wallet && balanceCoins.lessThanOrEqualTo(ZERO) && balanceRupees.lessThanOrEqualTo(ZERO)) {
      continue;
    }

    const beforeCoins = toDecimal(wallet?.balanceCoins);
    const beforeRupees = toDecimal(wallet?.balanceRupees);
    const needsUpdate =
      !wallet ||
      beforeCoins.minus(balanceCoins).abs().greaterThan(TOLERANCE) ||
      beforeRupees.minus(balanceRupees).abs().greaterThan(TOLERANCE);

    if (!needsUpdate) continue;

    await prisma.extraCoinWallet.upsert({
      where: { userId },
      update: {
        balanceCoins,
        balanceRupees,
        lastUpdatedAt: new Date(),
      },
      create: {
        userId,
        balanceCoins,
        balanceRupees,
        lifetimeEarnedCoins: balanceCoins,
        lifetimeUsedCoins: ZERO,
        lastUpdatedAt: new Date(),
      },
    });
    updatedWallets += 1;
  }

  console.log(`\nApplied: ${updatedTx} earned lots updated, ${updatedWallets} wallets reconciled.\n`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
