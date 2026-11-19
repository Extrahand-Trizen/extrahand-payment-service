/**
 * Razorpay Webhook Handlers
 * 
 * Handles webhook events from Razorpay for payment status updates
 */

import express from 'express';
import crypto from 'crypto';
import logger from '../config/logger';
import { RAZORPAY_CONFIG } from '../config/razorpay';
import { updateEscrowOnPaymentCapture } from '../services/escrowService';
import { handlePaymentFailure } from '../services/paymentFailureService';
import { completeRefundFromRazorpayWebhook } from '../services/refundService';
import {
  claimWebhookEvent,
  markWebhookProcessed,
} from '../services/auditLogService';
import { getWebhookSecret, type PaymentEnvironment } from '../config/paymentEnvironment';
import { runWithPaymentEnvironment } from '../config/prisma';
import { syncRefundSettlementsForDate } from '../services/refundSettlementService';

const router = express.Router();

/**
 * Verify Razorpay webhook signature
 */
function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

    return expectedSignature === signature;
  } catch (error) {
    logger.error('Error verifying webhook signature:', error);
    return false;
  }
}

function resolveWebhookEnvironment(payload: string, signature: string): PaymentEnvironment | null {
  const candidates: Array<[PaymentEnvironment, string]> = [
    ['live', getWebhookSecret('live')],
    ['test', getWebhookSecret('test')],
  ];
  for (const [environment, secret] of candidates) {
    if (secret && verifyWebhookSignature(payload, signature, secret)) return environment;
  }
  return null;
}

function bindWebhookDatabase(
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction,
): void {
  const signature = req.headers['x-razorpay-signature'] as string;
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const environment = resolveWebhookEnvironment(rawBody, signature);
  if (!environment) {
    next();
    return;
  }

  void runWithPaymentEnvironment(environment, undefined, () => next(), true).catch(next);
}

/**
 * POST /api/v1/webhooks/razorpay
 * Handle Razorpay webhook events
 * 
 * Note: Webhooks need raw body for signature verification
 */
router.post(
  '/razorpay',
  express.raw({ type: 'application/json' }),
  bindWebhookDatabase,
  async (req, res) => {
  let auditLogId: string | null = null;
  try {
    const signature = req.headers['x-razorpay-signature'] as string;

    if (!signature) {
      logger.warn('⚠️ Webhook received without signature');
      return res.status(400).json({ error: 'Missing signature' });
    }

    const rawBody = req.body.toString('utf8');
    const webhookEnvironment = resolveWebhookEnvironment(rawBody, signature);
    if (!webhookEnvironment) {
      logger.warn('⚠️ WEBHOOK_SECRET not configured - webhook verification disabled');
      return res.status(400).json({ error: 'Invalid signature or webhook secret' });
    }

    // Parse JSON body
    const event = JSON.parse(rawBody);
    const eventId = typeof event.id === 'string' ? event.id : '';
    const eventType = typeof event.event === 'string' ? event.event : '';
    if (!eventId || !eventType) {
      return res.status(400).json({ error: 'Invalid webhook event' });
    }

    const claim = await claimWebhookEvent({
      eventId,
      eventType,
      source: 'razorpay',
      payload: event,
    });
    auditLogId = claim.id;

    if (claim.state === 'processed') {
      logger.info('Razorpay webhook already processed', { eventId, event: eventType });
      return res.status(200).json({ received: true, message: 'Already processed' });
    }
    if (claim.state === 'in_progress') {
      return res.status(503).json({ received: false, retryable: true });
    }

    logger.info('📥 Razorpay webhook received', {
      event: event.event,
      paymentEnvironment: webhookEnvironment,
      entity: event.entity,
      payloadId: event.payload?.payment?.entity?.id,
    });

    // Handle different webhook events
    switch (eventType) {
      case 'payment.authorized':
        await handlePaymentAuthorized(event.payload);
        break;

      case 'payment.captured':
        await handlePaymentCaptured(event.payload);
        break;

      case 'payment.failed':
        await handlePaymentFailed(event.payload);
        break;

      case 'order.paid':
        // Order is fully paid (all payments captured)
        await handleOrderPaid(event.payload);
        break;

      case 'payment.refunded':
        await handlePaymentRefunded(event.payload, event.created_at);
        break;

      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed':
        await handlePaymentRefunded(event.payload, event.created_at);
        break;

      case 'settlement.processed':
        await handleSettlementProcessed(event.payload, webhookEnvironment);
        break;

      default:
        logger.info(`ℹ️ Unhandled webhook event: ${event.event}`);
    }

    // Mark webhook as processed
    if (auditLogId) {
      await markWebhookProcessed(auditLogId, true);
    }

    res.status(200).json({ received: true });
  } catch (error: any) {
    logger.error('❌ Error processing webhook:', error);
    if (auditLogId) {
      try {
        await markWebhookProcessed(auditLogId, false, error?.message ?? 'Unknown error');
      } catch (auditError) {
        logger.error('Failed to release webhook processing claim:', auditError);
      }
    }
    res.status(503).json({ received: false, retryable: true });
  }
});

