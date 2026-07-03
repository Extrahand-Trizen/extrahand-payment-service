import express from 'express';
import { CascadeDeleteController } from '../controllers/CascadeDeleteController';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All cascade delete routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * DELETE /api/v1/cascade-delete/user/:uid
 * Delete all payment and financial profile data for a user
 */
router.delete(
  '/user/:uid',
  asyncHandler(CascadeDeleteController.deleteUserData.bind(CascadeDeleteController))
);

export default router;
