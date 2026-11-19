/**
 * Earnings Routes
 * 
 * API routes for earnings operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { EarningsController } from '../controllers/EarningsController';
import { asyncHandler } from '../middleware/errorHandler';
import { withPaymentDatabaseForUser } from '../middleware/paymentDatabase';

const router = express.Router();

// All earnings routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * GET /api/v1/earnings/:userId/pending-cancellation-penalties
 * Pending tasker cancellation penalties (deducted from next payouts)
 */
router.get(
  '/:userId/pending-cancellation-penalties',
  withPaymentDatabaseForUser(
    asyncHandler(EarningsController.getPendingCancellationPenalties),
    (req) => req.params.userId,
  ),
);

/**
 * GET /api/v1/earnings/:userId
 * Get total earnings for a user
 */
router.get(
  '/:userId',
  withPaymentDatabaseForUser(
    asyncHandler(EarningsController.getEarnings),
    (req) => req.params.userId,
  ),
);

/**
 * GET /api/v1/earnings/:userId/period
 * Get earnings breakdown by period (monthly)
 * Query params: startDate, endDate (ISO date strings)
 */
router.get(
  '/:userId/period',
  withPaymentDatabaseForUser(
    asyncHandler(EarningsController.getEarningsByPeriod),
    (req) => req.params.userId,
  ),
);

/**
 * GET /api/v1/earnings/:userId/stats
 * Get earnings statistics for a user
 */
router.get(
  '/:userId/stats',
  withPaymentDatabaseForUser(
    asyncHandler(EarningsController.getEarningsStats),
    (req) => req.params.userId,
  ),
);

export default router;





