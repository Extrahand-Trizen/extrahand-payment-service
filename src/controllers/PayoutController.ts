import { Response, Request } from 'express';
import {
  processPayout,
  getPayoutStatus,
  getPayoutsByEscrowId,
  processTaskCompletionPayout,
  listManualOpsPayoutQueue,
  holdBookNowTaskPayouts as holdBookNowTaskPayoutsService,
} from '../services/payoutService';
import {
  getTaskPayoutBundle,
  getPayoutStatusBatch,
} from '../services/payoutBundleService';
import { BadRequestError, NotFoundError } from '../errors/AppError';

const TRUSTED_TASK_COMPLETION_PAYOUT_SERVICES = new Set(['task-service']);

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
      parentTaskId,
      source,
      isQuickCommerce,
    } = req.body;

    if (!taskId || !performerUid || !amount) {
      throw new BadRequestError('taskId, performerUid and amount are required');
    }

    const numericAmount = Number(amount);
    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      throw new BadRequestError('amount must be a valid number greater than 0');
    }

    // Only task-service completion flows are trusted internal callers. Everything else (the
    // api-gateway relaying an app request, or an unnamed caller) acts for the authenticated user
    // in X-User-Id and may only request that user's own payout.
    const callerService = String(req.headers['x-service-name'] || '').trim();
    const internalCaller = TRUSTED_TASK_COMPLETION_PAYOUT_SERVICES.has(callerService);
    const callerUid = String(req.headers['x-user-id'] || '').trim();
    if (!internalCaller) {
      if (!callerUid) {
        res.status(401).json({ success: false, error: 'Authenticated user required for payout' });
        return;
      }
      if (callerUid !== String(performerUid).trim()) {
        res.status(403).json({ success: false, error: 'Payout can only be requested by the assigned helper' });
        return;
      }
    }

    const result = await processTaskCompletionPayout({
      taskId,
      performerUid,
      amount: numericAmount,
      taskTitle,
      userId: internalCaller ? userId : callerUid,
      enqueueOnMissingBank: false,
      useExtraCoins: useExtraCoins === true,
      requestedCoinRedeemRupees:
        requestedCoinRedeemRupees != null ? Number(requestedCoinRedeemRupees) : undefined,
      visitId: typeof visitId === 'string' ? visitId : undefined,
      parentTaskId: typeof parentTaskId === 'string' ? parentTaskId : undefined,
      source: internalCaller && typeof source === 'string' ? source : undefined,
      isQuickCommerce: internalCaller && isQuickCommerce === true,
      callerUid: internalCaller ? undefined : callerUid,
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

  /**
   * POST /api/v1/payouts/task/:taskId/hold-book-now
   * Hold Book Now payouts when customer raises an issue (task-service).
   */
  static async holdBookNowTaskPayouts(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

    if (!taskId?.trim()) {
      throw new BadRequestError('taskId is required');
    }

    const result = await holdBookNowTaskPayoutsService({
      taskId: taskId.trim(),
      reason,
    });
    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to hold Book Now payouts');
    }

    res.json({
      success: true,
      heldCount: result.heldCount ?? 0,
    });
  }

  /**
   * GET /api/v1/payouts/task/:taskId/bundle
   * Escrow + payout + wallet + fee estimate in one response.
   */
  static async getTaskPayoutBundle(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params;
    const performerUid =
      typeof req.query.performerUid === 'string' ? req.query.performerUid : undefined;
    const linkedRaw =
      typeof req.query.linkedUserIds === 'string' ? req.query.linkedUserIds : undefined;
    const linkedUserIds = linkedRaw
      ? linkedRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    if (!taskId?.trim()) {
      throw new BadRequestError('taskId is required');
    }

    const result = await getTaskPayoutBundle({ taskId, performerUid, linkedUserIds });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to build payout bundle');
    }

    res.json({
      success: true,
      bundle: result.bundle,
    });
  }

  /**
   * POST /api/v1/payouts/status/batch
   * Body: { payoutIds: string[] }
   */
  static async getPayoutStatusBatch(req: Request, res: Response): Promise<void> {
    const payoutIds = Array.isArray(req.body?.payoutIds) ? req.body.payoutIds : [];

    const result = await getPayoutStatusBatch(
      payoutIds.map((id: unknown) => String(id)),
    );

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to fetch payout statuses');
    }

    res.json({
      success: true,
      payouts: result.payouts ?? [],
    });
  }
}


