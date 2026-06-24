import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const DEV_URL = process.env.DEV_POSTGRESDB_URI;

if (!DEV_URL) {
  console.error('❌ DEV_POSTGRESDB_URI is not set in environment or .env file');
  process.exit(1);
}

async function main() {
  console.log('Connecting to dev database (ep-solitary-frost)...');
  const pool = new Pool({ connectionString: DEV_URL });

  try {
    // 1. Update Escrow metadata
    console.log('Updating "Escrow" table...');
    const escrowResult = await pool.query(
      `UPDATE "Escrow"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true')`
    );
    console.log(`Updated ${escrowResult.rowCount} rows in "Escrow".`);

    // 2. Update Payout metadata
    console.log('Updating "Payout" table...');
    const payoutResult = await pool.query(
      `UPDATE "Payout"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true')`
    );
    console.log(`Updated ${payoutResult.rowCount} rows in "Payout".`);

    // 3. Update Transaction metadata
    console.log('Updating "Transaction" table...');
    const transactionResult = await pool.query(
      `UPDATE "Transaction"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true')`
    );
    console.log(`Updated ${transactionResult.rowCount} rows in "Transaction".`);

    // 4. Update Ledger metadata
    console.log('Updating "Ledger" table...');
    const ledgerResult = await pool.query(
      `UPDATE "Ledger"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true')`
    );
    console.log(`Updated ${ledgerResult.rowCount} rows in "Ledger".`);

    console.log('✅ Done! All transactions, payouts, escrows, and ledgers in dev database are marked as teamTest.');
  } catch (error) {
    console.error('❌ Error during update:', error);
  } finally {
    await pool.end();
  }
}

main();
