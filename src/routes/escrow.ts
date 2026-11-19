import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { EscrowController } from '../controllers/EscrowController';
import { asyncHandler } from '../middleware/errorHandler';
import {
  requestUserId,
  withPaymentDatabaseForExistingPayment,
  withPaymentDatabaseForUser,
} from '../middleware/paymentDatabase';

const router = express.Router();

// All escrow routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/escrow/create
 * Create escrow when offer is accepted
 */
router.post(
  '/create',
  withPaymentDatabaseForUser(asyncHandler(EscrowController.createEscrow), requestUserId),
);

router.post(
  '/create-booking',
  withPaymentDatabaseForUser(asyncHandler(EscrowController.createBookingEscrow), requestUserId),
);

router.patch(
  '/:escrowId/attach-performer',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.attachPerformer)),
);

router.patch(
  '/:escrowId/reset-performer',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.resetPerformer)),
);

router.patch(
  '/:escrowId/reassign-recurring-visit',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.reassignRecurringVisit)),
);

router.patch(
  '/:escrowId/link-task',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.linkTask)),
);

/**
 * GET /api/v1/escrow/status/:escrowId
 * Get escrow status by escrow ID
 */
router.get(
  '/status/:escrowId',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.getEscrowStatus)),
);

/**
 * GET /api/v1/escrow/booking-order/:bookingOrderId
 * Get escrow by Book Now booking order id
 */
router.get(
  '/booking-order/:bookingOrderId',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.getEscrowByBookingOrderId)),
);

/**
 * GET /api/v1/escrow/task/:taskId/deletion-safety
 * Financial footprint for hard/soft delete decisions (service-to-service).
 */
router.get(
  '/task/:taskId/deletion-safety',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.getTaskDeletionSafety)),
);

/**
 * GET /api/v1/escrow/task/:taskId
 * Get escrow by task ID
 */
router.get(
  '/task/:taskId',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.getEscrowByTaskId)),
);

/**
 * GET /api/v1/escrow/booking-order/:bookingOrderId
 * Get escrow by booking order ID
 */
router.get(
  '/booking-order/:bookingOrderId',
  withPaymentDatabaseForExistingPayment(asyncHandler(EscrowController.getEscrowByBookingOrderId)),
);

/**
 * Escrow release and auto-release disabled - handled elsewhere
 * POST /api/v1/escrow/release/:escrowId
 * router.post('/release/:escrowId', asyncHandler(EscrowController.releaseEscrow));
 *
 * PUT /api/v1/escrow/auto-release
 * router.put('/auto-release', asyncHandler(EscrowController.updateAutoRelease));
 */

export default router;


