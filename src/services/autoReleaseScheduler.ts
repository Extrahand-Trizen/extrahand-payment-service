/**
 * Auto-Release Scheduler
 * 
 * Automatically releases escrow funds after grace period
 * Runs every 5 minutes (configurable)
 * Grace period: 1 minute (configurable via PAYMENT_GRACE_PERIOD_MINUTES env var, ideally 12 hours in production)
 * Catch-up on server startup for missed releases
 */

import cron from 'node-cron';
import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
import { prisma } from '../config/prisma';
import { processTaskCompletionPayout } from './payoutService';
import { releaseEscrow, getAllActiveEscrowsByTaskId } from './escrowService';

/**
 * Get grace period from environment (default: 10 minutes)
 */
function getGracePeriodMinutes(): number {
  return parseInt(process.env.PAYMENT_GRACE_PERIOD_MINUTES || '1', 10);
}

/**
 * Get check interval from environment (default: 5 minutes)
 */
function getCheckIntervalMinutes(): number {
  return parseInt(process.env.AUTO_RELEASE_CHECK_INTERVAL_MINUTES || '5', 10);
}

/**
 * Check if task is completed by calling task service API
 */
async function isTaskCompleted(taskId: string): Promise<boolean> {
  try {
    const taskServiceUrl = process.env.TASK_SERVICE_URL || 'http://localhost:4002';
    const response = await fetch(`${taskServiceUrl}/api/v1/tasks/${taskId}`, {
      headers: {
        'x-service-auth': process.env.SERVICE_AUTH_TOKEN || '',
      },
    });

    if (!response.ok) {
      logger.warn('Failed to fetch task status', { taskId, status: response.status });
      return false; // If we can't verify, don't release
    }

    const data: any = await response.json();
    const task = data?.data || data;
    
    // Validate task object exists
    if (!task || typeof task !== 'object') {
      logger.warn('Invalid task data received', { taskId, task });
      return false;
    }
    
    // Task must be in 'completed' status
    const isCompleted = task.status === 'completed';
    
    logger.debug('Task completion check', {
      taskId,
      status: task.status,
      isCompleted,
    });
    
    return isCompleted;
  } catch (error: any) {
    logger.error('Error checking task completion:', {
      taskId,
      error: error.message,
    });
    return false; // If we can't verify, don't release (fail safe)
  }
}

const tasksProcessedThisCycle = new Set<string>();

/**
 * One combined payout per task: release all escrows, then transfer net amount only.
 */
async function processAutoRelease(escrow: any): Promise<void> {
  try {
    const { escrowId, taskId, performerUid, posterUid } = escrow;

    if (tasksProcessedThisCycle.has(taskId)) {
      return;
    }

    logger.info('🔄 Processing auto-release (combined payout per task)', {
      escrowId,
      taskId,
    });

    const taskCompleted = await isTaskCompleted(taskId);
    if (!taskCompleted) {
      logger.info('⏸️ Task not completed yet - skipping auto-release', {
        escrowId,
        taskId,
      });
      return;
    }

    const profile = await prisma.userPaymentProfile.findUnique({
      where: { userId: performerUid },
    });

    if (!profile?.defaultBankAccountId) {
      logger.warn('⚠️ No default bank account for auto-release', {
        escrowId,
        performerUid,
      });
      return;
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: profile.defaultBankAccountId },
    });

    if (!bankAccount) {
      logger.warn('⚠️ Default bank account not found', {
        escrowId,
        bankAccountId: profile.defaultBankAccountId,
      });
      return;
    }

    tasksProcessedThisCycle.add(taskId);

    const activeEscrows = await getAllActiveEscrowsByTaskId(taskId);
    const releaseBy = posterUid || performerUid;

    for (const active of activeEscrows) {
      if (String(active.status).toLowerCase() !== 'held') continue;
      const releaseResult = await releaseEscrow(active.escrowId, releaseBy);
      if (!releaseResult.success) {
        logger.warn('[autoRelease] Escrow release failed', {
          escrowId: active.escrowId,
          error: releaseResult.error,
        });
      }
    }

    const payoutResult = await processTaskCompletionPayout({
      taskId,
      performerUid,
      amount: 1,
      enqueueOnMissingBank: true,
    });

    if (payoutResult.success) {
      logger.info('✅ Auto-release completed — net amount sent to bank', {
        taskId,
        payoutId: payoutResult.payout?.payoutId,
        netAmount: payoutResult.payout?.netAmount,
        bankTransferAmount: payoutResult.payout?.bankTransferAmount,
      });
    } else {
      logger.error('❌ Auto-release payout failed', {
        taskId,
        error: payoutResult.error,
        requiresBankAccount: payoutResult.requiresBankAccount,
      });
      tasksProcessedThisCycle.delete(taskId);
    }
  } catch (error: any) {
    logger.error('❌ Error processing auto-release:', {
      escrowId: escrow.escrowId,
      error: error.message,
    });
  }
}

