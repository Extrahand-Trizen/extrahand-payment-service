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

/** Admin: list and upsert per-category fee configs */
router.get('/categories', FeeController.listCategories);
router.put('/categories/:categoryKey', FeeController.upsertCategory);
router.delete('/categories/:categoryKey', FeeController.deleteCategory);

export default router;

