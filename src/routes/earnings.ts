/**
 * Earnings Routes
 * 
 * API routes for earnings operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { EarningsController } from '../controllers/EarningsController';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All earnings routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * GET /api/v1/earnings/:userId
 * Get total earnings for a user
 */
router.get('/:userId', asyncHandler(EarningsController.getEarnings));

/**
 * GET /api/v1/earnings/:userId/period
 * Get earnings breakdown by period (monthly)
 * Query params: startDate, endDate (ISO date strings)
 */
router.get('/:userId/period', asyncHandler(EarningsController.getEarningsByPeriod));

/**
 * GET /api/v1/earnings/:userId/stats
 * Get earnings statistics for a user
 */
router.get('/:userId/stats', asyncHandler(EarningsController.getEarningsStats));

export default router;