/**
 * Check and process escrows ready for auto-release
 */
async function checkAndProcessAutoReleases(): Promise<void> {
  try {
    tasksProcessedThisCycle.clear();

    if (!isPostgresConnected()) {
      logger.warn('⚠️ Postgres not connected - skipping auto-release check');
      return;
    }

    const now = new Date();

    const readyEscrows = await prisma.escrow.findMany({
      where: {
        status: 'held',
        autoReleaseDate: {
          not: null,
          lte: now,
        },
      },
      orderBy: {
        autoReleaseDate: 'asc',
      },
    });

    if (readyEscrows.length === 0) {
      logger.debug('📊 No escrows ready for auto-release');
      return;
    }

    logger.info(`🔄 Found ${readyEscrows.length} escrow(s) ready for auto-release`);

    const seenTaskIds = new Set<string>();
    const uniqueByTask = readyEscrows.filter((e) => {
      if (seenTaskIds.has(e.taskId)) return false;
      seenTaskIds.add(e.taskId);
      return true;
    });

    const BATCH_SIZE = 5;
    
    for (let i = 0; i < uniqueByTask.length; i += BATCH_SIZE) {
      const batch = uniqueByTask.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(escrow => 
          processAutoRelease(escrow).catch(error => {
            logger.error('❌ Error processing auto-release in batch:', {
              escrowId: escrow.escrowId,
              error: error.message,
            });
          })
        )
      );
    }
  } catch (error: any) {
    logger.error('❌ Error in auto-release check:', error);
  }
}

/**
 * Catch-up on missed releases (run on server startup)
 */
export async function catchUpMissedReleases(): Promise<void> {
  try {
    logger.info('🔄 Running catch-up for missed auto-releases');

    if (!isPostgresConnected()) {
      logger.warn('⚠️ Postgres not connected - skipping catch-up');
      return;
    }

    const now = new Date();

    const missedEscrows = await prisma.escrow.findMany({
      where: {
        status: 'held',
        autoReleaseDate: {
          not: null,
          lte: now,
        },
      },
      orderBy: {
        autoReleaseDate: 'asc',
      },
    });

    if (missedEscrows.length === 0) {
      logger.info('✅ No missed auto-releases found');
      return;
    }

    logger.info(`🔄 Found ${missedEscrows.length} missed auto-release(s) — processing catch-up`);

    tasksProcessedThisCycle.clear();
    const seenTaskIds = new Set<string>();
    for (const escrow of missedEscrows) {
      if (seenTaskIds.has(escrow.taskId)) continue;
      seenTaskIds.add(escrow.taskId);
      await processAutoRelease(escrow);
    }

    logger.info('✅ Catch-up for missed auto-releases completed');
  } catch (error: any) {
    logger.error('❌ Error in catch-up for missed auto-releases:', error);
  }
}

/**
 * Start the auto-release scheduler
 */
export function startAutoReleaseScheduler(): void {
  const intervalMinutes = getCheckIntervalMinutes();
  const cronExpression = `*/${intervalMinutes} * * * *`;

  logger.info('🕐 Starting auto-release scheduler', {
    intervalMinutes,
    gracePeriodMinutes: getGracePeriodMinutes(),
    cronExpression,
  });

  cron.schedule(cronExpression, () => {
    checkAndProcessAutoReleases().catch((error) => {
      logger.error('❌ Auto-release scheduler error:', error);
    });
  });

  catchUpMissedReleases().catch((error) => {
    logger.error('❌ Catch-up error on startup:', error);
  });
}
