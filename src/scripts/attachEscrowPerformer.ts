/**
 * Attach performer UID to an existing Book Now escrow in Neon.
 *
 * Usage:
 *   npx ts-node src/scripts/attachEscrowPerformer.ts \
 *     --escrow-id=escrow_1782100409517_73wku5g \
 *     --performer-uid=ZnYZTT44tjPmvMFLvraCfMhtEqL2 \
 *     --application-id=6a3ba273cb131716957b84dc
 */
import dotenv from 'dotenv';
import { prisma, disconnectPrisma } from '../config/prisma';

dotenv.config();

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : '';
}

async function main() {
  const escrowId = arg('escrow-id');
  const performerUid = arg('performer-uid');
  const applicationId = arg('application-id') || undefined;
  const dryRun = process.argv.includes('--dry-run');

  if (!escrowId || !performerUid) {
    throw new Error('--escrow-id and --performer-uid are required');
  }

  const existing = await prisma.escrow.findFirst({
    where: { OR: [{ escrowId }, { id: escrowId }] },
  });

  if (!existing) {
    throw new Error(`Escrow not found: ${escrowId}`);
  }

  console.log('Before:', {
    escrowId: existing.escrowId,
    taskId: existing.taskId,
    performerUid: existing.performerUid,
    applicationId: existing.applicationId,
    status: existing.status,
    paymentStatus: existing.paymentStatus,
  });

  const pendingPerformer =
    !existing.performerUid || existing.performerUid === 'pending_assignment';
  if (!pendingPerformer && existing.performerUid !== performerUid) {
    throw new Error(
      `Performer already attached (${existing.performerUid}). Reassign not supported by this script.`,
    );
  }

  if (dryRun) {
    console.log('Dry run — would set performerUid to', performerUid);
    return;
  }

  const meta =
    existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? { ...(existing.metadata as Record<string, unknown>) }
      : {};

  const updated = await prisma.escrow.update({
    where: { id: existing.id },
    data: {
      performerUid,
      applicationId: applicationId || existing.applicationId,
      metadata: {
        ...meta,
        performerUid,
        performerAttachedAt: new Date().toISOString(),
      } as any,
      updatedAt: new Date(),
    },
  });

  console.log('\nAfter:', {
    escrowId: updated.escrowId,
    taskId: updated.taskId,
    bookingOrderId: updated.bookingOrderId,
    performerUid: updated.performerUid,
    applicationId: updated.applicationId,
    status: updated.status,
    paymentStatus: updated.paymentStatus,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
