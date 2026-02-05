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
      reason,
      cancelledBy,
      taskStartDate,
      cancelledAt,
      userId,
      amount, // Optional: for partial refunds
    } = req.body;

    // Validate required fields
    if (!razorpayOrderId || !razorpayPaymentId) {
      throw new BadRequestError('razorpayOrderId and razorpayPaymentId are required');
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

    const result = await processRefund({
      razorpayOrderId,
      razorpayPaymentId,
      reason,
      cancelledBy,
      taskStartDate: taskStart,
      cancelledAt: cancelled,
      userId,
      amount,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to process refund');
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


