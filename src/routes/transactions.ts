/**
 * Transaction History Routes
 * 
 * API routes for transaction history operations
 */

import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { TransactionController } from '../controllers/TransactionController';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

// All transaction routes require service authentication
router.use(serviceAuthMiddleware);

/**
 * POST /api/v1/transactions/issue-grants
 * Issue idempotent ExtraCoin grants (service-auth).
 */
router.post('/issue-grants', asyncHandler(TransactionController.issueGrants));

/**
 * GET /api/v1/transactions/:userId
 * Get all transactions for a user
 * Query params: limit, offset, startDate, endDate, type, status, category
 */
router.get('/:userId', asyncHandler(TransactionController.getUserTransactions));

/**
 * GET /api/v1/transactions/:userId/wallet
 * Get ExtraCoins wallet details for a user
 */
router.get('/:userId/wallet', asyncHandler(TransactionController.getExtraCoinsWallet));

/**
 * GET /api/v1/transactions/:userId/summary
 * Get transaction summary for a user
 * Query params: startDate, endDate (ISO date strings)
 */
router.get('/:userId/summary', asyncHandler(TransactionController.getTransactionSummary));

export default router;

