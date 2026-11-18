/**
 * Refund Routes
 * 
 * API routes for refund operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { RefundController } from '../controllers/RefundController';
import { asyncHandler } from '../middleware/errorHandler';
import { withPaymentDatabaseForExistingPayment } from '../middleware/paymentDatabase';

const router = express.Router();

// All refund routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/refunds/process
 * Process a refund (with cancellation fee calculation)
 */
router.post(
  '/process',
  withPaymentDatabaseForExistingPayment(asyncHandler(RefundController.processRefund)),
);

/**
 * GET /api/v1/refunds/mine
 * Get refunds for the authenticated customer.
 */
router.get('/mine', asyncHandler(RefundController.getMyRefunds));

/**
 * GET /api/v1/refunds/status/:refundId
 * Get refund status
 */
router.get(
  '/status/:refundId',
  withPaymentDatabaseForExistingPayment(asyncHandler(RefundController.getRefundStatus)),
);

/**
 * GET /api/v1/refunds/escrow/:escrowId
 * Get all refunds for an escrow
 */
router.get(
  '/escrow/:escrowId',
  withPaymentDatabaseForExistingPayment(asyncHandler(RefundController.getRefundsByEscrowId)),
);

export default router;







