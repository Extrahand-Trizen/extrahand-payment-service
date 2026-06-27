import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const mainUrl = process.env.POSTGRESDB_URI;
const devUrl = process.env.DEV_POSTGRESDB_URI;

async function run() {
  if (mainUrl) {
    const pool = new Pool({ connectionString: mainUrl });
    const r = await pool.query('SELECT COUNT(*)::bigint AS n FROM "Escrow"');
    console.log('MAIN DB Escrow count:', r.rows[0].n);
    await pool.end();
  }
  if (devUrl) {
    const pool = new Pool({ connectionString: devUrl });
    const r = await pool.query('SELECT COUNT(*)::bigint AS n FROM "Escrow"');
    console.log('DEV DB Escrow count:', r.rows[0].n);
    await pool.end();
  }
}

run().catch(console.error);
