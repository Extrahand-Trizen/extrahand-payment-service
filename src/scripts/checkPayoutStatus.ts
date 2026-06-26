import dotenv from 'dotenv';
import { prisma, disconnectPrisma } from '../config/prisma';

dotenv.config();

const ESCROW_ID = process.argv[2] || 'escrow_1782100409517_73wku5g';
const TASK_ID = process.argv[3] || '6a38b18c3d08c6fffb186dfd';

async function main() {
  try {
    const dbUrl = process.env.POSTGRESDB_URI || '';
    const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':****@');

    const escrow = await prisma.escrow.findUnique({ where: { escrowId: ESCROW_ID } });
    const payoutsByEscrow = escrow
      ? await prisma.payout.findMany({
          where: { escrowId: escrow.id },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const payoutsByTask = await prisma.payout.findMany({
      where: { taskId: TASK_ID },
      orderBy: { createdAt: 'desc' },
    });

    console.log('=== Payout status check (Neon) ===');
    console.log({
      neonDbUrl: maskedUrl,
      neonHost: 'ep-solitary-violet-a19m2bej-pooler.ap-southeast-1.aws.neon.tech',
      neonDatabase: 'neondb',
      escrowId: ESCROW_ID,
      taskId: TASK_ID,
    });
    console.log(`\nPayouts linked to escrow: ${payoutsByEscrow.length}`);
    for (const p of payoutsByEscrow) {
      console.log({
        payoutId: p.payoutId,
        status: p.status,
        performerUid: p.performerUid,
        netAmount: p.netAmount.toString(),
        type: p.type,
        source: p.source,
        createdAt: p.createdAt,
        completedAt: p.completedAt,
        errorMessage: p.errorMessage,
      });
    }
    console.log(`\nPayouts linked to taskId: ${payoutsByTask.length}`);
    for (const p of payoutsByTask) {
      console.log({
        payoutId: p.payoutId,
        status: p.status,
        escrowId: p.escrowId,
        performerUid: p.performerUid,
        netAmount: p.netAmount.toString(),
        createdAt: p.createdAt,
        completedAt: p.completedAt,
      });
    }
    if (!payoutsByEscrow.length && !payoutsByTask.length) {
      console.log('\nNO payout rows found — payout not initiated yet.');
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
