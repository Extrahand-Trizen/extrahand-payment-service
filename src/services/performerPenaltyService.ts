/**
 * Tasker (performer) cancellation penalties — owed to platform, recovered from next payout(s).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
import { calculateCancellationFee } from './feeCalculationService';

function generatePenaltyId(): string {
  return `penalty_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export async function createPerformerCancellationPenalty(params: {
  performerUid: string;
  taskId: string;
  escrowId?: string | null;
  taskStartDate: Date;
  cancelledAt: Date;
  feeBaseAmount: number;
  reason?: string;
  taskTitle?: string;
}): Promise<{ success: boolean; penalty?: { penaltyId: string; amount: string }; skipped?: boolean; error?: string }> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const {
      performerUid,
      taskId,
      escrowId,
      taskStartDate,
      cancelledAt,
      feeBaseAmount,
      reason,
      taskTitle,
    } = params;

    const dup = await prisma.performerCancellationPenalty.findFirst({
      where: {
        taskId,
        performerUid,
        status: 'pending',
        remainingAmount: { gt: new Prisma.Decimal(0) },
      },
    });
    if (dup) {
      logger.info('Performer penalty already exists for task', { taskId, performerUid });
      return {
        success: true,
        skipped: true,
        penalty: { penaltyId: dup.penaltyId, amount: dup.amount.toString() },
      };
    }

    const feeResult = await calculateCancellationFee({
      amount: feeBaseAmount,
      taskStartDate,
      cancelledAt,
      cancelledBy: 'performer',
      feeBaseAmount,
    });

    const penaltyAmt = feeResult.cancellationFee;
    if (penaltyAmt.lte(0)) {
      logger.info('Zero performer cancellation penalty — not persisting', { taskId });
      return { success: true, skipped: true };
    }

    const penaltyId = generatePenaltyId();

    const row = await prisma.performerCancellationPenalty.create({
      data: {
        penaltyId,
        performerUid,
        taskId,
        escrowId: escrowId || null,
        amount: penaltyAmt,
        remainingAmount: penaltyAmt,
        status: 'pending',
        feePercentage: new Prisma.Decimal(feeResult.cancellationFeePercentage.toString()),
        cancelledAt,
        reason: reason || null,
        taskTitle: taskTitle || null,
      },
    });

    logger.info('Created performer cancellation penalty', {
      penaltyId,
      taskId,
      performerUid,
      amount: penaltyAmt.toString(),
    });

    return {
      success: true,
      penalty: { penaltyId: row.penaltyId, amount: penaltyAmt.toString() },
    };
  } catch (error: any) {
    logger.error('createPerformerCancellationPenalty failed', error);
    return { success: false, error: error.message || 'Failed to create penalty' };
  }
}

export type PenaltyDeductionLine = {
  penaltyDbId: string;
  penaltyId: string;
  taskId: string;
  applied: Prisma.Decimal;
  remainingAfter: Prisma.Decimal;
};

/**
 * Plan how much to take from gross payout; does not write DB.
 */
export async function planPenaltyDeductionsFromGross(
  performerUid: string,
  grossAmount: Prisma.Decimal
): Promise<{
  netTransfer: Prisma.Decimal;
  totalDeducted: Prisma.Decimal;
  lines: PenaltyDeductionLine[];
}> {
  logger.debug('[planPenaltyDeductionsFromGross] Starting penalty deduction planning', {
    performerUid,
    grossAmount: grossAmount.toString(),
  });

  const lines: PenaltyDeductionLine[] = [];
  let pool = grossAmount;
  let totalDeducted = new Prisma.Decimal(0);

  if (pool.lte(0)) {
    logger.debug('[planPenaltyDeductionsFromGross] Gross amount <= 0, no deductions', {
      performerUid,
      grossAmount: grossAmount.toString(),
    });
    return { netTransfer: new Prisma.Decimal(0), totalDeducted, lines };
  }

  const pending = await prisma.performerCancellationPenalty.findMany({
    where: {
      performerUid,
      status: 'pending',
      remainingAmount: { gt: new Prisma.Decimal(0) },
    },
    orderBy: { createdAt: 'asc' },
  });

  logger.info('[planPenaltyDeductionsFromGross] Found pending penalties', {
    performerUid,
    penaltyCount: pending.length,
    totalPendingAmount: pending.reduce((sum, p) => sum.add(p.remainingAmount), new Prisma.Decimal(0)).toString(),
  });

  for (const p of pending) {
    if (pool.lte(0)) break;
    const rem = new Prisma.Decimal(p.remainingAmount.toString());
    if (rem.lte(0)) continue;
    const take = Prisma.Decimal.min(rem, pool);
    if (take.lte(0)) continue;
    const remainingAfter = rem.sub(take);
    pool = pool.sub(take);
    totalDeducted = totalDeducted.add(take);
    lines.push({
      penaltyDbId: p.id,
      penaltyId: p.penaltyId,
      taskId: p.taskId,
      applied: take,
      remainingAfter,
    });

    logger.debug('[planPenaltyDeductionsFromGross] Deducting penalty from pool', {
      penaltyId: p.penaltyId,
      taskId: p.taskId,
      penaltyRemaining: rem.toString(),
      deductedFromPool: take.toString(),
      remainingAfter: remainingAfter.toString(),
      poolRemaining: pool.toString(),
    });
  }

  logger.info('[planPenaltyDeductionsFromGross] Completed penalty deduction plan', {
    performerUid,
    grossAmount: grossAmount.toString(),
    totalDeducted: totalDeducted.toString(),
    netTransfer: pool.toString(),
    deductionLineCount: lines.length,
  });

  return { netTransfer: pool, totalDeducted, lines };
}

