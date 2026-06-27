import dotenv from 'dotenv';
import { prisma } from '../config/prisma';
import { disconnectPrisma } from '../config/prisma';

dotenv.config();

const TASK_ID = process.argv[2] || '6a38b18c3d08c6fffb186dfd';
const BOOKING_ORDER_ID = process.argv[3] || '3e639f97-2d38-4986-906d-4439a74911f3';
const EXPECTED_PERFORMER = process.argv[4] || 'ZnYZTT44tjPmvMFLvraCfMhtEqL2';

async function main() {
  try {
    const rows = await prisma.escrow.findMany({
      where: {
        OR: [{ taskId: TASK_ID }, { bookingOrderId: BOOKING_ORDER_ID }],
      },
      orderBy: { createdAt: 'desc' },
    });

    console.log('=== Escrow performer check (Neon) ===');
    console.log({ taskId: TASK_ID, bookingOrderId: BOOKING_ORDER_ID, expectedPerformerUid: EXPECTED_PERFORMER });
    console.log(`Found ${rows.length} escrow row(s)\n`);

    if (!rows.length) {
      console.log('NO escrow found for this task/order.');
      return;
    }

    for (const e of rows) {
      const performer = e.performerUid ?? null;
      let performerCheck = 'OTHER';
      if (!performer || performer === 'pending_assignment') {
        performerCheck = 'NOT_ATTACHED';
      } else if (performer === EXPECTED_PERFORMER) {
        performerCheck = 'MATCHES_EXPECTED';
      }

      const meta =
        e.metadata && typeof e.metadata === 'object' && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : {};

      console.log({
        escrowId: e.escrowId,
        taskId: e.taskId,
        bookingOrderId: e.bookingOrderId,
        performerUid: performer,
        posterUid: e.posterUid,
        applicationId: e.applicationId,
        status: e.status,
        paymentStatus: e.paymentStatus,
        amountInRupees: e.amountInRupees.toString(),
        performerCheck,
        bookingMode: meta.bookingMode ?? null,
        performerAttachedAt: meta.performerAttachedAt ?? null,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      });
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
