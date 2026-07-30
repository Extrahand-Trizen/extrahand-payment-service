import { Router } from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';
import { hasSuccessfulPayment } from '../controllers/CouponProxyController';

const router = Router();

router.use(serviceAuthMiddleware);

/** First-booking eligibility for coupon-service */
router.get(
  '/users/:userId/has-successful-payment',
  asyncHandler(hasSuccessfulPayment)
);

export default router;
