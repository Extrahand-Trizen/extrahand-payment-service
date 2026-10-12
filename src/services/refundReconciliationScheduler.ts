/**
 * Retries refund follow-ups that were left pending: visit refund syncs to task-service, refunds of
 * duplicate visit captures, and stale recurring refund state. Every step claims its own work through
 * the job queue or a conditional escrow update, so overlapping runs on several instances are safe.
 *
 * REFUND_RECONCILIATION_ENABLED=false disables it; REFUND_RECONCILIATION_INTERVAL_MINUTES (default 10).
 */
import cron from 'node-cron';
import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
import {
  reconcileRecurringVisitRefundState,
  retryPendingRecurringVisitRefundSyncs,
} from './recurringVisitRefundSync';

let running = false;
let task: ReturnType<typeof cron.schedule> | null = null;

function intervalMinutes(): number {
  const parsed = Number.parseInt(String(process.env.REFUND_RECONCILIATION_INTERVAL_MINUTES ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 59 ? parsed : 10;
}

export function refundReconciliationEnabled(): boolean {
  return String(process.env.REFUND_RECONCILIATION_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export async function runRefundReconciliationOnce(): Promise<{ skipped: boolean; error?: string }> {
  if (running) return { skipped: true };
  if (!isPostgresConnected()) return { skipped: true };
  running = true;
  try {
    const syncs = await retryPendingRecurringVisitRefundSyncs(50);
    const repaired = await reconcileRecurringVisitRefundState({ limit: 50 });
    if (syncs.synced || syncs.pending || repaired.escrowsMarkedRefunded || repaired.flaggedForReview || repaired.visitSyncs || repaired.duplicateRefunds) {
      logger.info('[RefundReconciliation] Run complete', { syncs, repaired });
    }
    return { skipped: false };
  } catch (error: any) {
    logger.error('[RefundReconciliation] Run failed', { error: error?.message || String(error) });
    return { skipped: false, error: error?.message || String(error) };
  } finally {
    running = false;
  }
}

export function startRefundReconciliationScheduler(): void {
  if (!refundReconciliationEnabled()) {
    logger.info('[RefundReconciliation] Disabled (REFUND_RECONCILIATION_ENABLED=false)');
    return;
  }
  if (task) return;
  const minutes = intervalMinutes();
  task = cron.schedule(`*/${minutes} * * * *`, () => {
    void runRefundReconciliationOnce();
  });
  logger.info('[RefundReconciliation] Scheduler started', { intervalMinutes: minutes });
}

export function stopRefundReconciliationScheduler(): void {
  task?.stop();
  task = null;
}
