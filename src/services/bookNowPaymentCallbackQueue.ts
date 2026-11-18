import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { TaskServiceClient } from '../clients/TaskServiceClient';

const JOB_TYPE = 'book_now_payment_captured_callback';
const MAX_ATTEMPTS = 10;
const CLAIM_STALE_MS = 2 * 60 * 1000;
const BASE_RETRY_MS = 10 * 1000;
const MAX_RETRY_MS = 15 * 60 * 1000;

type CallbackParams = {
  bookingOrderId: string;
  escrowId: string;
  razorpayOrderId: string;
  taskId: string;
};

function callbackJobId(escrowId: string): string {
  return `book_now_payment_captured_${escrowId}`;
}

function errorDetails(error: unknown): { status: number; message: string } {
  const candidate = error as {
    response?: { status?: number; data?: { error?: unknown; message?: unknown } };
    message?: unknown;
  };
  const status = Number(candidate?.response?.status) || 0;
  const message = String(
    candidate?.response?.data?.error ||
      candidate?.response?.data?.message ||
      candidate?.message ||
      'Task service callback failed',
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500);
  return { status, message };
}

async function processCallbackJob(jobId: string): Promise<void> {
  const now = new Date();
  const claimed = await prisma.jobQueue.updateMany({
    where: {
      jobId,
      jobType: JOB_TYPE,
      OR: [
        { status: 'pending', nextRetryAt: { lte: now } },
        { status: 'processing', updatedAt: { lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
      ],
    },
    data: { status: 'processing', attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) return;

  const job = await prisma.jobQueue.findUnique({ where: { jobId } });
  const payload = job?.payload as CallbackParams | null;
  if (!job || !payload?.bookingOrderId || !payload.escrowId || !payload.razorpayOrderId || !payload.taskId) {
    await prisma.jobQueue.update({
      where: { jobId },
      data: { status: 'failed', lastError: 'Invalid captured-payment callback payload', completedAt: new Date() },
    });
    return;
  }

  try {
    const result = await TaskServiceClient.notifyBookingPaymentCaptured(payload);
    if (!result.success) throw new Error(result.error || 'Task service rejected payment callback');

    if (Array.isArray(result.tasks) && result.tasks.length > 0) {
      const firstTask = result.tasks[0] as Record<string, unknown> | string;
      const resolvedTaskId = String(
        (typeof firstTask === 'object' && firstTask ? firstTask._id || firstTask.id : firstTask) || '',
      ).trim();
      const escrow = await prisma.escrow.findUnique({
        where: { escrowId: payload.escrowId },
      });

      if (resolvedTaskId && escrow && resolvedTaskId !== payload.taskId) {
        const oldMetadata =
          escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
            ? (escrow.metadata as Record<string, unknown>)
            : {};
        const oldLineItems = Array.isArray(oldMetadata.bookNowLineItems)
          ? oldMetadata.bookNowLineItems
          : [];
        const updatedLineItems = oldLineItems.map((item, index) => {
          const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
          const materializedTask = result.tasks?.[index] as Record<string, unknown> | string | undefined;
          const lineTaskId = String(
            (typeof materializedTask === 'object' && materializedTask
              ? materializedTask._id || materializedTask.id
              : materializedTask) || '',
          ).trim();
          return lineTaskId && lineTaskId !== payload.taskId ? { ...row, taskId: lineTaskId } : row;
        });

        await prisma.escrow.update({
          where: { id: escrow.id },
          data: {
            taskId: resolvedTaskId,
            metadata: { ...oldMetadata, bookNowLineItems: updatedLineItems } as Prisma.InputJsonValue,
          },
        });
        await Promise.all([
          prisma.transaction.updateMany({
            where: {
              OR: [
                { razorpayOrderId: payload.razorpayOrderId },
                { taskId: payload.taskId },
                ...(escrow.razorpayPaymentId ? [{ razorpayPaymentId: escrow.razorpayPaymentId }] : []),
              ],
            },
            data: { taskId: resolvedTaskId },
          }),
          prisma.ledger.updateMany({
            where: { escrowId: escrow.id },
            data: { taskId: resolvedTaskId },
          }),
        ]);
      }
    }

    await prisma.jobQueue.update({
      where: { jobId },
      data: { status: 'completed', completedAt: new Date(), lastError: null },
    });
  } catch (error) {
    const { status, message } = errorDetails(error);
    const latestJob = await prisma.jobQueue.findUnique({ where: { jobId } });
    const attemptCount = latestJob?.attemptCount ?? MAX_ATTEMPTS;
    const permanent = status >= 400 && status < 500 && status !== 409 && status !== 429;
    if (permanent || attemptCount >= (latestJob?.maxAttempts ?? MAX_ATTEMPTS)) {
      await prisma.jobQueue.update({
        where: { jobId },
        data: { status: 'failed', lastError: message, completedAt: new Date() },
      });
      logger.error('Book Now payment callback requires reconciliation', {
        jobId,
        bookingOrderId: payload.bookingOrderId,
        attemptCount,
        status,
        error: message,
      });
      return;
    }

    const retryDelay = Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attemptCount - 1), MAX_RETRY_MS);
    await prisma.jobQueue.update({
      where: { jobId },
      data: {
        status: 'pending',
        lastError: message,
        nextRetryAt: new Date(Date.now() + retryDelay),
      },
    });
    logger.warn('Book Now payment callback retry scheduled', {
      jobId,
      bookingOrderId: payload.bookingOrderId,
      attemptCount,
      retryDelay,
      status,
      error: message,
    });
  }
}

export async function enqueueBookNowPaymentCapturedCallback(
  params: CallbackParams,
): Promise<void> {
  const jobId = callbackJobId(params.escrowId);
  await prisma.jobQueue.upsert({
    where: { jobId },
    create: {
      jobId,
      jobType: JOB_TYPE,
      entityType: 'escrow',
      entityId: params.escrowId,
      payload: params as Prisma.InputJsonValue,
      status: 'pending',
      maxAttempts: MAX_ATTEMPTS,
      nextRetryAt: new Date(),
      priority: 10,
    },
    update: {},
  });
  void processCallbackJob(jobId).catch((error) => {
    logger.error('Book Now payment callback worker failed unexpectedly', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;

export function startBookNowPaymentCallbackWorker(): void {
  if (workerTimer) return;
  workerTimer = setInterval(() => {
    if (workerRunning) return;
    workerRunning = true;
    void (async () => {
      try {
        const dueJobs = await prisma.jobQueue.findMany({
          where: {
            jobType: JOB_TYPE,
            OR: [
              { status: 'pending', nextRetryAt: { lte: new Date() } },
              { status: 'processing', updatedAt: { lt: new Date(Date.now() - CLAIM_STALE_MS) } },
            ],
          },
          orderBy: [{ priority: 'desc' }, { nextRetryAt: 'asc' }],
          take: 25,
          select: { jobId: true },
        });
        await Promise.all(dueJobs.map(({ jobId }) => processCallbackJob(jobId)));
      } catch (error) {
        logger.error('Book Now payment callback queue poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        workerRunning = false;
      }
    })();
  }, 15_000);
  workerTimer.unref?.();
}

export function stopBookNowPaymentCallbackWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
