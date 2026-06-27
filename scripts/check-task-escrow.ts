import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const FROST = process.env.POSTGRESDB_URI!;
const VIOLET = process.env.DEV_POSTGRESDB_URI!;

// Task ID from the screenshot
const TASK_ID = '6a3bd38fd833cdccfe22ee5b';

async function checkDb(label: string, url: string) {
  const pool = new Pool({ connectionString: url });
  try {
    const e = await pool.query(
      `SELECT "escrowId","taskId","status","paymentStatus","amountInRupees","createdAt","metadata"
       FROM "Escrow" WHERE "taskId" = $1`,
      [TASK_ID]
    );
    console.log(`\n[${label}] Escrow rows for task ${TASK_ID}: ${e.rowCount}`);
    e.rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));

    // Also check Transaction table
    const t = await pool.query(
      `SELECT "id","taskId","status","amount","createdAt","metadata"
       FROM "Transaction" WHERE "taskId" = $1`,
      [TASK_ID]
    );
    console.log(`[${label}] Transaction rows: ${t.rowCount}`);
    t.rows.forEach((r: any) => console.log(JSON.stringify(r, null, 2)));

    // Show latest 3 escrows for reference
    const latest = await pool.query(
      `SELECT "escrowId","taskId","status","paymentStatus","amountInRupees","createdAt"
       FROM "Escrow" ORDER BY "createdAt" DESC LIMIT 5`
    );
    console.log(`\n[${label}] Latest 5 Escrows:`);
    latest.rows.forEach((r: any) => console.log(JSON.stringify(r)));
  } finally {
    await pool.end();
  }
}

async function main() {
  await checkDb('FROST (primary)', FROST);
  await checkDb('VIOLET (dev)', VIOLET);
}

main().catch(console.error);