/** Apply penalty deductions inside a Prisma transaction (with payout create). */
export async function applyPenaltyLinesInTx(
  tx: Prisma.TransactionClient,
  lines: PenaltyDeductionLine[]
): Promise<void> {
  logger.info('[applyPenaltyLinesInTx] Applying penalty deductions inside transaction', {
    lineCount: lines.length,
  });

  for (const line of lines) {
    const fullyApplied = line.remainingAfter.lte(0);
    await tx.performerCancellationPenalty.update({
      where: { id: line.penaltyDbId },
      data: {
        remainingAmount: fullyApplied ? new Prisma.Decimal(0) : line.remainingAfter,
        status: fullyApplied ? 'applied' : 'pending',
        ...(fullyApplied ? { appliedAt: new Date() } : {}),
      },
    });

    logger.debug('[applyPenaltyLinesInTx] Applied penalty deduction', {
      penaltyId: line.penaltyId,
      penaltyDbId: line.penaltyDbId,
      taskId: line.taskId,
      applied: line.applied.toString(),
      remainingAfter: line.remainingAfter.toString(),
      fullyApplied,
      newStatus: fullyApplied ? 'applied' : 'pending',
    });
  }

  logger.info('[applyPenaltyLinesInTx] Completed applying all penalty deductions', {
    lineCount: lines.length,
  });
}

export async function getPendingPenaltySummary(
  performerUid: string,
  linkedUids?: string[]
): Promise<{
  success: boolean;
  totalRemaining?: string;
  items?: Array<{
    penaltyId: string;
    taskId: string;
    taskTitle: string | null;
    amount: string;
    remainingAmount: string;
    cancelledAt: string;
    reason: string | null;
  }>;
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      logger.warn('[getPendingPenaltySummary] Postgres not connected', { performerUid });
      return { success: false, error: 'Postgres not connected' };
    }

    const uidList = [
      ...new Set(
        [performerUid, ...(linkedUids || [])].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0
        )
      ),
    ];

    logger.debug('[getPendingPenaltySummary] Fetching pending penalties', {
      performerUid,
      uidCount: uidList.length,
      allUids: uidList,
    });

    const rows = await prisma.performerCancellationPenalty.findMany({
      where: {
        performerUid: { in: uidList },
        status: 'pending',
        remainingAmount: { gt: new Prisma.Decimal(0) },
      },
      orderBy: { createdAt: 'asc' },
    });

    let sum = new Prisma.Decimal(0);
    for (const r of rows) {
      sum = sum.add(r.remainingAmount);
    }

    logger.info('[getPendingPenaltySummary] Fetched pending penalties', {
      performerUid,
      penaltyCount: rows.length,
      totalRemaining: sum.toString(),
      penalties: rows.map((r) => ({
        penaltyId: r.penaltyId,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        amount: r.amount.toString(),
        remainingAmount: r.remainingAmount.toString(),
      })),
    });

    return {
      success: true,
      totalRemaining: sum.toString(),
      items: rows.map((r) => ({
        penaltyId: r.penaltyId,
        taskId: r.taskId,
        taskTitle: r.taskTitle,
        amount: r.amount.toString(),
        remainingAmount: r.remainingAmount.toString(),
        cancelledAt: r.cancelledAt.toISOString(),
        reason: r.reason,
      })),
    };
  } catch (error: any) {
    logger.error('[getPendingPenaltySummary] Error fetching pending penalties', {
      performerUid,
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
}
