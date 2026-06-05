/**
 * Apply bank-account encryption columns (non-destructive).
 * - ADD COLUMN IF NOT EXISTS only — no DROP, DELETE, or TRUNCATE
 * - Verifies BankAccount row count unchanged before/after
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma';

dotenv.config();

async function countBankAccounts(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint AS count FROM "public"."BankAccount"`
  );
  return Number(rows[0]?.count || 0);
}

async function main(): Promise<void> {
  const before = await countBankAccounts();
  console.log('[migrate:bank-encryption] BEFORE BankAccount rows:', before);

  const sqlPath = path.join(
    __dirname,
    '../prisma/migrations/20260605000000_bank_account_encryption/migration.sql'
  );
  const sqlWithoutComments = fs
    .readFileSync(sqlPath, 'utf8')
    .replace(/--[^\n]*/g, '');
  const statements = sqlWithoutComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement);
  }

  const after = await countBankAccounts();
  console.log('[migrate:bank-encryption] AFTER BankAccount rows:', after);

  if (before !== after) {
    throw new Error('BankAccount row count changed — migration must not delete data');
  }

  console.log('[migrate:bank-encryption] SUCCESS: columns added, all existing rows preserved');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('[migrate:bank-encryption] FAILED:', error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
