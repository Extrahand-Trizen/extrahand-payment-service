/**
 * Backfill walletRole for existing ExtraCoin rows.
 *
 * Defaults all legacy rows to tasker so data remains valid and non-destructive.
 * Supports dry-run (default) and execute mode.
 *
 * Usage:
 *   npx ts-node scripts/backfill-wallet-role.ts
 *   npx ts-node scripts/backfill-wallet-role.ts --execute
 */
import dotenv from 'dotenv';
import { prisma } from '../src/config/prisma';

dotenv.config();

const EXECUTE = process.argv.includes('--execute');

async function hasWalletRoleColumn(table: 'ExtraCoinWallet' | 'ExtraCoinTransaction'): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = '${table}'
         AND column_name = 'walletRole'
     ) AS exists`
  );
  return Boolean(rows[0]?.exists);
}

async function countNullWalletRole(table: 'ExtraCoinWallet' | 'ExtraCoinTransaction'): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "public"."${table}" WHERE "walletRole" IS NULL OR "walletRole" = ''`
  );
  return Number(rows[0]?.count || 0);
}

async function run(): Promise<void> {
  console.log(`[walletRole-backfill] mode=${EXECUTE ? 'EXECUTE' : 'DRY_RUN'}`);

  const [walletCount, txnCount] = await Promise.all([
    hasWalletRoleColumn('ExtraCoinWallet'),
    hasWalletRoleColumn('ExtraCoinTransaction'),
  ]);
  if (!walletCount || !txnCount) {
    console.log('[walletRole-backfill] walletRole column not found yet. Run DB migration first.');
    await prisma.$disconnect();
    return;
  }

  const [walletNullCount, txnNullCount] = await Promise.all([
    countNullWalletRole('ExtraCoinWallet'),
    countNullWalletRole('ExtraCoinTransaction'),
  ]);

  console.log(
    `[walletRole-backfill] pending wallets=${walletNullCount}, transactions=${txnNullCount}`
  );

  if (!EXECUTE) {
    console.log('[walletRole-backfill] no changes written (dry-run)');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE "public"."ExtraCoinWallet"
       SET "walletRole" = 'tasker'
       WHERE "walletRole" IS NULL OR "walletRole" = ''`
    );
    await tx.$executeRawUnsafe(
      `UPDATE "public"."ExtraCoinTransaction"
       SET "walletRole" = 'tasker'
       WHERE "walletRole" IS NULL OR "walletRole" = ''`
    );
  });

  const [walletAfter, txnAfter] = await Promise.all([
    countNullWalletRole('ExtraCoinWallet'),
    countNullWalletRole('ExtraCoinTransaction'),
  ]);

  console.log(
    `[walletRole-backfill] complete walletsRemaining=${walletAfter}, transactionsRemaining=${txnAfter}`
  );
  await prisma.$disconnect();
}

run().catch(async (error) => {
  console.error('[walletRole-backfill] failed', error);
  await prisma.$disconnect();
  process.exit(1);
});

