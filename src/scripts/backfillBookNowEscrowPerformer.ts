/**
 * Backfill missing Book Now escrow in Neon from Razorpay, then attach performer.
 */
import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { razorpay, RAZORPAY_CONFIG } from '../config/razorpay';
import { prisma, disconnectPrisma } from '../config/prisma';
import { getOrderDetails, getPaymentDetails } from '../services/paymentService';
import { sanitizeRazorpayOrderData, sanitizeRazorpayPaymentData } from '../utils/paymentSanitizer';
import { createLedgerEntry } from '../services/ledgerService';

dotenv.config();

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=').trim() : '';
}

async function fetchCapturedPaymentForOrder(razorpayOrderId: string) {
  const payments = await razorpay.orders.fetchPayments(razorpayOrderId);
  const items = (payments as { items?: unknown[] }).items ?? [];
  const captured = items.find((p) => {
    const row = p as { status?: string; id?: string };
    return row.status === 'captured' && row.id;
  }) as { id: string } | undefined;
  if (!captured?.id) return null;
  const details = await getPaymentDetails(captured.id);
  return details.success ? details.payment : null;
}

async function ensureEscrowRow(params: {
  escrowId: string;
  razorpayOrderId: string;
  taskId: string;
  bookingOrderId: string;
  posterUid: string;
  taskAmountRupees: number;
  taskCategory: string;
  taskTitle: string;
}) {
  const existing =
    (await prisma.escrow.findFirst({ where: { escrowId: params.escrowId } })) ??
    (await prisma.escrow.findUnique({ where: { razorpayOrderId: params.razorpayOrderId } }));

  if (existing) {
    console.log('Escrow already exists:', existing.escrowId);
    return existing;
  }

  const orderResult = await getOrderDetails(params.razorpayOrderId);
  if (!orderResult.success || !orderResult.order) {
    throw new Error(orderResult.error || 'Failed to fetch Razorpay order');
  }

  const order = orderResult.order as Record<string, unknown>;
  const amountPaise = Number(order.amount);
  if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
    throw new Error('Invalid Razorpay order amount');
  }

  const amountInRupees = new Prisma.Decimal((amountPaise / 100).toFixed(2));
  const taskAmountDecimal = new Prisma.Decimal(params.taskAmountRupees.toFixed(2));

  const created = await prisma.escrow.create({
    data: {
      escrowId: params.escrowId,
      razorpayOrderId: params.razorpayOrderId,
      taskId: params.taskId,
      applicationId: null,
      posterUid: params.posterUid,
      performerUid: 'pending_assignment',
      bookingOrderId: params.bookingOrderId,
      amount: new Prisma.Decimal(amountPaise.toString()),
      currency: String(order.currency || 'INR'),
      amountInRupees,
      taskAmount: taskAmountDecimal,
      status: 'pending',
      razorpayOrderData: sanitizeRazorpayOrderData(order) as any,
      metadata: {
        bookingMode: 'book_now',
        bookingOrderId: params.bookingOrderId,
        taskId: params.taskId,
        taskTitle: params.taskTitle,
        taskCategory: params.taskCategory,
        posterUid: params.posterUid,
        performerUid: 'pending_assignment',
        originalAmountRupees: params.taskAmountRupees.toString(),
        backfilledAt: new Date().toISOString(),
      } as any,
      taskCategory: params.taskCategory,
    },
  });

  await createLedgerEntry({
    escrowId: created.id,
    type: 'escrow',
    amount: amountInRupees,
    balanceBefore: new Prisma.Decimal('0.00'),
    balanceAfter: amountInRupees,
    description: `Escrow backfilled for task ${params.taskId}`,
    metadata: {
      escrowId: created.escrowId,
      razorpayOrderId: params.razorpayOrderId,
      taskId: params.taskId,
      backfilled: true,
    },
  });

  console.log('Created backfilled escrow:', created.escrowId);
  return created;
}

