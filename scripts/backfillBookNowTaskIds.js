require('dotenv').config();
const { Pool } = require('pg');
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--execute');

async function runForDb(label, postgresUrl) {
  if (!postgresUrl) {
    console.log(`[${label}] PostgreSQL URL not configured. Skipping.`);
    return;
  }

  console.log(`\n==================================================`);
  console.log(`Processing ${label} (Mode: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'})`);
  console.log(`==================================================`);

  const pool = new Pool({ connectionString: postgresUrl });

  try {
    const escrowsRes = await pool.query(`
      SELECT "id", "escrowId", "taskId", "bookingOrderId", "razorpayOrderId", "status", "paymentStatus", "metadata", "createdAt"
      FROM "Escrow"
      WHERE "taskId" LIKE 'booknow-pending-%'
      ORDER BY "createdAt" DESC
    `);

    const pendingEscrows = escrowsRes.rows;
    console.log(`Found ${pendingEscrows.length} escrows with 'booknow-pending-*' in ${label}`);

    const db = mongoose.connection.db;
    const bookingOrdersColl = db.collection('bookingorders');
    const bookingItemsColl = db.collection('bookingitems');
    const tasksColl = db.collection('tasks');

    let updatedCount = 0;
    let abandonedCount = 0;
    let missingMongoCount = 0;

    for (const escrow of pendingEscrows) {
      const originalTaskId = escrow.taskId;
      const bookingOrderId =
        escrow.bookingOrderId ||
        originalTaskId.replace(/^booknow-pending-/, '').split(':')[0].trim();

      // 1. Find booking order in Mongo
      const order = await bookingOrdersColl.findOne({ orderId: bookingOrderId });

      // 2. Find booking items with real taskId
      const items = await bookingItemsColl
        .find({ orderId: bookingOrderId })
        .toArray();

      const itemsWithTask = items.filter((i) => i.taskId);

      // 3. Find tasks directly linked to bookingOrderId
      const tasks = await tasksColl
        .find({ bookingOrderId })
        .toArray();

      let resolvedTaskId = null;
      let lineItemTaskMap = new Map();

      if (itemsWithTask.length > 0) {
        resolvedTaskId = String(itemsWithTask[0].taskId);
        for (const item of itemsWithTask) {
          const slug = item.skuSnapshot?.slug || item.packageSlug;
          if (slug && item.taskId) {
            lineItemTaskMap.set(slug, String(item.taskId));
          }
        }
      } else if (tasks.length > 0) {
        resolvedTaskId = String(tasks[0]._id);
      }

      if (resolvedTaskId && !resolvedTaskId.startsWith('booknow-pending-')) {
        // Prepare updated metadata
        const oldMeta = escrow.metadata || {};
        const oldLineItems = Array.isArray(oldMeta.bookNowLineItems)
          ? [...oldMeta.bookNowLineItems]
          : [];

        const updatedLineItems = oldLineItems.map((item, idx) => {
          const row = { ...item };
          const slug = String(row.packageSlug || row.categorySlug || '').trim();
          const target = lineItemTaskMap.get(slug) || (tasks[idx] ? String(tasks[idx]._id) : resolvedTaskId);
          row.taskId = target;
          return row;
        });

        const newMeta = {
          ...oldMeta,
          bookNowLineItems: updatedLineItems,
        };

        console.log(`[MATCH] Escrow: ${escrow.escrowId} | Order: ${bookingOrderId} -> Mongo Task: ${resolvedTaskId} (${itemsWithTask.length} items, ${tasks.length} tasks)`);

        if (!DRY_RUN) {
          // Update Escrow
          await pool.query(
            `UPDATE "Escrow"
             SET "taskId" = $1,
                 "bookingOrderId" = COALESCE("bookingOrderId", $2),
                 "metadata" = $3
             WHERE "id" = $4`,
            [resolvedTaskId, bookingOrderId, JSON.stringify(newMeta), escrow.id]
          );

          // Update Transaction
          const txRes = await pool.query(
            `UPDATE "Transaction"
             SET "taskId" = $1
             WHERE "taskId" = $2
                OR ("razorpayOrderId" IS NOT NULL AND "razorpayOrderId" = $3)`,
            [resolvedTaskId, originalTaskId, escrow.razorpayOrderId]
          );

          // Update Ledger
          const ledgerRes = await pool.query(
            `UPDATE "Ledger"
             SET "taskId" = $1
             WHERE "taskId" = $2
                OR "escrowId" = $3`,
            [resolvedTaskId, originalTaskId, escrow.escrowId]
          );

          console.log(`  Updated Escrow ${escrow.escrowId}, ${txRes.rowCount} transactions, ${ledgerRes.rowCount} ledgers.`);
        }
        updatedCount++;
      } else {
        if (escrow.status === 'pending' || (order && order.status === 'awaiting_payment')) {
          abandonedCount++;
        } else {
          missingMongoCount++;
          console.log(`[NO_TASK] Escrow: ${escrow.escrowId} | Order: ${bookingOrderId} | EscrowStatus: ${escrow.status} | OrderStatus: ${order?.status || 'NOT_FOUND'}`);
        }
      }
    }

    console.log(`\n--- Summary for ${label} ---`);
    console.log(`Total escrows with 'booknow-pending-*': ${pendingEscrows.length}`);
    console.log(`Matched with real Mongo tasks:         ${updatedCount} (will ${DRY_RUN ? 'NOT be updated (dry-run)' : 'be updated'})`);
    console.log(`Abandoned checkouts (unpaid/pending):   ${abandonedCount}`);
    console.log(`Paid/other with no task in Mongo:       ${missingMongoCount}`);

  } catch (err) {
    console.error(`Error processing ${label}:`, err);
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log(`Connecting to MongoDB...`);
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB successfully.`);

  await runForDb('PROD_POSTGRES (Neon)', process.env.POSTGRESDB_URI);
  await runForDb('DEV_POSTGRES (Neon)', process.env.DEV_POSTGRESDB_URI);

  await mongoose.disconnect();
  console.log(`\nAll done.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

