import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { PaymentController } from '../controllers/PaymentController';
import { asyncHandler } from '../middleware/errorHandler';
import { validateCoupon, listEligibleCoupons } from '../controllers/CouponProxyController';
import {
  requestUserId,
  withPaymentDatabaseForExistingPayment,
  withPaymentDatabaseForUser,
} from '../middleware/paymentDatabase';

const router = express.Router();    

// Public: Key ID for mobile/web checkout (must match orders created by this service)
router.get('/razorpay-key', asyncHandler(PaymentController.getRazorpayKeyId));

// All other payment routes require service authentication
router.use(serviceAuthMiddleware);

// POST /api/v1/payment/create-order
router.post(
  '/create-order',
  withPaymentDatabaseForUser(asyncHandler(PaymentController.createOrder), requestUserId),
);

// POST /api/v1/payment/verify-payment
router.post(
  '/verify-payment',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.verifyPayment)),
);

// POST /api/v1/payment/verify-signature
// For service-owned payments that do not have task escrow records.
router.post(
  '/verify-signature',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.verifySignatureOnly)),
);

// GET /api/v1/payment/order-status/:orderId
router.get(
  '/order-status/:orderId',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.getOrderStatus)),
);

// POST /api/v1/payment/refund
router.post(
  '/refund',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.createRefund)),
);

// POST /api/v1/payment/cancel
router.post(
  '/cancel',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.cancelPayment)),
);

// POST /api/v1/payment/book-now/cancel-line-item
router.post(
  '/book-now/cancel-line-item',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.cancelBookNowLineItem)),
);

// POST /api/v1/payment/book-now/partner-penalty
// Penalty-only for a partner-cancelled Book Now task (no customer refund).
router.post(
  '/book-now/partner-penalty',
  withPaymentDatabaseForExistingPayment(asyncHandler(PaymentController.createPerformerPenalty)),
);

// POST /api/v1/payment/coupons/validate — proxies to coupon-service
router.post('/coupons/validate', asyncHandler(validateCoupon));
router.post('/coupons/eligible', asyncHandler(listEligibleCoupons));

export default router;

