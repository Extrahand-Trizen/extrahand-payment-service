/**
 * Payout Routes
 * 
 * API routes for payout operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { PayoutController } from '../controllers/PayoutController';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All payout routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/payouts/process
 * Process a payout to performer
 */
router.post('/process', asyncHandler(PayoutController.processPayout));

/**
 * POST /api/v1/payouts/task-completion
 * Process payout directly on task completion (non-escrow flow)
 */
router.post('/task-completion', asyncHandler(PayoutController.processTaskCompletionPayout));

/**
 * GET /api/v1/payouts/status/:payoutId
 * Get payout status
 */
router.get('/status/:payoutId', asyncHandler(PayoutController.getPayoutStatus));

/**
 * GET /api/v1/payouts/escrow/:escrowId
 * Get all payouts for an escrow
 */
router.get('/escrow/:escrowId', asyncHandler(PayoutController.getPayoutsByEscrowId));

/**
 * GET /api/v1/payouts/ops/manual-queue
 * List payout requests for operations portal (manual bank transfers).
 */
router.get('/ops/manual-queue', asyncHandler(PayoutController.listManualOpsQueue));

export default router;




