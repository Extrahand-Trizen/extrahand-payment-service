import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { EscrowController } from '../controllers/EscrowController';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All escrow routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/escrow/create
 * Create escrow when offer is accepted
 */
router.post('/create', asyncHandler(EscrowController.createEscrow));

router.post('/create-booking', asyncHandler(EscrowController.createBookingEscrow));

router.patch('/:escrowId/attach-performer', asyncHandler(EscrowController.attachPerformer));

router.patch(
  '/:escrowId/reassign-recurring-visit',
  asyncHandler(EscrowController.reassignRecurringVisit),
);

/**
 * GET /api/v1/escrow/status/:escrowId
 * Get escrow status by escrow ID
 */
router.get('/status/:escrowId', asyncHandler(EscrowController.getEscrowStatus));

/**
 * GET /api/v1/escrow/task/:taskId
 * Get escrow by task ID
 */
router.get('/task/:taskId', asyncHandler(EscrowController.getEscrowByTaskId));

/**
 * Escrow release and auto-release disabled - handled elsewhere
 * POST /api/v1/escrow/release/:escrowId
 * router.post('/release/:escrowId', asyncHandler(EscrowController.releaseEscrow));
 *
 * PUT /api/v1/escrow/auto-release
 * router.put('/auto-release', asyncHandler(EscrowController.updateAutoRelease));
 */

export default router;


