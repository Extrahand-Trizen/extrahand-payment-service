/**
 * Copy CategoryFeeConfig rows from dev Neon → prod Neon (upsert + mirror).
 *
 * Usage:
 *   npm run sync:category-fees-dev-to-prod              # dry run
 *   npm run sync:category-fees-dev-to-prod -- --execute # migrate prod schema if needed + copy data
 *
 * Requires DEV_POSTGRESDB_URI and PROD_POSTGRESDB_URI in .env
 */
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const DEV_URL = process.env.DEV_POSTGRESDB_URI || '';
const PROD_URL = process.env.PROD_POSTGRESDB_URI || process.env.POSTGRESDB_URI || '';
const EXECUTE = process.argv.includes('--execute');

if (!DEV_URL || !PROD_URL) {
  console.error('Required: DEV_POSTGRESDB_URI and PROD_POSTGRESDB_URI in .env');
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

if (maskHost(DEV_URL) === maskHost(PROD_URL)) {
  console.error('[category-fees] DEV and PROD hosts are the same — refusing');
  process.exit(1);
}

type Row = Record<string, unknown>;

async function tableColumns(pool: Pool): Promise<string[]> {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'CategoryFeeConfig'
     ORDER BY ordinal_position`,
  );
  return r.rows.map((row: { column_name: string }) => row.column_name);
}

async function fetchRows(pool: Pool, columns: string[]): Promise<Row[]> {
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const r = await pool.query(`SELECT ${colList} FROM "CategoryFeeConfig" ORDER BY mode, "categoryKey"`);
  return r.rows;
}

function rowKey(row: Row): string {
  return `${String(row.mode)}:${String(row.categoryKey)}`;
}

async function ensureProdSchema(prod: Pool): Promise<void> {
  const prodCols = new Set(await tableColumns(prod));
  const required = ['categoryKey', 'mode', 'sacCode', 'sacHeading'];
  const missing = required.filter((c) => !prodCols.has(c));

  if (missing.length === 0) return;

  if (!EXECUTE) {
    console.warn(
      `[category-fees] PROD schema missing: ${missing.join(', ')} — will patch on --execute`,
    );
    return;
  }

  console.log('[category-fees] Patching PROD CategoryFeeConfig schema (idempotent SQL)...');
  await prod.query(`
    ALTER TABLE "CategoryFeeConfig" ADD COLUMN IF NOT EXISTS "sacCode" TEXT;
    ALTER TABLE "CategoryFeeConfig" ADD COLUMN IF NOT EXISTS "sacHeading" TEXT;
  `);
  await prod.query(`
    DO $$ BEGIN
      CREATE TYPE "CategoryFeeMode" AS ENUM ('BOOK_NOW', 'BIDDING');
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);
  await prod.query(`
    ALTER TABLE "CategoryFeeConfig"
      ADD COLUMN IF NOT EXISTS "mode" "CategoryFeeMode" NOT NULL DEFAULT 'BIDDING';
    ALTER TABLE "CategoryFeeConfig" DROP CONSTRAINT IF EXISTS "CategoryFeeConfig_categoryKey_key";
    DROP INDEX IF EXISTS "CategoryFeeConfig_categoryKey_key";
    CREATE UNIQUE INDEX IF NOT EXISTS "CategoryFeeConfig_categoryKey_mode_key"
      ON "CategoryFeeConfig"("categoryKey", "mode");
    CREATE INDEX IF NOT EXISTS "CategoryFeeConfig_mode_idx" ON "CategoryFeeConfig"("mode");
  `);
  console.log('[category-fees] PROD schema patch complete');
}

