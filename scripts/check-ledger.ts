import { Client } from 'pg';
const url = process.env.DEV_POSTGRESDB_URI || process.env.POSTGRESDB_URI;
const client = new Client({ connectionString: url });
await client.connect();
const uid = 'FTDIS0Hm0mcKM7PliYqm9fAHeJA2';
const e = await client.query('SELECT id FROM "Escrow" WHERE "posterUid" = $1 OR "performerUid" = $1', [uid]);
const ids = e.rows.map((x: any) => x.id);
console.log('escrow ids:', ids.length);
if (ids.length > 0) {
  const l = await client.query('SELECT COUNT(*) as c FROM "Ledger" WHERE "escrowId" = ANY($1::text[])', [ids]);
  console.log('ledger entries (by escrow):', l.rows[0].c);
}
const tx = await client.query('SELECT COUNT(*) as c FROM "Transaction" WHERE "userId" = $1', [uid]);
console.log('transactions (by userId):', tx.rows[0].c);
await client.end();
