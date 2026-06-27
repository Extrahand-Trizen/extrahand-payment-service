import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const ALLAM_UID = 'FTDIS0Hm0mcKM7PliYqm9fAHeJA2';

async function connectDb(url: string, label: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  console.log(`✅ Connected to ${label} DB`);
  return client;
}

/** Build parameterized IN-clause: returns { clause, params } or null */
function inClause(col: string, paramIdx: number, arr: string[]): { clause: string; params: any[] } | null {
  if (arr.length === 0) return null;
  return { clause: `${col} = ANY($${paramIdx}::text[])`, params: [arr] };
}

/** Build NOT IN clause: returns { clause, params } or null */
function notInClause(col: string, paramIdx: number, arr: string[]): { clause: string; params: any[] } | null {
  if (arr.length === 0) return null;
  return { clause: `${col} != ALL($${paramIdx}::text[])`, params: [arr] };
}

async function processDb(client: Client, label: string) {
  console.log(`\n========== Processing ${label} DB ==========`);

  // 1. Find all escrows
  const escrows = await client.query(
    `SELECT id, "escrowId", "razorpayOrderId" FROM "Escrow"
     WHERE "posterUid" = $1 OR "performerUid" = $1`, [ALLAM_UID]
  );
  console.log(`Escrows: ${escrows.rowCount}`);
  if ((escrows.rowCount ?? 0) === 0) {
    // Still check transactions
    const tx = await client.query(
      `SELECT COUNT(*) as c FROM "Transaction" WHERE "userId" = $1`, [ALLAM_UID]
    );
    if (parseInt(tx.rows[0].c) > 0) {
      console.log(`Transaction records: ${tx.rows[0].c} (will delete)`);
    } else {
      console.log(`No data found for this UID.`);
      return;
    }
  }

  const escrowIds = escrows.rows.map((e: any) => e.id) as string[];
  const orderIds = escrows.rows.map((e: any) => e.razorpayOrderId).filter(Boolean) as string[];

  // 2. Escrow-linked payouts
  let allPayoutIds: string[] = [];
  if (escrowIds.length > 0) {
    const p = await client.query(
      `SELECT id FROM "Payout" WHERE "escrowId" = ANY($1::text[])`, [escrowIds]
    );
    allPayoutIds = p.rows.map((r: any) => r.id);
    // Orphan payouts
    const op = await client.query(
      `SELECT id FROM "Payout" WHERE "performerUid" = $1 AND ("escrowId" IS NULL OR "escrowId" != ALL($2::text[]))`,
      [ALLAM_UID, escrowIds]
    );
    allPayoutIds = [...allPayoutIds, ...op.rows.map((r: any) => r.id)];
  }

  // 3. Linked refunds
  let refundIds: string[] = [];
  if (escrowIds.length > 0) {
    const r = await client.query(
      `SELECT id FROM "Refund" WHERE "escrowId" = ANY($1::text[])`, [escrowIds]
    );
    refundIds = r.rows.map((rx: any) => rx.id);
  }

  // 4. Linked disputes
  let disputeIds: string[] = [];
  if (escrowIds.length > 0) {
    const d = await client.query(
      `SELECT id FROM "Dispute" WHERE "escrowId" = ANY($1::text[])`, [escrowIds]
    );
    disputeIds = d.rows.map((dx: any) => dx.id);
  }

  // 5. Linked ledger entries
  let allLedgerIds: string[] = [];
  if (escrowIds.length > 0) {
    const parts: string[] = [];
    const params: any[] = [];
    let idx = 1;
    const ei = inClause('"escrowId"', idx++, escrowIds);
    if (ei) { parts.push(ei.clause); params.push(...ei.params); }

    if (allPayoutIds.length > 0) {
      const pi = inClause('"payoutId"', idx++, allPayoutIds);
      if (pi) { parts.push(pi.clause); params.push(...pi.params); }
    }
    if (refundIds.length > 0) {
      const ri = inClause('"refundId"', idx++, refundIds);
      if (ri) { parts.push(ri.clause); params.push(...ri.params); }
    }

    if (parts.length > 0) {
      const l = await client.query(
        `SELECT id FROM "Ledger" WHERE ${parts.join(' OR ')}`, params
      );
      allLedgerIds = l.rows.map((lx: any) => lx.id);
    }

    // Payout-only ledger (not already captured above)
    if (allPayoutIds.length > 0) {
      const pClause = inClause('"payoutId"', 1, allPayoutIds);
      const notEClause = notInClause('"escrowId"', 2, escrowIds);
      if (pClause && notEClause) {
        const pl = await client.query(
          `SELECT id FROM "Ledger" WHERE ${pClause.clause} AND ("escrowId" IS NULL OR ${notEClause.clause})`,
          [...pClause.params, ...notEClause.params]
        );
        allLedgerIds = [...new Set([...allLedgerIds, ...pl.rows.map((r: any) => r.id)])];
      }
    }
  }

  // 6. Transaction records
  const txSet = new Set<string>();
  const txByUid = await client.query(
    `SELECT id FROM "Transaction" WHERE "userId" = $1`, [ALLAM_UID]
  );
  txByUid.rows.forEach((r: any) => txSet.add(r.id));
  if (orderIds.length > 0) {
    const txByOrder = await client.query(
      `SELECT id FROM "Transaction" WHERE "razorpayOrderId" = ANY($1::text[])`, [orderIds]
    );
    txByOrder.rows.forEach((r: any) => txSet.add(r.id));
  }
  const allTxIds = [...txSet];

  // 7. PaymentOrderIdempotency
  let idempotencyIds: string[] = [];
  if (orderIds.length > 0) {
    const ip = await client.query(
      `SELECT id FROM "PaymentOrderIdempotency" WHERE "razorpayOrderId" = ANY($1::text[])`, [orderIds]
    );
    idempotencyIds = ip.rows.map((r: any) => r.id);
  }

  // Summary
  const counts = {
    Transaction: allTxIds.length,
    PaymentOrderIdempotency: idempotencyIds.length,
    Ledger: allLedgerIds.length,
    Refund: refundIds.length,
    Dispute: disputeIds.length,
    Payout: allPayoutIds.length,
    Escrow: escrowIds.length,
  };
  const grandTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nRecords to delete:`);
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) console.log(`  ${k}: ${v}`);
  }
  console.log(`  TOTAL: ${grandTotal}`);

  if (grandTotal === 0) {
    console.log(`Nothing to delete.`);
    return;
  }

  // Execute deletes in transaction
  try {
    await client.query('BEGIN');

    if (idempotencyIds.length > 0) {
      const r = await client.query(`DELETE FROM "PaymentOrderIdempotency" WHERE id = ANY($1::text[])`, [idempotencyIds]);
      console.log(`  Deleted ${r.rowCount} PaymentOrderIdempotency`);
    }
    if (allTxIds.length > 0) {
      const r = await client.query(`DELETE FROM "Transaction" WHERE id = ANY($1::text[])`, [allTxIds]);
      console.log(`  Deleted ${r.rowCount} Transaction`);
    }
    if (allLedgerIds.length > 0) {
      const r = await client.query(`DELETE FROM "Ledger" WHERE id = ANY($1::text[])`, [allLedgerIds]);
      console.log(`  Deleted ${r.rowCount} Ledger`);
    }
    if (refundIds.length > 0) {
      const r = await client.query(`DELETE FROM "Refund" WHERE id = ANY($1::text[])`, [refundIds]);
      console.log(`  Deleted ${r.rowCount} Refund`);
    }
    if (disputeIds.length > 0) {
      const r = await client.query(`DELETE FROM "Dispute" WHERE id = ANY($1::text[])`, [disputeIds]);
      console.log(`  Deleted ${r.rowCount} Dispute`);
    }
    if (allPayoutIds.length > 0) {
      const r = await client.query(`DELETE FROM "Payout" WHERE id = ANY($1::text[])`, [allPayoutIds]);
      console.log(`  Deleted ${r.rowCount} Payout`);
    }
    if (escrowIds.length > 0) {
      const r = await client.query(`DELETE FROM "Escrow" WHERE id = ANY($1::text[])`, [escrowIds]);
      console.log(`  Deleted ${r.rowCount} Escrow`);
    }

    const auditId = 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    await client.query(
      `INSERT INTO "AuditLog" (id, "entityType", "action", "actorType", "actorId", "newValue", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [auditId, 'escrow', 'deleted', 'admin', 'bulk_cleanup_script',
       JSON.stringify({ deletedBy: 'delete-allam-test-data.ts', uid: ALLAM_UID, ...counts })]
    );

    await client.query('COMMIT');
    console.log(`\n✅ ${label} DB cleanup complete.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const mainUrl = process.env.POSTGRESDB_URI;
  if (!mainUrl) { console.error('POSTGRESDB_URI not set'); process.exit(1); }

  const mainClient = await connectDb(mainUrl, 'main');
  await processDb(mainClient, 'main');
  await mainClient.end();

  const devUrl = process.env.DEV_POSTGRESDB_URI;
  if (devUrl) {
    const devClient = await connectDb(devUrl, 'dev');
    await processDb(devClient, 'dev');
    await devClient.end();
  }
}

main().catch(err => { console.error('Script failed:', err); process.exit(1); });
