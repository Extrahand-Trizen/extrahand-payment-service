import dotenv from 'dotenv';
import { Pool } from 'pg';
import axios from 'axios';

dotenv.config();

const mainUrl = process.env.POSTGRESDB_URI;
const devUrl = process.env.DEV_POSTGRESDB_URI;
const userServiceUrl = process.env.USER_SERVICE_URL || 'http://localhost:4001';
const token = process.env.SERVICE_AUTH_TOKEN || '';

async function backfillForDb(connString: string, label: string) {
  console.log(`\n--- Backfilling ${label} DB ---`);
  const pool = new Pool({ connectionString: connString });

  try {
    // 1. Get unique posterUids and performerUids from Escrow
    const escrowUidsResult = await pool.query(`
      SELECT DISTINCT "posterUid" FROM "Escrow" WHERE "posterUid" IS NOT NULL
      UNION
      SELECT DISTINCT "performerUid" FROM "Escrow" WHERE "performerUid" IS NOT NULL
    `);
    
    // 2. Get unique performerUids from Payout
    const payoutUidsResult = await pool.query(`
      SELECT DISTINCT "performerUid" FROM "Payout" WHERE "performerUid" IS NOT NULL
    `);

    const allUids = new Set<string>();
    escrowUidsResult.rows.forEach((r: any) => {
      const uid = r.posterUid || r.performerUid;
      if (uid) allUids.add(uid);
    });
    payoutUidsResult.rows.forEach((r: any) => {
      if (r.performerUid) allUids.add(r.performerUid);
    });

    const uidsArray = Array.from(allUids);
    console.log(`Found ${uidsArray.length} unique UIDs in ${label} DB.`);

    if (uidsArray.length === 0) return;

    // 3. Query User Service for profiles in batches of 100
    const allamTestUids = new Set<string>();
    const batchSize = 100;
    
    for (let i = 0; i < uidsArray.length; i += batchSize) {
      const batch = uidsArray.slice(i, i + batchSize);
      try {
        const res = await axios.post(
          `${userServiceUrl}/api/v1/profiles/batch/uids`,
          { uids: batch },
          {
            headers: {
              'x-service-auth': token,
              'Content-Type': 'application/json',
              'x-service-name': 'payment-service-backfill',
            },
            timeout: 10000,
          }
        );
        const profiles = res.data?.profiles || [];
        profiles.forEach((p: any) => {
          const name = (p.name || '').trim().toLowerCase();
          if (name === 'allam test') {
            allamTestUids.add(p.uid);
          }
        });
      } catch (err: any) {
        console.error(`Failed to fetch profiles for batch starting at ${i}:`, err.message);
      }
    }

    console.log(`Identified Allam Test UIDs:`, Array.from(allamTestUids));

    if (allamTestUids.size === 0) {
      console.log('No Allam Test UIDs found in this database.');
      return;
    }

    // 4. Update Escrow metadata
    console.log('Updating "Escrow" table...');
    const escrowUpdate = await pool.query(
      `UPDATE "Escrow"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE ("posterUid" = ANY($1) OR "performerUid" = ANY($1))
         AND (metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true'))`,
      [Array.from(allamTestUids)]
    );
    console.log(`Updated ${escrowUpdate.rowCount} rows in "Escrow".`);

    // 5. Update Payout metadata
    console.log('Updating "Payout" table...');
    const payoutUpdate = await pool.query(
      `UPDATE "Payout"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE "performerUid" = ANY($1)
         AND (metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true'))`,
      [Array.from(allamTestUids)]
    );
    console.log(`Updated ${payoutUpdate.rowCount} rows in "Payout".`);

    // 6. Update Transaction metadata
    console.log('Updating "Transaction" table...');
    const transactionUpdate = await pool.query(
      `UPDATE "Transaction"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE "userId" = ANY($1)
         AND (metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true'))`,
      [Array.from(allamTestUids)]
    );
    console.log(`Updated ${transactionUpdate.rowCount} rows in "Transaction".`);

    // 7. Update Ledger metadata
    console.log('Updating "Ledger" table...');
    const ledgerUpdate = await pool.query(
      `UPDATE "Ledger"
       SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{teamTest}', 'true'::jsonb)
       WHERE "userId" = ANY($1)
         AND (metadata IS NULL OR NOT (metadata ? 'teamTest' AND (metadata->'teamTest')::text = 'true'))`,
      [Array.from(allamTestUids)]
    );
    console.log(`Updated ${ledgerUpdate.rowCount} rows in "Ledger".`);

    console.log(`✅ Backfill complete for ${label} DB.`);
  } catch (error) {
    console.error(`❌ Error backfilling ${label} DB:`, error);
  } finally {
    await pool.end();
  }
}

async function main() {
  if (mainUrl) {
    await backfillForDb(mainUrl, 'MAIN (ep-solitary-violet)');
  }
  if (devUrl) {
    await backfillForDb(devUrl, 'DEV (ep-solitary-frost)');
  }
}

main();
