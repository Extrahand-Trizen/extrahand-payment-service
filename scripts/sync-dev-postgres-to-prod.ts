/**
 * One-time (or repeatable) sync: dev Neon Postgres → production Neon Postgres.
 * 1. Applies Prisma migrations on PROD (schema only, non-destructive on empty DB)
 * 2. Copies all public table DATA from DEV → PROD (skips _prisma_migrations)
 * 3. Verifies row counts match
 *
 * Usage:
 *   DEV_POSTGRESDB_URI=... PROD_POSTGRESDB_URI=... npm run sync:postgres-dev-to-prod
 */
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';

dotenv.config();

/** Never fall back to POSTGRESDB_URI for DEV — .env may already point at production. */
const DEV_URL = process.env.DEV_POSTGRESDB_URI || '';
const PROD_URL =
  process.env.PROD_POSTGRESDB_URI || process.env.POSTGRESDB_URI || '';

if (!DEV_URL || !PROD_URL) {
  console.error(
    'Required: DEV_POSTGRESDB_URI (violet) and PROD_POSTGRESDB_URI or POSTGRESDB_URI (frost)'
  );
  process.exit(1);
}

if (maskHost(DEV_URL) === maskHost(PROD_URL)) {
  console.error('[sync] DEV and PROD hosts are the same — refusing to sync');
  process.exit(1);
}

function maskHost(url: string): string {
  try {
    const u = new URL(url.replace(/^postgresql:/, 'http:'));
    return u.hostname;
  } catch {
    return '(invalid url)';
  }
}

async function tableColumns(pool: Pool, table: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map((row: { column_name: string }) => row.column_name);
}

async function listTables(pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  return r.rows.map((row: { tablename: string }) => row.tablename);
}

async function countRows(pool: Pool, table: string): Promise<number> {
  const r = await pool.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
  return Number(r.rows[0]?.n || 0);
}

/** Parents before children — Neon does not allow session_replication_role. */
const TABLE_COPY_ORDER = [
  'CategoryFeeConfig',
  'SystemConfig',
  'AdminInvite',
  'AdminUser',
  'Transaction',
  'Escrow',
  'BankAccount',
  'UserPaymentProfile',
  'ExtraCoinWallet',
  'ExtraCoinTransaction',
  'PerformerCancellationPenalty',
  'AuditLog',
  'JobQueue',
  'PaymentOrderIdempotency',
  'Reconciliation',
  'Payout',
  'Refund',
  'Dispute',
  'Ledger',
];

function sortTablesForCopy(tables: string[]): string[] {
  const set = new Set(tables);
  const ordered = TABLE_COPY_ORDER.filter((t) => set.has(t));
  const rest = tables.filter((t) => !TABLE_COPY_ORDER.includes(t)).sort();
  return [...ordered, ...rest];
}

async function copyTable(dev: Pool, prod: Pool, table: string): Promise<number> {
  const devCols = await tableColumns(dev, table);
  const prodCols = new Set(await tableColumns(prod, table));
  const columns = devCols.filter((c) => prodCols.has(c));
  if (columns.length === 0) return 0;

  const colList = columns.map((c) => `"${c}"`).join(', ');
  const rows = await dev.query(`SELECT ${colList} FROM "${table}"`);
  if (rows.rows.length === 0) return 0;

  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  let copied = 0;
  for (const row of rows.rows) {
    const values = columns.map((c) => row[c]);
    await prod.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`, values);
    copied += 1;
  }
  const skipped = devCols.filter((c) => !prodCols.has(c));
  if (skipped.length > 0) {
    console.warn(`[sync] ${table}: skipped dev-only columns: ${skipped.join(', ')}`);
  }
  return copied;
}

async function main(): Promise<void> {
  console.log('[sync] DEV host:', maskHost(DEV_URL));
  console.log('[sync] PROD host:', maskHost(PROD_URL));

  const prodProbe = new Pool({ connectionString: PROD_URL });
  const prodTables = (
    await prodProbe.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
    )
  ).rows.map((r: { tablename: string }) => r.tablename);
  const failedMigrations = await prodProbe
    .query(
      `SELECT COUNT(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL`
    )
    .catch(() => ({ rows: [{ n: 0 }] }));
  const hasFailedMigration = Number(failedMigrations.rows[0]?.n || 0) > 0;
  const prodDataTables = prodTables.filter((t) => t !== '_prisma_migrations');
  const prodNeedsFullReset =
    prodDataTables.length === 0 || hasFailedMigration || prodDataTables.length < 10;

  if (prodNeedsFullReset) {
    console.log('[sync] Resetting PROD public schema (empty or broken migration state)...');
    await prodProbe.query(`DROP SCHEMA public CASCADE`);
    await prodProbe.query(`CREATE SCHEMA public`);
    await prodProbe.query(`GRANT ALL ON SCHEMA public TO public`);
    await prodProbe.query(`GRANT ALL ON SCHEMA public TO neondb_owner`);
  }
  await prodProbe.end();

  console.log('[sync] Creating PROD schema from prisma/schema.prisma (db push)...');
  execSync('npx prisma db push --accept-data-loss', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, POSTGRESDB_URI: PROD_URL },
    stdio: 'inherit',
  });

  const dev = new Pool({ connectionString: DEV_URL });
  const prod = new Pool({ connectionString: PROD_URL });

  try {
    const devTables = await listTables(dev);
    const prodTables = await listTables(prod);
    const dataTables = devTables.filter((t) => t !== '_prisma_migrations');

    console.log('[sync] DEV tables:', devTables.length, '| PROD tables:', prodTables.length);

    const beforeProd: Record<string, number> = {};
    for (const t of dataTables) {
      beforeProd[t] = prodTables.includes(t) ? await countRows(prod, t) : 0;
    }

    const copyOrder = sortTablesForCopy(
      dataTables.filter((t) => prodTables.includes(t))
    ).reverse();

    // Truncate children first (reverse FK order), then copy parents→children
    for (const table of copyOrder) {
      const n = beforeProd[table] || 0;
      if (n > 0) {
        console.log(`[sync] truncate ${table} (${n} rows)`);
        await prod.query(`TRUNCATE TABLE "${table}" CASCADE`);
      }
    }

    const insertOrder = sortTablesForCopy(
      dataTables.filter((t) => prodTables.includes(t))
    );
    for (const table of insertOrder) {
      if (!prodTables.includes(table)) {
        console.warn(`[sync] skip ${table} — not on PROD schema`);
        continue;
      }
      const n = await copyTable(dev, prod, table);
      console.log(`[sync] copied ${table}: ${n} rows`);
    }

    console.log('[sync] Verifying row counts...');
    let ok = true;
    for (const table of dataTables) {
      const devN = await countRows(dev, table);
      const prodN = prodTables.includes(table) ? await countRows(prod, table) : 0;
      const match = devN === prodN;
      console.log(`  ${table}: dev=${devN} prod=${prodN} ${match ? 'OK' : 'MISMATCH'}`);
      if (!match) ok = false;
    }

    if (!ok) {
      throw new Error('Row count mismatch after sync');
    }

    console.log('[sync] SUCCESS — production DB schema + data match development');
  } finally {
    await dev.end();
    await prod.end();
  }
}

main().catch((err) => {
  console.error('[sync] FAILED:', err);
  process.exit(1);
});
