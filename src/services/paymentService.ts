import Razorpay from 'razorpay';
import crypto from 'crypto';
import { razorpay, RAZORPAY_CONFIG } from '../config/razorpay';
import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { isPostgresConnected } from '../config/database';
import { buildRazorpayOrderNotes } from '../utils/paymentSanitizer';
import {
  isReviewBypassPhone,
  isReviewBypassUid,
  REVIEW_ORDER_ID_PREFIX,
} from '../utils/reviewBypass';

export const createOrder = async (amount: number, currency: string = 'INR', metadata: Record<string, any> = {}) => {
  try {
    const posterUid =
      typeof metadata.posterUid === 'string' ? metadata.posterUid.trim() : '';
    const posterPhoneRaw = metadata.posterPhone;
    const posterPhone =
      typeof posterPhoneRaw === 'string' ? posterPhoneRaw.trim() : '';
    if (
      posterUid &&
      (isReviewBypassUid(posterUid) || isReviewBypassPhone(posterPhone))
    ) {
      const id = `${REVIEW_ORDER_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
      logger.info('Review bypass: skipped Razorpay order create', {
        orderId: id,
        posterUid,
        amountPaise: amount,
      });
      const order = {
        id,
        entity: 'order',
        amount,
        amount_paid: 0,
        amount_due: amount,
        currency: currency || 'INR',
        receipt: `rcpt_review_${Date.now()}`,
        status: 'created',
        attempts: 0,
        created_at: Math.floor(Date.now() / 1000),
        reviewBypass: true,
        // Publishable key for the account that "owns" this order (checkout must match).
        keyId: RAZORPAY_CONFIG.keyId,
      };
      return { success: true, order };
    }

    const options = {
      amount: amount, // Convert to paise
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: buildRazorpayOrderNotes(metadata),
    };

    const order = await razorpay.orders.create(options);
    logger.info('Order created successfully', { orderId: order.id, amount });
    // Plain JSON + keyId: Razorpay SDK objects can lose custom fields across axios hops
    // (task-service Book Now path). Checkout must use this same publishable key.
    const plainOrder =
      order && typeof order === 'object'
        ? (JSON.parse(JSON.stringify(order)) as Record<string, unknown>)
        : {};
    return {
      success: true,
      order: { ...plainOrder, keyId: RAZORPAY_CONFIG.keyId },
    };
  } catch (error: any) {
    logger.error('Error creating order:', error);
    return { success: false, error: error.message };
  }
};

export const verifyPaymentSignature = (orderId: string, paymentId: string, signature: string) => {
  try {
    const generatedSignature = crypto
      .createHmac('sha256', RAZORPAY_CONFIG.keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const isValid = generatedSignature === signature;

    logger.info('Payment signature verification', { orderId, isValid });
    return {
      success: isValid,
      message: isValid ? 'Payment verified successfully' : 'Invalid signature',
    };
  } catch (error: any) {
    logger.error('Error verifying payment:', error);
    return { success: false, error: error.message };
  }
};
    
/**
 * Fetch payment by ID from Razorpay (GET /v1/payments/:id).
 * Used after verify-payment to store razorpayPaymentData on escrow.
 */
export const getPaymentDetails = async (paymentId: string): Promise<{ success: true; payment: any } | { success: false; error: string }> => {
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return { success: true, payment };
  } catch (error: any) {
    logger.error('Error fetching payment:', { paymentId, error: error.message });
    const isNotFound =
      error.statusCode === 404 ||
      error.status === 404 ||
      error.message?.toLowerCase().includes('not found') ||
      error.message?.toLowerCase().includes('does not exist');
    if (isNotFound) {
      return { success: false, error: 'Payment not found' };
    }
    return { success: false, error: error.message || 'Failed to fetch payment' };
  }
};

export const getOrderDetails = async (orderId: string) => {
  try {
    // Handle test/mock order IDs - return mock data instead of querying Razorpay
    if (orderId.startsWith('order_test_') || orderId.startsWith('mock_')) {
      logger.info('Test order ID detected, returning mock data', { orderId });
      return {
        success: true,
        order: {
          id: orderId,
          entity: 'order',
          amount: 100000, // ₹1000 in paise
          amount_paid: 0,
          amount_due: 100000,
          currency: 'INR',
          receipt: `receipt_${Date.now()}`,
          status: 'created',
          attempts: 0,
          created_at: Math.floor(Date.now() / 1000),
        },
      };
    }

    if (orderId.startsWith(REVIEW_ORDER_ID_PREFIX)) {
      if (isPostgresConnected()) {
        const escrowRow = await prisma.escrow.findUnique({
          where: { razorpayOrderId: orderId },
        });
        if (escrowRow) {
          const amountPaise = Number(escrowRow.amount);
          logger.info('Review bypass order resolved from escrow', { orderId });
          return {
            success: true,
            order: {
              id: orderId,
              entity: 'order',
              amount: amountPaise,
              amount_paid: 0,
              amount_due: amountPaise,
              currency: escrowRow.currency || 'INR',
              receipt: `rcpt_review_escrow`,
              status: 'created',
              attempts: 0,
              created_at: Math.floor(Date.now() / 1000),
              reviewBypass: true,
            },
          };
        }
      }
      logger.warn('Review order id but escrow not found', { orderId });
      return {
        success: false,
        error: 'Order not found',
        statusCode: 404,
        errorCode: 'PAYMENT_ORDER_NOT_FOUND',
      };
    }

    const order = await razorpay.orders.fetch(orderId);
    const plainOrder =
      order && typeof order === 'object'
        ? (JSON.parse(JSON.stringify(order)) as Record<string, unknown>)
        : {};
    return {
      success: true,
      order: { ...plainOrder, keyId: RAZORPAY_CONFIG.keyId },
    };
  } catch (error: any) {
    logger.error('Error fetching order:', error);
    
    // Check if it's a "not found" error from Razorpay
    // Razorpay SDK typically throws errors with statusCode or status property
    const isNotFound = 
      error.statusCode === 404 || 
      error.status === 404 ||
      error.message?.toLowerCase().includes('not found') ||
      error.message?.toLowerCase().includes('does not exist') ||
      (error.error?.code === 'BAD_REQUEST_ERROR' && error.error?.description?.toLowerCase().includes('not found'));
    
    if (isNotFound) {
      return { 
        success: false, 
        error: 'Order not found',
        statusCode: 404,
        errorCode: 'PAYMENT_ORDER_NOT_FOUND',
      };
    }
    
    return {
      success: false,
      error: error.message || 'Failed to fetch order details',
      errorCode: 'PAYMENT_ORDER_STATUS_FETCH_FAILED',
    };
  }
};

/**
 * Razorpay Payments API refund (money returns to the customer's original payment method).
 * `amountInRupees` is optional: omit for a full refund of the remaining capturable amount.
 * Amount sent to Razorpay is always in paise (integer).
 */
export const createRefund = async (paymentId: string, amountInRupees?: number) => {
  try {
    const options: { amount?: number } = {};
    if (amountInRupees != null && amountInRupees > 0) {
      options.amount = Math.round(Number(amountInRupees) * 100);
    }
    const refund = await razorpay.payments.refund(paymentId, options);
    logger.info('Refund created', { refundId: refund.id, paymentId, amountPaise: options.amount });
    return { success: true, refund };
  } catch (error: any) {
    logger.error('Error creating refund:', error);
    return { success: false, error: error.message };
  }
};

/** Internal: refund an exact amount in paise (partial or full capture). */
export const createRefundAmountPaise = async (paymentId: string, amountInPaise: number) => {
  try {
    const paise = Math.round(amountInPaise);
    if (!Number.isFinite(paise) || paise <= 0) {
      return { success: false as const, error: 'Invalid refund amount (paise)' };
    }
    const refund = await razorpay.payments.refund(paymentId, { amount: paise });
    logger.info('Refund created (paise)', { refundId: refund.id, paymentId, amountPaise: paise });
    return { success: true as const, refund };
  } catch (error: any) {
    logger.error('Error creating refund:', error);
    return { success: false as const, error: error.message };
  }
};

