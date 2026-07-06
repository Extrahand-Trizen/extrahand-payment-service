import { getEscrowByTaskId } from './escrowService';
import { getPayoutsByEscrowId } from './payoutService';
import { getExtraCoinsWallet } from './extraCoinsService';
import { estimateBiddingTaskCompletionPayout } from './feeCalculationService';
import logger from '../config/logger';

const MAX_BATCH_PAYOUT_IDS = 50;

export async function getTaskPayoutBundle(params: {
  taskId: string;
  performerUid?: string;
  linkedUserIds?: string[];
}): Promise<{
  success: boolean;
  bundle?: {
    escrow: Record<string, unknown> | null;
    payout: Record<string, unknown> | null;
    extraCoins: {
      balanceCoins: string;
      balanceRupees: string;
      usableForTask: boolean;
    } | null;
    feeEstimate: Record<string, unknown> | null;
  };
  error?: string;
}> {
  const { taskId, performerUid, linkedUserIds } = params;

  if (!taskId?.trim()) {
    return { success: false, error: 'taskId is required' };
  }

  try {
    const escrow = await getEscrowByTaskId(taskId.trim());

    const [payoutsResult, walletResult, feeEstimate] = await Promise.all([
      escrow?.escrowId
        ? getPayoutsByEscrowId(String(escrow.escrowId))
        : Promise.resolve({ success: true, payouts: [] as unknown[] }),
      performerUid
        ? getExtraCoinsWallet(performerUid, linkedUserIds, 'tasker')
        : Promise.resolve({ success: true, wallet: undefined }),
      escrow?.taskAmount != null
        ? estimateBiddingTaskCompletionPayout({
            taskAmount: Number(escrow.taskAmount),
            taskCategory:
              typeof escrow.taskCategory === 'string' ? escrow.taskCategory : undefined,
          }).catch(() => null)
        : escrow?.amountInRupees != null
          ? estimateBiddingTaskCompletionPayout({
              taskAmount: Number(escrow.amountInRupees),
              taskCategory:
                typeof escrow.taskCategory === 'string' ? escrow.taskCategory : undefined,
            }).catch(() => null)
          : Promise.resolve(null),
    ]);

    const payouts = payoutsResult.success ? payoutsResult.payouts ?? [] : [];
    const latestPayout =
      payouts.length > 0
        ? (payouts[0] as Record<string, unknown>)
        : null;

    const wallet = walletResult.success ? walletResult.wallet : undefined;

    return {
      success: true,
      bundle: {
        escrow: escrow
          ? {
              escrowId: escrow.escrowId,
              status: escrow.status,
              amountInRupees: escrow.amountInRupees,
              taskId: escrow.taskId,
              paymentStatus: escrow.paymentStatus,
              taskAmount: escrow.taskAmount,
              performerUid: escrow.performerUid,
            }
          : null,
        payout: latestPayout,
        extraCoins: wallet
          ? {
              balanceCoins: wallet.totalCoins,
              balanceRupees: wallet.totalRupeeValue,
              usableForTask: Number(wallet.totalRupeeValue) > 0,
            }
          : null,
        feeEstimate: feeEstimate
          ? {
              taskAmount: Number(feeEstimate.taskAmount),
              platformCommission: Number(feeEstimate.platformCommission),
              gstOnCommission: Number(feeEstimate.gstOnCommission),
              netAmount: Number(feeEstimate.netAmount),
              metadata: feeEstimate.metadata,
            }
          : null,
      },
    };
  } catch (error: unknown) {
    logger.error('Error building task payout bundle', {
      taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to build payout bundle',
    };
  }
}

export async function getPayoutStatusBatch(payoutIds: string[]): Promise<{
  success: boolean;
  payouts?: Array<{ payoutId: string; status: string; payout?: Record<string, unknown> }>;
  error?: string;
}> {
  const uniqueIds = Array.from(
    new Set(
      (payoutIds || [])
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0),
    ),
  ).slice(0, MAX_BATCH_PAYOUT_IDS);

  if (uniqueIds.length === 0) {
    return { success: false, error: 'At least one payoutId is required' };
  }

  const { getPayoutStatus } = await import('./payoutService');

  const results = await Promise.all(
    uniqueIds.map(async (payoutId) => {
      const result = await getPayoutStatus(payoutId);
      return {
        payoutId,
        status: result.success && result.payout ? String(result.payout.status) : 'unknown',
        payout: result.success ? (result.payout as Record<string, unknown>) : undefined,
        found: result.success,
      };
    }),
  );

  return {
    success: true,
    payouts: results.map(({ payoutId, status, payout }) => ({
      payoutId,
      status,
      ...(payout ? { payout } : {}),
    })),
  };
}
