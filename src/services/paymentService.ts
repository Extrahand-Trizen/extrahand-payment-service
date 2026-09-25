import Razorpay from 'razorpay';
import crypto from 'crypto';
import { RAZORPAY_CONFIG } from '../config/razorpay';
import {
  getPaymentClient,
  paymentKeys,
  paymentSecrets,
  resolvePaymentEnvironment,
  type PaymentEnvironment,
} from '../config/paymentEnvironment';
import { normalizePaymentEnvironment } from '../config/paymentEnvironment';
import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { isPostgresConnected } from '../config/database';
import { buildRazorpayOrderNotes } from '../utils/paymentSanitizer';
import {
  isReviewBypassPhone,
  isReviewBypassUid,
  REVIEW_ORDER_ID_PREFIX,
} from '../utils/reviewBypass';

/** Order payload returned to clients (includes publishable keyId for checkout). */
export type CreateOrderPayload = {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  attempts: number;
  created_at: number;
  reviewBypass?: boolean;
  keyId: string;
  paymentEnvironment: PaymentEnvironment;
  [key: string]: unknown;
};

export type CreateOrderResult =
  | { success: true; order: CreateOrderPayload }
  | { success: false; error: string; order?: undefined };

const isPaymentOrderEnvironmentTableMissing = (error: any): boolean => {
  if (!error) return false;
  const message = String(error.message || '');
  return (
    error.code === 'P2021' ||
    error.code === 'P2022' ||
    message.includes('PaymentOrderEnvironment') &&
      (message.includes('does not exist in the current database') ||
        message.includes('relation') ||
        message.includes('table'))
  );
};

const savePaymentOrderEnvironment = async (
  orderId: string,
  paymentEnvironment: PaymentEnvironment,
  userId?: string | null,
): Promise<void> => {
  try {
    await prisma.paymentOrderEnvironment.upsert({
      where: { razorpayOrderId: orderId },
      create: {
        razorpayOrderId: orderId,
        paymentEnvironment,
        userId: userId || null,
      },
      update: {
        paymentEnvironment,
        userId: userId || null,
      },
    });
  } catch (error: any) {
    if (isPaymentOrderEnvironmentTableMissing(error)) {
      logger.warn('PaymentOrderEnvironment table not available; skipping persistence', {
        orderId,
        paymentEnvironment,
      });
      return;
    }
    throw error;
  }
};

const findPaymentOrderEnvironment = async (
  orderId: string,
): Promise<{ paymentEnvironment?: string } | null> => {
  try {
    return await prisma.paymentOrderEnvironment.findUnique({
      where: { razorpayOrderId: orderId },
      select: { paymentEnvironment: true },
    });
  } catch (error: any) {
    if (isPaymentOrderEnvironmentTableMissing(error)) {
      logger.warn('PaymentOrderEnvironment table not available; skipping lookup', { orderId });
      return null;
    }
    throw error;
  }
};