/**
 * Handle payment.authorized event
 */
async function handlePaymentAuthorized(payload: any): Promise<void> {
  try {
    const payment = payload.payment?.entity;
    const order = payload.order?.entity;

    if (!payment || !order) {
      throw new Error('Invalid payment.authorized payload');
    }

    logger.info('✅ Payment authorized', {
      orderId: order.id,
      paymentId: payment.id,
    });

    // Update escrow with payment entity (sanitized) for audit
    await updateEscrowOnPaymentCapture(
      order.id,
      payment.id,
      'authorized',
      payment
    );
  } catch (error: any) {
    logger.error('❌ Error handling payment.authorized:', error);
    throw error;
  }
}

/**
 * Handle payment.captured event
 */
async function handlePaymentCaptured(payload: any): Promise<void> {
  try {
    const payment = payload.payment?.entity;
    const order = payload.order?.entity;

    if (!payment || !order) {
      throw new Error('Invalid payment.captured payload');
    }

    logger.info('✅ Payment captured', {
      orderId: order.id,
      paymentId: payment.id,
      amount: payment.amount,
    });

    // Update escrow with payment entity so razorpayPaymentData is stored (sanitized)
    await updateEscrowOnPaymentCapture(
      order.id,
      payment.id,
      'captured',
      payment
    );
  } catch (error: any) {
    logger.error('❌ Error handling payment.captured:', error);
    throw error;
  }
}

/**
 * Handle payment.failed event
 */
async function handlePaymentFailed(payload: any): Promise<void> {
  try {
    const payment = payload.payment?.entity;
    const order = payload.order?.entity;

    if (!payment || !order) {
      throw new Error('Invalid payment.failed payload');
    }

    const errorDescription = payment.error_description || payment.error_code || 'Payment failed';
    const errorCode = payment.error_code || 'PAYMENT_FAILED';

    logger.warn('❌ Payment failed', {
      orderId: order.id,
      paymentId: payment.id,
      errorDescription,
      errorCode,
    });

    // Handle payment failure (pass payment entity so razorpayPaymentData is stored)
    await handlePaymentFailure({
      razorpayOrderId: order.id,
      razorpayPaymentId: payment.id,
      failureReason: errorDescription,
      errorCode,
      razorpayPaymentData: payment,
    });
  } catch (error: any) {
    logger.error('❌ Error handling payment.failed:', error);
    throw error;
  }
}

/**
 * Handle order.paid event (all payments captured)
 */
async function handleOrderPaid(payload: any): Promise<void> {
  try {
    const order = payload.order?.entity;

    if (!order) {
      throw new Error('Invalid order.paid payload');
    }

    logger.info('✅ Order fully paid', {
      orderId: order.id,
      amount: order.amount,
      amountPaid: order.amount_paid,
    });

    // Order is fully paid - escrow should already be updated by payment.captured event
    // This is just for logging/confirmation
  } catch (error: any) {
    logger.error('❌ Error handling order.paid:', error);
    throw error;
  }
}

/**
 * Handle payment.refunded / refund.processed — sync ExtraHand refund row with Razorpay.
 */
async function handlePaymentRefunded(payload: {
  refund?: {
    entity?: {
      id?: string;
      status?: string;
      payment_id?: string;
      amount?: number;
      notes?: Record<string, unknown>;
    };
  };
  payment?: { entity?: { id?: string; amount?: number; amount_refunded?: number; status?: string } };
}, eventCreatedAt?: number): Promise<void> {
  try {
    const refund = payload?.refund?.entity;
    const payment = payload?.payment?.entity;

    logger.info('💰 Refund webhook processing', {
      razorpayRefundId: refund?.id,
      razorpayPaymentId: payment?.id,
      razorpayRefundStatus: refund?.status,
    });

    await completeRefundFromRazorpayWebhook({ ...payload, eventCreatedAt });
  } catch (error: any) {
    logger.error('❌ Error handling refund webhook:', error);
    throw error;
  }
}

async function handleSettlementProcessed(
  payload: { settlement?: { entity?: { created_at?: number } } },
  environment: PaymentEnvironment,
): Promise<void> {
  const createdAt = Number(payload?.settlement?.entity?.created_at);
  if (!Number.isFinite(createdAt) || createdAt <= 0) {
    throw new Error('Invalid settlement.processed payload');
  }
  await syncRefundSettlementsForDate(new Date(createdAt * 1000), environment);
}

export default router;
