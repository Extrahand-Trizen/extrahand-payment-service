import { Response, Request } from 'express';
import {
  createOrder,
  verifyPaymentSignature,
  getOrderDetails,
  getPaymentDetails,
  createRefund,
} from '../services/paymentService';
import { updateEscrowOnPaymentCapture } from '../services/escrowService';
import { cancelPayment, cancelEscrow, cancelEscrowByTaskId } from '../services/cancellationService';
import { BadRequestError, NotFoundError } from '../errors/AppError';
import logger from '../config/logger';
import { prisma } from '../config/prisma';

export class PaymentController {
  /**
   * POST /api/v1/payment/create-order
   */
  static async createOrder(req: Request, res: Response): Promise<void> {
    const { amount, currency, metadata } = req.body;
    const rawIdempotencyKey =
      (req.headers['idempotency-key'] as string | undefined) ||
      (req.headers['Idempotency-Key'] as string | undefined) ||
      (req.body && typeof req.body.idempotencyKey === 'string'
        ? (req.body.idempotencyKey as string)
        : undefined);
    const idempotencyKey = rawIdempotencyKey?.trim() || undefined;

    if (!amount || amount <= 0) {
      throw new BadRequestError('Invalid amount');
    }

    // If idempotency key is provided, check for existing order
    if (idempotencyKey) {
      const existing = await prisma.paymentOrderIdempotency.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        logger.info('ℹ️ Returning existing order for idempotency key', {
          idempotencyKey,
          razorpayOrderId: existing.razorpayOrderId,
        });
        return res.json({ order: existing.orderPayload });
      }
    }

    const result = await createOrder(amount, currency || 'INR', metadata || {});

    if (!result.success) {
      throw new Error(result.error || 'Failed to create order');
    }

    // Persist idempotency mapping if key provided
    if (idempotencyKey && result.order) {
      try {
        await prisma.paymentOrderIdempotency.create({
          data: {
            idempotencyKey,
            razorpayOrderId: result.order.id,
            orderPayload: result.order as any,
          },
        });
      } catch (error: any) {
        // Unique constraint violations or DB errors should not break the request
        logger.warn('Failed to persist payment order idempotency (non-critical):', error?.message);
      }
    }

    res.json({ order: result.order });
  }

  /**
   * POST /api/v1/payment/verify-payment
   */
  static async verifyPayment(req: Request, res: Response): Promise<void> {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new BadRequestError('Missing required parameters');
    }

    const result = verifyPaymentSignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );

    if (!result.success) {
      throw new BadRequestError(result.message || result.error || 'Payment verification failed');
    }

    // Update escrow with payment entity so razorpayPaymentData is stored (sanitized)
    try {
      const paymentResult = await getPaymentDetails(razorpay_payment_id);
      const paymentEntity = paymentResult.success ? paymentResult.payment : undefined;
      await updateEscrowOnPaymentCapture(
        razorpay_order_id,
        razorpay_payment_id,
        'captured',
        paymentEntity
      );
    } catch (escrowError: any) {
      // Log error but don't fail the payment verification
      logger.warn('Failed to update escrow on payment capture:', escrowError);
    }

    res.json({
      success: true,
      message: result.message,
    });
  }

  /**
   * GET /api/v1/payment/order-status/:orderId
   */
  static async getOrderStatus(req: Request, res: Response): Promise<void> {
    const { orderId } = req.params;

    const result = await getOrderDetails(orderId);

    if (!result.success) {
      // Return 404 for not found, 500 for other errors
      if (result.statusCode === 404) {
        throw new NotFoundError(result.error || 'Order not found');
      }
      throw new Error(result.error || 'Failed to get order details');
    }

    res.json({ order: result.order });
  }

  /**
   * POST /api/v1/payment/refund
   */
  static async createRefund(req: Request, res: Response): Promise<void> {
    const { paymentId, amount } = req.body;

    if (!paymentId) {
      throw new BadRequestError('Payment ID is required');
    }

    const result = await createRefund(paymentId, amount);

    if (!result.success) {
      throw new Error(result.error || 'Failed to create refund');
    }

    res.json({
      success: true,
      refund: result.refund,
    });
  }

  /**
   * POST /api/v1/payment/cancel
   */
  static async cancelPayment(req: Request, res: Response): Promise<void> {
    const { razorpayOrderId, escrowId, taskId, reason, userId, cancelledBy, taskStartDate } = req.body;

    let result;

    if (razorpayOrderId) {
      result = await cancelPayment({
        razorpayOrderId,
        reason,
        userId,
        cancelledBy,
        taskStartDate: taskStartDate ? new Date(taskStartDate) : undefined
      });
    } else if (escrowId) {
      result = await cancelEscrow({ escrowId, reason, userId });
    } else if (taskId) {
      result = await cancelEscrowByTaskId({ taskId, reason, userId });
    } else {
      throw new BadRequestError('Either razorpayOrderId, escrowId, or taskId is required');
    }

    if (!result.success) {
      throw new Error(result.error || 'Failed to cancel payment');
    }

    const response: any = {
      success: true,
      cancelled: result.cancelled,
      refundRequired: result.refundRequired,
    };

    // Include refund details if processed
    if ('refund' in result && result.refund) {
      response.refund = result.refund;
    }

    res.json(response);
  }
}