export const createOrder = async (
  amount: number,
  currency: string = 'INR',
  metadata: Record<string, any> = {},
  authenticatedUid?: string | null,
): Promise<CreateOrderResult> => {
  try {
    const paymentEnvironment = await resolvePaymentEnvironment(authenticatedUid);
    const razorpay = getPaymentClient(paymentEnvironment);
    const keyId = paymentKeys[paymentEnvironment];
    logger.info('[PAYMENT DEBUG] Creating Razorpay order', {
      uidPresent: Boolean(authenticatedUid?.trim()),
      paymentEnvironment,
      keyPrefix: keyId.slice(0, 8),
      amountPaise: amount,
    });
    const paymentMetadata = {
      ...metadata,
      paymentEnvironment,
    };
    const posterUid =
      typeof metadata.posterUid === 'string' ? metadata.posterUid.trim() : '';
    const posterPhoneRaw = metadata.posterPhone;
    const posterPhone =
      typeof posterPhoneRaw === 'string' ? posterPhoneRaw.trim() : '';
    if (
      paymentEnvironment !== 'test' &&
      posterUid &&
      (isReviewBypassUid(posterUid) || isReviewBypassPhone(posterPhone))
    ) {
      const id = `${REVIEW_ORDER_ID_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
      logger.info('Review bypass: skipped Razorpay order create', {
        orderId: id,
        posterUid,
        amountPaise: amount,
      });
      const order: CreateOrderPayload = {
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
        keyId,
        paymentEnvironment,
      };
      return { success: true, order };
    }

    if (amount <= 0) {
      const id = `order_free_${crypto.randomBytes(12).toString('hex')}`;
      logger.info('Free / 100% coupon order: skipped Razorpay order create', {
        orderId: id,
        posterUid,
        amountPaise: amount,
      });
      const order: CreateOrderPayload = {
        id,
        entity: 'order',
        amount: 0,
        amount_paid: 0,
        amount_due: 0,
        currency: currency || 'INR',
        receipt: `rcpt_free_${Date.now()}`,
        status: 'paid',
        attempts: 0,
        created_at: Math.floor(Date.now() / 1000),
        isFreeOrder: true,
        keyId,
        paymentEnvironment,
      };
      return { success: true, order };
    }

    const options = {
      amount: amount, // Convert to paise
      currency,
      receipt: `receipt_${Date.now()}`,
      notes: buildRazorpayOrderNotes(paymentMetadata),
    };

    const order = await razorpay.orders.create(options);
    logger.info('Order created successfully', {
      orderId: order.id,
      amount,
      paymentEnvironment,
      keyPrefix: keyId.slice(0, 8),
    });
    // Plain JSON + keyId: Razorpay SDK objects can lose custom fields across axios hops
    // (task-service Book Now path). Checkout must use this same publishable key.
    const plainOrder =
      order && typeof order === 'object'
        ? (JSON.parse(JSON.stringify(order)) as Record<string, unknown>)
        : {};
    const orderId =
      typeof plainOrder.id === 'string' ? plainOrder.id : String(order.id);
    const payload = {
      ...plainOrder,
      id: orderId,
      keyId,
      paymentEnvironment,
    } as CreateOrderPayload;
    await savePaymentOrderEnvironment(orderId, paymentEnvironment, authenticatedUid);
    return {
      success: true,
      order: payload,
    };
  } catch (error: any) {
    logger.error('Error creating order:', error);
    return { success: false, error: error.message };
  }
};

export const verifyPaymentSignature = (
  orderId: string,
  paymentId: string,
  signature: string,
  paymentEnvironment: PaymentEnvironment = 'live',
) => {
  try {
    const generatedSignature = crypto
      .createHmac(
        'sha256',
        paymentSecrets[paymentEnvironment],
      )
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const isValid = generatedSignature === signature;

    logger.info('Payment signature verification', {
      paymentEnvironment,
      isValid,
      orderIdSuffix: orderId.slice(-8),
      paymentIdPresent: Boolean(paymentId),
      signaturePresent: Boolean(signature),
    });
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
export const getPaymentDetails = async (paymentId: string, paymentEnvironment: PaymentEnvironment = 'live'): Promise<{ success: true; payment: any } | { success: false; error: string }> => {
  try {
    const razorpay = getPaymentClient(paymentEnvironment);
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

export const getOrderDetails = async (orderId: string, paymentEnvironment: PaymentEnvironment = 'live') => {
  try {
    const razorpay = getPaymentClient(paymentEnvironment);
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
      order: { ...plainOrder, keyId: paymentKeys[paymentEnvironment], paymentEnvironment },
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
export const createRefund = async (paymentId: string, amountInRupees?: number, paymentEnvironment: PaymentEnvironment = 'live') => {
  try {
    const razorpay = getPaymentClient(paymentEnvironment);
    const options: { amount?: number } = {};
    if (amountInRupees != null && amountInRupees > 0) {
      options.amount = Math.round(Number(amountInRupees) * 100);
    }
    const refund = await razorpay.payments.refund(paymentId, options);
    logger.info('Refund created', { refundId: refund.id, paymentId, amountPaise: options.amount });
    return { success: true, refund };
  } catch (error: any) {
    logger.error('Error creating refund:', error);
    return { success: false, error: getRefundErrorMessage(error) };
  }
};

function getRefundErrorMessage(error: any): string {
  const razorpayError = error?.error || error?.response?.data?.error || error?.response?.data;
  const message = [
    razorpayError?.description,
    razorpayError?.message,
    error?.message,
  ].find((value): value is string => typeof value === 'string' && Boolean(value.trim()));

  if (message && /insufficient\s+(?:funds|balance)|not enough\s+funds/i.test(message)) {
    return 'Insufficient balance in Razorpay account';
  }

  return message || 'Failed to create Razorpay refund';
}

/** Resolve an existing payment's environment from its persisted escrow snapshot. */
export const resolvePaymentEnvironmentForPayment = async (
  paymentId?: string,
  orderId?: string,
): Promise<PaymentEnvironment> => {
  const escrow = orderId
    ? await prisma.escrow.findFirst({
        where: {
          OR: [{ razorpayOrderId: orderId }, { bookingOrderId: orderId }],
        },
        select: { metadata: true },
      })
    : paymentId
      ? await prisma.escrow.findFirst({
          where: { razorpayPaymentId: paymentId },
          select: { metadata: true },
        })
      : null;
  if (escrow?.metadata) {
    return normalizePaymentEnvironment((escrow.metadata as any)?.paymentEnvironment);
  }
  if (orderId || paymentId) {
    const order = orderId
      ? await findPaymentOrderEnvironment(orderId)
      : await prisma.transaction.findFirst({
          where: { razorpayPaymentId: paymentId },
          select: { razorpayOrderId: true },
        }).then((tx) => tx ? findPaymentOrderEnvironment(tx.razorpayOrderId) : null);
    if (order?.paymentEnvironment) return normalizePaymentEnvironment(order.paymentEnvironment);
  }
  return 'live';
};

export const createRefundAmountPaise = async (
  paymentId: string,
  amountInPaise: number,
  paymentEnvironment: PaymentEnvironment = 'live',
) => {
  try {
    const razorpay = getPaymentClient(paymentEnvironment);
    const paise = Math.round(amountInPaise);
    if (!Number.isFinite(paise) || paise <= 0) {
      return { success: false as const, error: 'Invalid refund amount (paise)' };
    }
    const refund = await razorpay.payments.refund(paymentId, { amount: paise });
    logger.info('Refund created (paise)', { refundId: refund.id, paymentId, amountPaise: paise });
    return { success: true as const, refund };
  } catch (error: any) {
    logger.error('Error creating refund:', error);
    return { success: false as const, error: getRefundErrorMessage(error) };
  }
};
