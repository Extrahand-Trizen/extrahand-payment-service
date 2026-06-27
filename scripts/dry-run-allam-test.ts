import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const ALLAM_UID = 'FTDIS0Hm0mcKM7PliYqm9fAHeJA2';

async function connectDb(url: string, label: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function dryRun(client: Client, label: string) {
  console.log(`\n========== ${label} DB ==========`);

  const escrows = await client.query(
    `SELECT id, "escrowId", "posterUid", "performerUid", "amountInRupees", status, "paymentStatus"
     FROM "Escrow"
     WHERE "posterUid" = $1 OR "performerUid" = $1`,
    [ALLAM_UID]
  );
  console.log(`Escrows: ${escrows.rowCount}`);
  escrows.rows.forEach(e => console.log(`  ${e.escrowId} | ₹${e.amountInRupees} | payment=${e.paymentStatus} | status=${e.status}`));

  if ((escrows.rowCount ?? 0) === 0) {
    console.log(`No data found for this UID.`);
    return;
  }

  const escrowIds = escrows.rows.map(e => e.id);

  const payouts = await client.query(
    `SELECT COUNT(*) as c FROM "Payout" WHERE "escrowId" = ANY($1::text[])`,
    [escrowIds]
  );
  const orphanPayouts = await client.query(
    `SELECT COUNT(*) as c FROM "Payout" WHERE "performerUid" = $1 AND ("escrowId" IS NULL OR "escrowId" != ALL($2::text[]))`,
    [ALLAM_UID, escrowIds]
  );
  console.log(`Payouts: ${payouts.rows[0].c} (linked) + ${orphanPayouts.rows[0].c} (orphan)`);

  const refunds = await client.query(
    `SELECT COUNT(*) as c FROM "Refund" WHERE "escrowId" = ANY($1::text[])`,
    [escrowIds]
  );
  console.log(`Refunds: ${refunds.rows[0].c}`);

  const disputes = await client.query(
    `SELECT COUNT(*) as c FROM "Dispute" WHERE "escrowId" = ANY($1::text[])`,
    [escrowIds]
  );
  console.log(`Disputes: ${disputes.rows[0].c}`);

  // Also check for Transaction records linked to these escrows
  const orders = await client.query(
    `SELECT COUNT(*) as c FROM "Transaction" WHERE "razorpayOrderId" IN (
       SELECT "razorpayOrderId" FROM "Escrow" WHERE id = ANY($1::text[])
     )`,
    [escrowIds]
  );
  if (parseInt(orders.rows[0].c) > 0) {
    console.log(`⚠️  Transaction records: ${orders.rows[0].c} (these will NOT be deleted - linked by razorpayOrderId)`);
  }

  const total = (escrows.rowCount ?? 0) + parseInt(payouts.rows[0].c) + parseInt(orphanPayouts.rows[0].c)
    + parseInt(refunds.rows[0].c) + parseInt(disputes.rows[0].c);
  console.log(`\nTotal records to delete: ${total}`);
}

async function main() {
  const mainUrl = process.env.POSTGRESDB_URI;
  if (!mainUrl) { console.error('POSTGRESDB_URI not set'); process.exit(1); }

  const mainClient = await connectDb(mainUrl, 'main');
  await dryRun(mainClient, 'main');
  await mainClient.end();

  const devUrl = process.env.DEV_POSTGRESDB_URI;
  if (devUrl) {
    const devClient = await connectDb(devUrl, 'dev');
    await dryRun(devClient, 'dev');
    await devClient.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
