/**
 * Payout Routes
 * 
 * API routes for payout operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { PayoutController } from '../controllers/PayoutController';
import { asyncHandler } from '../middleware/errorHandler';
import { withPaymentDatabaseForExistingPayment } from '../middleware/paymentDatabase';

const router = express.Router();

// All payout routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/payouts/process
 * Process a payout to performer
 */
router.post(
  '/process',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.processPayout)),
);

/**
 * POST /api/v1/payouts/task-completion
 * Process payout directly on task completion (non-escrow flow)
 */
router.post(
  '/task-completion',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.processTaskCompletionPayout)),
);

/**
 * GET /api/v1/payouts/status/:payoutId
 * Get payout status
 */
router.get(
  '/status/:payoutId',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.getPayoutStatus)),
);

/**
 * GET /api/v1/payouts/escrow/:escrowId
 * Get all payouts for an escrow
 */
router.get(
  '/escrow/:escrowId',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.getPayoutsByEscrowId)),
);

/**
 * GET /api/v1/payouts/task/:taskId/bundle
 * Combined escrow + payout + wallet + fee estimate for a task
 */
router.get(
  '/task/:taskId/bundle',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.getTaskPayoutBundle)),
);

/**
 * POST /api/v1/payouts/task/:taskId/hold-book-now
 * Hold Book Now payouts when customer raises an issue
 */
router.post(
  '/task/:taskId/hold-book-now',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.holdBookNowTaskPayouts)),
);

/**
 * POST /api/v1/payouts/status/batch
 * Batch payout status lookup
 */
router.post(
  '/status/batch',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.getPayoutStatusBatch)),
);

/**
 * POST /api/v1/payouts/tasks/transactions
 * Get payout transactions for a list of task IDs (earnings By Period tab)
 */
router.post(
  '/tasks/transactions',
  withPaymentDatabaseForExistingPayment(asyncHandler(PayoutController.getPayoutsByTaskIds)),
);

/**
 * GET /api/v1/payouts/ops/manual-queue
 * List payout requests for operations portal (manual bank transfers).
 */
router.get('/ops/manual-queue', asyncHandler(PayoutController.listManualOpsQueue));

export default router;




