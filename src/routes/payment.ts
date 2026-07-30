import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { PaymentController } from '../controllers/PaymentController';
import { asyncHandler } from '../middleware/errorHandler';
import { validateCoupon, listEligibleCoupons } from '../controllers/CouponProxyController';

const router = express.Router();    

// Public: Key ID for mobile/web checkout (must match orders created by this service)
router.get('/razorpay-key', asyncHandler(PaymentController.getRazorpayKeyId));

// All other payment routes require service authentication
router.use(serviceAuthMiddleware);

// POST /api/v1/payment/create-order
router.post('/create-order', asyncHandler(PaymentController.createOrder));

// POST /api/v1/payment/verify-payment
router.post('/verify-payment', asyncHandler(PaymentController.verifyPayment));

// GET /api/v1/payment/order-status/:orderId
router.get('/order-status/:orderId', asyncHandler(PaymentController.getOrderStatus));

// POST /api/v1/payment/refund
router.post('/refund', asyncHandler(PaymentController.createRefund));

// POST /api/v1/payment/cancel
router.post('/cancel', asyncHandler(PaymentController.cancelPayment));

// POST /api/v1/payment/book-now/cancel-line-item
router.post(
  '/book-now/cancel-line-item',
  asyncHandler(PaymentController.cancelBookNowLineItem),
);

// POST /api/v1/payment/coupons/validate — proxies to coupon-service
router.post('/coupons/validate', asyncHandler(validateCoupon));
router.post('/coupons/eligible', asyncHandler(listEligibleCoupons));

export default router;

