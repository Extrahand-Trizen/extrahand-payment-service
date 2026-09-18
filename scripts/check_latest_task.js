require('dotenv').config();
const { Pool } = require('pg');
const mongoose = require('mongoose');

async function checkLatest() {
  console.log('--- Checking MongoDB ---');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const latestTasks = await db.collection('tasks')
    .find({})
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();

  console.log('Latest 3 Tasks in Mongo:');
  latestTasks.forEach((t) => {
    console.log({
      _id: String(t._id),
      title: t.title,
      category: t.category,
      categorySlug: t.categorySlug,
      bookingOrderId: t.bookingOrderId,
      status: t.status,
      createdAt: t.createdAt,
    });
  });

  const latestOrders = await db.collection('bookingorders')
    .find({})
    .sort({ createdAt: -1 })
    .limit(3)
    .toArray();

  console.log('\nLatest 3 BookingOrders in Mongo:');
  latestOrders.forEach((o) => {
    console.log({
      orderId: o.orderId,
      status: o.status,
      paymentEscrowId: o.paymentEscrowId,
      razorpayOrderId: o.razorpayOrderId,
      total: o.total,
      createdAt: o.createdAt,
    });
  });

  await mongoose.disconnect();

  async function checkPg(label, url) {
    if (!url) return;
    console.log(`\n--- Checking PostgreSQL (${label}) ---`);
    const pool = new Pool({ connectionString: url });
    try {
      const escrows = await pool.query(`
        SELECT "id", "escrowId", "taskId", "bookingOrderId", "status", "paymentStatus", "amountInRupees", "createdAt"
        FROM "Escrow"
        ORDER BY "createdAt" DESC
        LIMIT 3
      `);
      console.log('Latest 3 Escrows:');
      console.log(JSON.stringify(escrows.rows, null, 2));

      const latestEscrow = escrows.rows[0];
      const txs = await pool.query(`
        SELECT "id", "taskId", "status", "amount", "razorpayOrderId", "createdAt"
        FROM "Transaction"
        WHERE "taskId" = $1 OR "razorpayOrderId" = $2
        ORDER BY "createdAt" DESC
        LIMIT 5
      `, [latestEscrow?.taskId, latestEscrow?.razorpayOrderId]);
      console.log('Transactions for latest Escrow/Task:');
      console.log(JSON.stringify(txs.rows, null, 2));

      const ledgers = await pool.query(`
        SELECT "id", "taskId", "type", "amount", "createdAt"
        FROM "Ledger"
        WHERE "taskId" = $1 OR "escrowId" = $2
        ORDER BY "createdAt" DESC
        LIMIT 5
      `, [latestEscrow?.taskId, latestEscrow?.id]);
      console.log('Ledgers for latest Escrow/Task:');
      console.log(JSON.stringify(ledgers.rows, null, 2));
    } catch (e) {
      console.error(`Error querying ${label}:`, e.message);
    } finally {
      await pool.end();
    }
  }

  await checkPg('PROD_POSTGRES (Neon)', process.env.POSTGRESDB_URI);
  await checkPg('DEV_POSTGRES (Neon)', process.env.DEV_POSTGRESDB_URI);
}

checkLatest().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
