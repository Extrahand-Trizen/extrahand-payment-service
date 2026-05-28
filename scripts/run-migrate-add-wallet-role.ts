/**
 * Apply migrate-add-wallet-role.sql with before/after row-count verification.
 * Non-destructive: only adds columns, backfills walletRole='tasker', adds indexes.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma';

dotenv.config();

async function countRows(table: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "public"."${table}"`
  );
  return Number(rows[0]?.count || 0);
}

async function main(): Promise<void> {
  const beforeWallet = await countRows('ExtraCoinWallet');
  const beforeTxn = await countRows('ExtraCoinTransaction');
  console.log('[migrate] BEFORE row counts:', { wallets: beforeWallet, transactions: beforeTxn });

  const sqlPath = path.join(__dirname, 'migrate-add-wallet-role.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const statements = sql
    .split(';')
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  const afterWallet = await countRows('ExtraCoinWallet');
  const afterTxn = await countRows('ExtraCoinTransaction');
  console.log('[migrate] AFTER row counts:', { wallets: afterWallet, transactions: afterTxn });

  if (beforeWallet !== afterWallet || beforeTxn !== afterTxn) {
    throw new Error('Row count changed unexpectedly — migration may have deleted data');
  }

  const distribution = await prisma.$queryRawUnsafe<
    Array<{ walletRole: string | null; cnt: bigint }>
  >(
    `SELECT "walletRole", COUNT(*)::bigint AS cnt
     FROM "public"."ExtraCoinWallet"
     GROUP BY "walletRole"
     ORDER BY "walletRole"`
  );
  console.log(
    '[migrate] walletRole distribution:',
    distribution.map((r) => ({ walletRole: r.walletRole, count: Number(r.cnt) }))
  );

  console.log('[migrate] SUCCESS: additive migration applied, no rows deleted');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('[migrate] FAILED', error);
  await prisma.$disconnect();
  process.exit(1);
});
