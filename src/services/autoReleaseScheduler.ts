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
import { processPayout } from './payoutService';
import { getEscrowByOrderId } from './escrowService';

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

/**
 * Process auto-release for a single escrow
 */
async function processAutoRelease(escrow: any): Promise<void> {
  try {
    const { escrowId, razorpayOrderId, performerUid, amountInRupees, taskId } = escrow;

    logger.info('🔄 Processing auto-release', {
      escrowId,
      razorpayOrderId,
      taskId,
    });

    // Check if task is completed
    const taskCompleted = await isTaskCompleted(taskId);
    if (!taskCompleted) {
      logger.info('⏸️ Task not completed yet - skipping auto-release', {
        escrowId,
        taskId,
      });
      return;
    }

    // Get performer bank account from UserPaymentProfile
    const profile = await prisma.userPaymentProfile.findUnique({
      where: { userId: performerUid },
    });

    if (!profile?.defaultBankAccountId) {
      logger.warn('⚠️ No default bank account for auto-release', {
        escrowId,
        performerUid,
      });
      // Skip auto-release if no bank account - user needs to set one up
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

    // Process payout using stored bank account
    const payoutResult = await processPayout({
      razorpayOrderId,
      performerUid,
      bankAccountId: bankAccount.id, // Use stored bank account
      userId: 'system', // System-initiated payout
    });

    if (payoutResult.success) {
      logger.info('✅ Auto-release completed', {
        escrowId,
        payoutId: payoutResult.payout?.payoutId,
      });
    } else {
      logger.error('❌ Auto-release failed', {
        escrowId,
        error: payoutResult.error,
      });
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
    if (!isPostgresConnected()) {
      logger.warn('⚠️ Postgres not connected - skipping auto-release check');
      return;
    }

    const now = new Date();

    // Find escrows ready for auto-release
    // Conditions:
    // 1. Status is 'held'
    // 2. autoReleaseDate is set and <= now
    const readyEscrows = await prisma.escrow.findMany({
      where: {
        status: 'held',
        autoReleaseDate: {
          not: null,
          lte: now,
        },
      },
      orderBy: {
        autoReleaseDate: 'asc', // Process oldest first
      },
    });

    if (readyEscrows.length === 0) {
      logger.debug('📊 No escrows ready for auto-release');
      return;
    }

    logger.info(`🔄 Found ${readyEscrows.length} escrow(s) ready for auto-release`);

    // Process escrows in parallel batches for better performance
    // Use a concurrency limit to avoid overwhelming the system
    const BATCH_SIZE = 5; // Process 5 escrows in parallel at a time
    
    for (let i = 0; i < readyEscrows.length; i += BATCH_SIZE) {
      const batch = readyEscrows.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel
      await Promise.all(
        batch.map(escrow => 
          processAutoRelease(escrow).catch(error => {
            // Log error but don't fail the entire batch
            logger.error('❌ Error processing auto-release in batch:', {
              escrowId: escrow.escrowId,
              error: error.message,
            });
          })
        )
      );
      
      logger.debug(`✅ Processed batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(readyEscrows.length / BATCH_SIZE)}`);
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

    // Find escrows that should have been released but weren't
    // (autoReleaseDate is in the past and status is still 'held')
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

    logger.info(`🔄 Found ${missedEscrows.length} missed auto-release(s) - processing now`);

    // Process missed escrows in parallel batches
    const BATCH_SIZE = 5; // Process 5 escrows in parallel at a time
    
    for (let i = 0; i < missedEscrows.length; i += BATCH_SIZE) {
      const batch = missedEscrows.slice(i, i + BATCH_SIZE);
      
      // Process batch in parallel
      await Promise.all(
        batch.map(escrow => 
          processAutoRelease(escrow).catch(error => {
            // Log error but don't fail the entire batch
            logger.error('❌ Error processing missed auto-release in batch:', {
              escrowId: escrow.escrowId,
              error: error.message,
            });
          })
        )
      );
      
      logger.debug(`✅ Processed catch-up batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(missedEscrows.length / BATCH_SIZE)}`);
    }

    logger.info('✅ Catch-up completed');
  } catch (error: any) {
    logger.error('❌ Error in catch-up:', error);
  }
}

/**
 * Start the auto-release scheduler
 */
export function startAutoReleaseScheduler(): void {
  try {
    const intervalMinutes = getCheckIntervalMinutes();
    
    // Convert minutes to cron expression
    // Every N minutes: `*/N * * * *`
    const cronExpression = `*/${intervalMinutes} * * * *`;

    logger.info('⏰ Starting auto-release scheduler', {
      intervalMinutes,
      cronExpression,
      gracePeriodMinutes: getGracePeriodMinutes(),
    });

    // Run catch-up on startup
    catchUpMissedReleases().catch(error => {
      logger.error('❌ Error in startup catch-up:', error);
    });

    // Schedule periodic checks
    cron.schedule(cronExpression, async () => {
      logger.debug('🔄 Running scheduled auto-release check');
      await checkAndProcessAutoReleases();
    });

    logger.info('✅ Auto-release scheduler started');
  } catch (error: any) {
    logger.error('❌ Error starting auto-release scheduler:', error);
  }
}

/**
 * Stop the auto-release scheduler
 */
export function stopAutoReleaseScheduler(): void {
  // Cron jobs are automatically stopped when the process exits
  // This function is for future use if we need manual control
  logger.info('⏹️ Auto-release scheduler stopped');
}

