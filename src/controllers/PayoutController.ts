import { Response, Request } from 'express';
import {
  processPayout,
  getPayoutStatus,
  getPayoutsByEscrowId,
  processTaskCompletionPayout,
  listManualOpsPayoutQueue,
} from '../services/payoutService';
import { BadRequestError, NotFoundError } from '../errors/AppError';

export class PayoutController {
  /**
   * POST /api/v1/payouts/process
   * Process a payout to performer
   */
  static async processPayout(req: Request, res: Response): Promise<void> {
    const {
      razorpayOrderId,
      performerUid,
      bankAccountId,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      userId,
    } = req.body;

    // Validate required fields
    if (!razorpayOrderId || !performerUid) {
      throw new BadRequestError('razorpayOrderId and performerUid are required');
    }

    // Bank account validation: either bankAccountId OR account details
    if (!bankAccountId && (!accountNumber || !ifscCode || !accountHolderName)) {
      throw new BadRequestError(
        'Either bankAccountId or (accountNumber, ifscCode, accountHolderName) are required'
      );
    }

    const result = await processPayout({
      razorpayOrderId,
      performerUid,
      bankAccountId,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      userId,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to process payout');
    }

    res.json({
      success: true,
      payout: result.payout,
    });
  }

  /**
   * POST /api/v1/payouts/task-completion
   * Process payout directly on task completion (without escrow dependency)
   */
  static async processTaskCompletionPayout(req: Request, res: Response): Promise<void> {
    const {
      taskId,
      performerUid,
      amount,
      taskTitle,
      userId,
      useExtraCoins,
      requestedCoinRedeemRupees,
      visitId,
    } = req.body;

    if (!taskId || !performerUid || !amount) {
      throw new BadRequestError('taskId, performerUid and amount are required');
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      throw new BadRequestError('amount must be a valid number greater than 0');
    }

    const result = await processTaskCompletionPayout({
      taskId,
      performerUid,
      amount: numericAmount,
      taskTitle,
      userId,
      enqueueOnMissingBank: false,
      useExtraCoins: useExtraCoins === true,
      requestedCoinRedeemRupees:
        requestedCoinRedeemRupees != null ? Number(requestedCoinRedeemRupees) : undefined,
      visitId: typeof visitId === 'string' ? visitId : undefined,
    });

    if (!result.success) {
      res.status(result.requiresBankAccount ? 409 : 400).json({
        success: false,
        error: result.error || 'Failed to process task completion payout',
        requiresBankAccount: result.requiresBankAccount || false,
      });
      return;
    }

    res.json({
      success: true,
      payout: result.payout,
      payoutId: result.payout?.payoutId,
      status: result.payout?.status,
      amount: result.payout?.amount,
      netAmount: result.payout?.netAmount,
      fees: result.payout?.fees,
      manualOps: result.payout?.manualOps === true,
      message:
        result.payout?.manualOps || result.payout?.status === 'processing'
          ? 'Payout request queued for manual processing'
          : 'Payout processed for task completion',
    });
  }

  /**
   * GET /api/v1/payouts/status/:payoutId
   * Get payout status
   */
  static async getPayoutStatus(req: Request, res: Response): Promise<void> {
    const { payoutId } = req.params;

    if (!payoutId) {
      throw new BadRequestError('payoutId is required');
    }

    const result = await getPayoutStatus(payoutId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Payout not found');
    }

    res.json({
      success: true,
      payout: result.payout,
    });
  }

  /**
   * GET /api/v1/payouts/escrow/:escrowId
   * Get all payouts for an escrow
   */
  static async getPayoutsByEscrowId(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;

    if (!escrowId) {
      throw new BadRequestError('escrowId is required');
    }

    const result = await getPayoutsByEscrowId(escrowId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Payouts not found');
    }

    res.json({
      success: true,
      payouts: result.payouts,
    });
  }

  /**
   * GET /api/v1/payouts/ops/manual-queue
   * List payout requests queued for manual operations processing.
   */
  static async listManualOpsQueue(req: Request, res: Response): Promise<void> {
    const status = typeof req.query.status === 'string' ? req.query.status : 'processing';
    const limit =
      typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const offset =
      typeof req.query.offset === 'string' ? Number(req.query.offset) : undefined;

    const result = await listManualOpsPayoutQueue({ status, limit, offset });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to list payout queue');
    }

    res.json({
      success: true,
      payouts: result.payouts ?? [],
      total: result.total ?? 0,
    });
  }
}


