import { Response, Request } from 'express';
import { processRefund, getRefundStatus, getRefundsByEscrowId } from '../services/refundService';
import { BadRequestError, NotFoundError } from '../errors/AppError';

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
   * GET /api/v1/refunds/status/:refundId
   * Get refund status
   */
  static async getRefundStatus(req: Request, res: Response): Promise<void> {
    const { refundId } = req.params;

    if (!refundId) {
      throw new BadRequestError('refundId is required');
    }

    const result = await getRefundStatus(refundId);

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