async function markCaptured(razorpayOrderId: string, payment: Record<string, unknown>) {
  const paymentId = String(payment.id || '');
  const sanitized = sanitizeRazorpayPaymentData(payment);
  const now = new Date();

  const updated = await prisma.escrow.update({
    where: { razorpayOrderId },
    data: {
      razorpayPaymentId: paymentId,
      paymentStatus: 'captured',
      status: 'held',
      heldAt: now,
      razorpayPaymentData: sanitized as any,
      metadata: {
        capturedAt: now.toISOString(),
      },
      updatedAt: now,
    },
  });

  await prisma.transaction.upsert({
    where: { razorpayPaymentId: paymentId },
    create: {
      userId: updated.posterUid,
      taskId: updated.taskId,
      razorpayOrderId,
      razorpayPaymentId: paymentId,
      amount: updated.amountInRupees,
      currency: updated.currency,
      status: 'captured',
      paymentMethod: typeof payment.method === 'string' ? payment.method : null,
      metadata: { backfilled: true } as any,
    },
    update: {
      status: 'captured',
      updatedAt: now,
    },
  });

  return updated;
}

async function attachPerformer(
  escrowId: string,
  performerUid: string,
  applicationId?: string,
) {
  const existing = await prisma.escrow.findFirst({
    where: { OR: [{ escrowId }, { id: escrowId }] },
  });
  if (!existing) throw new Error(`Escrow not found: ${escrowId}`);

  const meta =
    existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
      ? { ...(existing.metadata as Record<string, unknown>) }
      : {};

  return prisma.escrow.update({
    where: { id: existing.id },
    data: {
      performerUid,
      applicationId: applicationId || existing.applicationId,
      metadata: {
        ...meta,
        performerUid,
        performerAttachedAt: new Date().toISOString(),
        backfilledPerformerAttach: true,
      } as any,
      updatedAt: new Date(),
    },
  });
}

async function main() {
  if (!RAZORPAY_CONFIG.keyId) {
    throw new Error('Razorpay credentials missing in payment service .env');
  }

  const escrowId = arg('escrow-id');
  const razorpayOrderId = arg('razorpay-order-id');
  const taskId = arg('task-id');
  const bookingOrderId = arg('booking-order-id');
  const performerUid = arg('performer-uid');
  const applicationId = arg('application-id') || undefined;
  const posterUid = arg('poster-uid') || 'c4mPkSdFNnTICiA8Mns4I1p66o92';
  const taskAmountRupees = Number(arg('task-amount') || '449');
  const taskCategory = arg('task-category') || 'repair';
  const taskTitle = arg('task-title') || 'Foam Blast Service';
  const dryRun = process.argv.includes('--dry-run');

  if (!escrowId || !razorpayOrderId || !taskId || !bookingOrderId || !performerUid) {
    throw new Error('Missing required args');
  }

  console.log('Input:', {
    escrowId,
    razorpayOrderId,
    taskId,
    bookingOrderId,
    performerUid,
    applicationId,
    posterUid,
    taskAmountRupees,
    dryRun,
  });

  if (dryRun) {
    console.log('Dry run — no writes.');
    return;
  }

  const row = await ensureEscrowRow({
    escrowId,
    razorpayOrderId,
    taskId,
    bookingOrderId,
    posterUid,
    taskAmountRupees,
    taskCategory,
    taskTitle,
  });

  let current = row;
  if (current.paymentStatus !== 'captured') {
    const payment = await fetchCapturedPaymentForOrder(razorpayOrderId);
    if (!payment) throw new Error('No captured Razorpay payment found for order');
    current = await markCaptured(razorpayOrderId, payment as Record<string, unknown>);
    console.log('Marked escrow captured:', {
      escrowId: current.escrowId,
      status: current.status,
      paymentStatus: current.paymentStatus,
      razorpayPaymentId: current.razorpayPaymentId,
    });
  }

  const attached = await attachPerformer(current.escrowId, performerUid, applicationId);
  console.log('\nDone.');
  console.log({
    escrowId: attached.escrowId,
    taskId: attached.taskId,
    bookingOrderId: attached.bookingOrderId,
    performerUid: attached.performerUid,
    applicationId: attached.applicationId,
    status: attached.status,
    paymentStatus: attached.paymentStatus,
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