async function main(): Promise<void> {
  console.log('[category-fees] DEV host:', maskHost(DEV_URL));
  console.log('[category-fees] PROD host:', maskHost(PROD_URL));
  console.log('[category-fees] Mode:', EXECUTE ? 'EXECUTE' : 'DRY RUN');

  const dev = new Pool({ connectionString: DEV_URL });
  const prod = new Pool({ connectionString: PROD_URL });

  try {
    await ensureProdSchema(prod);

    const devCols = await tableColumns(dev);
    const prodCols = new Set(await tableColumns(prod));
    const columns = devCols.filter((c) => prodCols.has(c));

    if (!columns.includes('categoryKey') || !columns.includes('mode')) {
      if (!EXECUTE) {
        console.log('[category-fees] Dry run: prod schema will be migrated before copy when using --execute');
        const devRowsPreview = await fetchRows(dev, devCols);
        console.log(`[category-fees] Dev rows ready to copy: ${devRowsPreview.length}`);
        return;
      }
      throw new Error(
        'CategoryFeeConfig must have categoryKey and mode on prod after migrate deploy.',
      );
    }

    const skipped = devCols.filter((c) => !prodCols.has(c));
    if (skipped.length > 0) {
      console.warn('[category-fees] Skipping dev-only columns on prod:', skipped.join(', '));
    }

    const devRows = await fetchRows(dev, columns);
    const prodRows = await fetchRows(prod, columns);
    const devKeys = new Set(devRows.map(rowKey));
    const prodKeys = new Set(prodRows.map(rowKey));

    const toUpsert = devRows;
    const toDelete = prodRows.filter((r) => !devKeys.has(rowKey(r)));
    const newOnProd = devRows.filter((r) => !prodKeys.has(rowKey(r)));
    const updatedOnProd = devRows.filter((r) => prodKeys.has(rowKey(r)));

    console.log(`[category-fees] Dev rows: ${devRows.length}`);
    console.log(`[category-fees] Prod rows (before): ${prodRows.length}`);
    console.log(`[category-fees] Will upsert: ${toUpsert.length} (${newOnProd.length} new, ${updatedOnProd.length} update)`);
    console.log(`[category-fees] Will delete from prod: ${toDelete.length}`);

    if (toDelete.length > 0) {
      console.log('[category-fees] Prod-only rows to remove:');
      for (const r of toDelete.slice(0, 20)) {
        console.log(`  - ${r.mode}/${r.categoryKey}`);
      }
      if (toDelete.length > 20) console.log(`  ... and ${toDelete.length - 20} more`);
    }

    if (!EXECUTE) {
      console.log('[category-fees] Dry run complete. Re-run with --execute to apply.');
      return;
    }

    const colList = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const updatable = columns.filter((c) => c !== 'id' && c !== 'categoryKey' && c !== 'mode');
    const updateClause = updatable
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');

    await prod.query('BEGIN');
    try {
      for (const row of toUpsert) {
        const values = columns.map((c) => row[c]);
        await prod.query(
          `INSERT INTO "CategoryFeeConfig" (${colList}) VALUES (${placeholders})
           ON CONFLICT ("categoryKey", mode) DO UPDATE SET ${updateClause}`,
          values,
        );
      }

      for (const row of toDelete) {
        await prod.query(
          `DELETE FROM "CategoryFeeConfig" WHERE "categoryKey" = $1 AND mode = $2`,
          [row.categoryKey, row.mode],
        );
      }

      await prod.query('COMMIT');
    } catch (err) {
      await prod.query('ROLLBACK');
      throw err;
    }

    const prodAfter = await fetchRows(prod, columns);
    console.log(`[category-fees] Prod rows (after): ${prodAfter.length}`);

    if (prodAfter.length !== devRows.length) {
      throw new Error(`Row count mismatch: dev=${devRows.length} prod=${prodAfter.length}`);
    }

    const prodAfterKeys = new Set(prodAfter.map(rowKey));
    for (const key of devKeys) {
      if (!prodAfterKeys.has(key)) {
        throw new Error(`Missing on prod after sync: ${key}`);
      }
    }

    console.log('[category-fees] SUCCESS — prod CategoryFeeConfig mirrors dev');
  } finally {
    await dev.end();
    await prod.end();
  }
}

main().catch((err) => {
  console.error('[category-fees] FAILED:', err);
  process.exit(1);
});
