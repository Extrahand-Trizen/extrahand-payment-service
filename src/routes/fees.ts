import express from 'express';
import { FeeController } from '../controllers/FeeController';

const router = express.Router();

/**
 * GET /api/v1/fees/structure
 * Get fee structure (percentages only) for frontend calculation
 * No authentication required - public endpoint (just percentages)
 */
router.get('/structure', FeeController.getFeeStructure);

/**
 * GET /api/v1/fees/calculate?amount=:amount
 * Calculate actual fee breakdown for a given task amount
 * No authentication required - public endpoint (calculations only)
 */
router.get('/calculate', FeeController.calculateFees);

/**
 * POST /api/v1/fees/book-now/calculate
 * Book Now: per-category GST on service subtotals (customer payment only).
 */
router.post('/book-now/calculate', FeeController.calculateBookNowTotals);

/** Admin: list and upsert per-category fee configs */
router.get('/categories', FeeController.listCategories);
router.put('/categories/:categoryKey', FeeController.upsertCategory);

export default router;

