/**
 * Refund Routes
 * 
 * API routes for refund operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { RefundController } from '../controllers/RefundController';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All refund routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/refunds/process
 * Process a refund (with cancellation fee calculation)
 */
router.post('/process', asyncHandler(RefundController.processRefund));

/**
 * GET /api/v1/refunds/status/:refundId
 * Get refund status
 */
router.get('/status/:refundId', asyncHandler(RefundController.getRefundStatus));

/**
 * GET /api/v1/refunds/escrow/:escrowId
 * Get all refunds for an escrow
 */
router.get('/escrow/:escrowId', asyncHandler(RefundController.getRefundsByEscrowId));

export default router;







