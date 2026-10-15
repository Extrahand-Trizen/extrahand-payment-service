import { Response, Request } from 'express';
import { processRefund, getRefundStatus, getRefundsByEscrowId } from '../services/refundService';
import { resolveEscrowForCancellation } from '../services/cancellationService';
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors/AppError';
import { callerRoleForEscrow, requireCallerIdentity, resolvePaymentCaller } from '../utils/paymentCaller';

export class RefundController {
  /**
   * POST /api/v1/refunds/process
   * Process a refund (with cancellation fee calculation)
   */
  static async processRefund(req: Request, res: Response): Promise<void> {
    const {
      razorpayOrderId,
      razorpayPaymentId,
      taskId,
      reason,
      cancelledBy,
      taskStartDate,
      cancelledAt,
      userId,
      amount,
      assignedAt,
      feeBaseAmount,
    } = req.body;

    const caller = resolvePaymentCaller(req);
    if (caller.kind === 'user') {
      await RefundController.processUserRefund(req, res, requireCallerIdentity(caller));
      return;
    }

    // Validate required fields — allow taskId alone as fallback
    if (!razorpayOrderId && !taskId) {
      throw new BadRequestError('razorpayOrderId or taskId is required');
    }

    if (!cancelledBy || !['poster', 'performer'].includes(cancelledBy)) {
      throw new BadRequestError('cancelledBy must be either "poster" or "performer"');
    }

    if (!taskStartDate || !cancelledAt) {
      throw new BadRequestError('taskStartDate and cancelledAt are required');
    }

    // Parse dates
    const taskStart = new Date(taskStartDate);
    const cancelled = new Date(cancelledAt);

    if (isNaN(taskStart.getTime()) || isNaN(cancelled.getTime())) {
      throw new BadRequestError('Invalid date format for taskStartDate or cancelledAt');
    }

    const feeBaseParsed =
      feeBaseAmount != null && feeBaseAmount !== '' ? Number(feeBaseAmount) : NaN;

    const result = await processRefund({
      razorpayOrderId: razorpayOrderId || '',
      razorpayPaymentId: razorpayPaymentId || '',
      taskId,
      reason,
      cancelledBy,
      taskStartDate: taskStart,
      cancelledAt: cancelled,
      userId,
      amount,
      assignedAt: assignedAt ? new Date(assignedAt) : undefined,
      feeBaseAmount: Number.isFinite(feeBaseParsed) ? feeBaseParsed : undefined,
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to process refund');
    }

    res.json({
      success: true,
      refund: result.refund,
    });
  }

  /**
   * POST /api/v1/refunds/process relayed for an app user: the payment must be the caller's, the
   * caller's role comes from the escrow record, and the amount and fee inputs are server-decided.
   */
  private static async processUserRefund(req: Request, res: Response, callerUids: string[]): Promise<void> {
    const { razorpayOrderId, razorpayPaymentId, taskId, reason, taskStartDate, amount } = req.body;

    if (amount != null && amount !== '') {
      throw new BadRequestError('The refund amount is set by the cancellation policy; do not send amount');
    }
    if (!razorpayOrderId && !taskId) {
      throw new BadRequestError('razorpayOrderId or taskId is required');
    }
    const taskStart = new Date(taskStartDate);
    if (!taskStartDate || isNaN(taskStart.getTime())) {
      throw new BadRequestError('A valid taskStartDate is required');
    }

    const resolved = await resolveEscrowForCancellation({ razorpayOrderId, taskId });
    if ('error' in resolved) {
      if (resolved.notFound) throw new NotFoundError(resolved.error);
      if (/postgres/i.test(resolved.error)) throw new Error(resolved.error);
      throw new BadRequestError(resolved.error);
    }
    const escrow = resolved.escrow;
    const role = callerRoleForEscrow(escrow, callerUids);
    if (!role) {
      throw new ForbiddenError('You can only refund your own payments');
    }
    const escrowPaymentId = String(escrow.razorpayPaymentId || '').trim();
    const requestedPaymentId = String(razorpayPaymentId || '').trim();
    if (requestedPaymentId && escrowPaymentId && requestedPaymentId !== escrowPaymentId) {
      throw new BadRequestError('Payment does not belong to this booking');
    }

    const result = await processRefund({
      razorpayOrderId: escrow.razorpayOrderId,
      razorpayPaymentId: escrowPaymentId,
      reason,
      cancelledBy: role,
      taskStartDate: taskStart,
      cancelledAt: new Date(),
      userId: callerUids[0],
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to process refund');
    }

    res.json({
      success: true,
      refund: result.refund,
    });
  }

  /**
   * GET /api/v1/refunds/status/:refundId
   * Get refund status
   */
  static async getRefundStatus(req: Request, res: Response): Promise<void> {
    const { refundId } = req.params;

    if (!refundId) {
      throw new BadRequestError('refundId is required');
    }

    const syncRazorpay = String(req.query.syncRazorpay || '').toLowerCase() === 'true';
    const result = await getRefundStatus(refundId, { syncRazorpay });

    if (!result.success) {
      throw new NotFoundError(result.error || 'Refund not found');
    }

    res.json({
      success: true,
      refund: result.refund,
    });
  }

  /**
   * GET /api/v1/refunds/escrow/:escrowId
   * Get all refunds for an escrow
   */
  static async getRefundsByEscrowId(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;

    if (!escrowId) {
      throw new BadRequestError('escrowId is required');
    }

    const result = await getRefundsByEscrowId(escrowId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Refunds not found');
    }

    res.json({
      success: true,
      refunds: result.refunds,
    });
  }
}


