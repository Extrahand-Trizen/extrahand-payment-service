import { Client } from 'pg';

async function main() {
  const url = process.env.DEV_POSTGRESDB_URI || process.env.POSTGRESDB_URI;
  if (!url) { console.error('No DB URI'); process.exit(1); }
  const client = new Client({ connectionString: url });
  await client.connect();

  const uid = 'FTDIS0Hm0mcKM7PliYqm9fAHeJA2';

  const r = await client.query('SELECT COUNT(*) as c FROM "Transaction" WHERE "userId" = $1', [uid]);
  console.log('Transactions with userId =', uid, ':', r.rows[0].c);

  const r2 = await client.query('SELECT "razorpayOrderId" FROM "Escrow" WHERE "posterUid" = $1 OR "performerUid" = $1', [uid]);
  const orderIds = r2.rows.map((x: any) => x.razorpayorderid || x.razorpayOrderId).filter(Boolean);
  console.log('Escrow razorpayOrderIds:', orderIds.length);

  if (orderIds.length > 0) {
    const r3 = await client.query('SELECT COUNT(*) as c FROM "Transaction" WHERE "razorpayOrderId" = ANY($1::text[])', [orderIds]);
    console.log('Transactions by orderId (linked to these escrows):', r3.rows[0].c);
  }

  await client.end();
}

main().catch(console.error);
