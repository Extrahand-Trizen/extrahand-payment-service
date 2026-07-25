import { Response, Request } from 'express';
import {
  createOrder,
  verifyPaymentSignature,
  getOrderDetails,
  getPaymentDetails,
  createRefund,
} from '../services/paymentService';
import { updateEscrowOnPaymentCapture } from '../services/escrowService';
import {
  cancelPayment as cancelPaymentOrder,
  cancelEscrow,
  cancelEscrowByTaskId,
  cancelEscrowByBookingOrderId,
} from '../services/cancellationService';
import { BadRequestError, NotFoundError } from '../errors/AppError';
import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { RAZORPAY_CONFIG } from '../config/razorpay';
import { isReviewBypassOrderId } from '../utils/reviewBypass';
import { processBookNowLineItemRefund } from '../services/refundService';

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
        res.json({ order: existing.orderPayload });
        return;
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
    const uid = (req.headers['x-user-id'] as string | undefined)?.trim();

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new BadRequestError('Missing required parameters');
    }

    if (isReviewBypassOrderId(razorpay_order_id)) {
      if (!uid) {
        throw new BadRequestError('Missing user context');
      }
      const escrowRow = await prisma.escrow.findUnique({
        where: { razorpayOrderId: razorpay_order_id },
      });
      if (!escrowRow) {
        throw new BadRequestError('Escrow not found');
      }
      if (escrowRow.posterUid !== uid) {
        throw new BadRequestError('Forbidden');
      }
      const meta = escrowRow.metadata as Record<string, unknown> | null;
      if (!meta || meta.reviewBypass !== true) {
        throw new BadRequestError('Invalid review payment order');
      }
      const paymentEntity = {
        id: razorpay_payment_id,
        entity: 'payment',
        reviewBypass: true,
      };
      await updateEscrowOnPaymentCapture(
        razorpay_order_id,
        razorpay_payment_id,
        'captured',
        paymentEntity
      );
      res.json({
        success: true,
        message: 'Payment verified (review bypass)',
      });
      return;
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
    const paymentResult = await getPaymentDetails(razorpay_payment_id);
    const paymentEntity = paymentResult.success ? paymentResult.payment : undefined;
    const captureResult = await updateEscrowOnPaymentCapture(
      razorpay_order_id,
      razorpay_payment_id,
      'captured',
      paymentEntity,
    );

    if (!captureResult.success) {
      logger.error('Escrow update failed after payment verification', {
        razorpay_order_id,
        razorpay_payment_id,
        error: captureResult.error,
      });
      throw new BadRequestError(
        captureResult.error ||
          'Payment was received but escrow could not be saved. Please contact support with your payment ID.',
      );
    }

    res.json({
      success: true,
      message: result.message,
      escrowId: captureResult.escrow?.escrowId,
    });
  }

  /**
   * GET /api/v1/payment/order-status/:orderId
   */
  static async getOrderStatus(req: Request, res: Response): Promise<void> {
    const { orderId } = req.params;

    const result = await getOrderDetails(orderId);

    if (!result.success) {
      if (result.statusCode === 404) {
        res.status(404).json({
          success: false,
          error: result.error || 'Order not found',
          code: (result as any).errorCode || 'PAYMENT_ORDER_NOT_FOUND',
        });
        return;
      }
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to get order details',
        code: (result as any).errorCode || 'PAYMENT_ORDER_STATUS_FETCH_FAILED',
      });
      return;
    }

    const order = result.order as any;
    const statusRaw = String(order?.status || '').toLowerCase();
    const amountPaid = Number(order?.amount_paid || 0);
    const statusHint =
      statusRaw === 'paid'
        ? 'PAYMENT_CAPTURED'
        : statusRaw === 'attempted' && amountPaid <= 0
          ? 'PAYMENT_ATTEMPTED_NOT_CAPTURED'
          : statusRaw === 'created'
            ? 'PAYMENT_PENDING'
            : 'PAYMENT_STATUS_UNKNOWN';

    res.json({
      order,
      statusHint,
    });
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
    const {
      razorpayOrderId,
      escrowId,
      taskId,
      bookingOrderId,
      reason,
      userId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      taskTitle,
      catalogId,
      partnerReachedLocation,
    } = req.body;

    logger.info('[PaymentController.cancelPayment] Request received', {
      razorpayOrderId,
      escrowId,
      taskId,
      bookingOrderId,
      cancelledBy,
      taskStartDate,
      assignedAt,
      feeBaseAmount,
      hasReason: Boolean(reason),
      userId,
    });

    const taskStart = taskStartDate ? new Date(taskStartDate) : undefined;
    const assignedAtDate = assignedAt ? new Date(assignedAt) : undefined;
    const feeBaseParsed =
      feeBaseAmount != null && feeBaseAmount !== '' ? Number(feeBaseAmount) : NaN;
    const feeBaseToPass = Number.isFinite(feeBaseParsed) ? feeBaseParsed : undefined;

    let result;

    if (razorpayOrderId) {
      result = await cancelPaymentOrder({
        razorpayOrderId,
        reason,
        userId,
        cancelledBy,
        taskStartDate: taskStart,
        assignedAt: assignedAtDate,
        feeBaseAmount: feeBaseToPass,
        taskTitle: typeof taskTitle === 'string' ? taskTitle : undefined,
        catalogId: typeof catalogId === 'string' ? catalogId : undefined,
        partnerReachedLocation: Boolean(partnerReachedLocation),
      });
    } else if (bookingOrderId) {
      // Book Now: escrow.taskId is often `booknow-pending-{orderId}`; prefer booking order.
      result = await cancelEscrowByBookingOrderId({
        bookingOrderId: String(bookingOrderId),
        reason,
        userId,
        cancelledBy,
        taskStartDate: taskStart,
        assignedAt: assignedAtDate,
        feeBaseAmount: feeBaseToPass,
        taskTitle: typeof taskTitle === 'string' ? taskTitle : undefined,
        catalogId: typeof catalogId === 'string' ? catalogId : undefined,
        partnerReachedLocation: Boolean(partnerReachedLocation),
      });
    } else if (escrowId) {
      result = await cancelEscrow({
        escrowId,
        reason,
        userId,
        cancelledBy,
        taskStartDate: taskStart,
        assignedAt: assignedAtDate,
        feeBaseAmount: feeBaseToPass,
        taskTitle: typeof taskTitle === 'string' ? taskTitle : undefined,
        catalogId: typeof catalogId === 'string' ? catalogId : undefined,
        partnerReachedLocation: Boolean(partnerReachedLocation),
      });
    } else if (taskId) {
      result = await cancelEscrowByTaskId({
        taskId,
        reason,
        userId,
        cancelledBy,
        taskStartDate: taskStart,
        assignedAt: assignedAtDate,
        feeBaseAmount: feeBaseToPass,
        taskTitle: typeof taskTitle === 'string' ? taskTitle : undefined,
        catalogId: typeof catalogId === 'string' ? catalogId : undefined,
        partnerReachedLocation: Boolean(partnerReachedLocation),
      });
    } else {
      throw new BadRequestError(
        'Either razorpayOrderId, escrowId, bookingOrderId, or taskId is required',
      );
    }

    if (!result.success) {
      logger.error('[PaymentController.cancelPayment] Cancel/refund failed', {
        razorpayOrderId,
        escrowId,
        taskId,
        bookingOrderId,
        cancelledBy,
        error: result.error,
      });
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

    logger.info('[PaymentController.cancelPayment] Cancel/refund completed', {
      razorpayOrderId,
      escrowId,
      taskId,
      cancelledBy,
      cancelled: result.cancelled,
      refundRequired: result.refundRequired,
      refund: 'refund' in result ? result.refund : undefined,
    });

    res.json(response);
  }

  /**
   * POST /api/v1/payment/book-now/cancel-line-item
   * Partial refund for one service in a multi-item Book Now checkout.
   */
  static async cancelBookNowLineItem(req: Request, res: Response): Promise<void> {
    const {
      bookingOrderId,
      taskId,
      lineAmountRupees,
      taskStartDate,
      assignedAt,
      reason,
      userId,
      taskTitle,
      isLastActiveItem,
      catalogId,
      partnerReachedLocation,
    } = req.body;

    if (!bookingOrderId || !taskId || lineAmountRupees == null || !taskStartDate) {
      throw new BadRequestError(
        'bookingOrderId, taskId, lineAmountRupees, and taskStartDate are required',
      );
    }

    const amount = Number(lineAmountRupees);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestError('lineAmountRupees must be a positive number');
    }

    const result = await processBookNowLineItemRefund({
      bookingOrderId: String(bookingOrderId),
      taskId: String(taskId),
      lineAmountRupees: amount,
      taskStartDate: new Date(taskStartDate),
      assignedAt: assignedAt ? new Date(assignedAt) : null,
      reason: typeof reason === 'string' ? reason : undefined,
      userId: typeof userId === 'string' ? userId : undefined,
      taskTitle: typeof taskTitle === 'string' ? taskTitle : undefined,
      isLastActiveItem: Boolean(isLastActiveItem),
      catalogId: typeof catalogId === 'string' ? catalogId : undefined,
      partnerReachedLocation: Boolean(partnerReachedLocation),
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Partial refund failed');
    }

    res.json({ success: true, refund: result.refund });
  }

  /**
   * GET /api/v1/payment/razorpay-key
   * Public: publishable Key ID for client checkout only (never expose key secret).
   */
  static async getRazorpayKeyId(_req: Request, res: Response): Promise<void> {
    res.json({ keyId: RAZORPAY_CONFIG.keyId });
  }
}

