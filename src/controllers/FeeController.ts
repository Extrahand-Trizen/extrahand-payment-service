import { Request, Response } from 'express';
import { getFeeStructure, listCategoryFeeConfigs, upsertCategoryFeeConfig, getFeeStructureForCategory } from '../services/feeConfigService';
import { calculatePosterFees } from '../services/feeCalculationService';
import { asyncHandler } from '../middleware/errorHandler';
import logger from '../config/logger';

export class FeeController {
  /**
   * GET /api/v1/fees/structure
   * Get fee structure (percentages only) for frontend calculation
   * Returns only percentages, not calculated amounts
   */
  static getFeeStructure = asyncHandler(async (req: Request, res: Response) => {
    try {
      const feeStructure = await getFeeStructure();

      // Return only percentages (no calculated amounts)
      return res.status(200).json({
        success: true,
        feeStructure: {
          platformFee: {
            percentage: feeStructure.platformFee.percentage,
            gstPercentage: feeStructure.platformFee.gstPercentage,
          },
          processingFees: {
            razorpayFeePercentage: feeStructure.processingFees.razorpayFeePercentage,
            razorpayFeeGstPercentage: feeStructure.processingFees.razorpayFeeGstPercentage,
            tdsPercentage: feeStructure.processingFees.tdsPercentage,
            splitRatio: {
              poster: feeStructure.processingFees.splitRatio.poster,
              performer: feeStructure.processingFees.splitRatio.performer,
            },
          },
          cancellationFees: {
            gracePeriodHours: feeStructure.cancellationFees.gracePeriodHours,
            early: feeStructure.cancellationFees.early,
            medium: feeStructure.cancellationFees.medium,
            late: feeStructure.cancellationFees.late,
            veryLate: feeStructure.cancellationFees.veryLate,
            distribution: {
              toOtherParty: feeStructure.cancellationFees.distribution.toOtherParty,
              toPlatform: feeStructure.cancellationFees.distribution.toPlatform,
            },
          },
        },
      });
    } catch (error: any) {
      logger.error('Error getting fee structure:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get fee structure',
      });
    }
  });

  /**
   * GET /api/v1/fees/calculate?amount=:amount&taskCategory=:taskCategory
   * Calculate actual fee breakdown for a given task amount.
   * When taskCategory is provided, uses CategoryFeeConfig for category-specific GST and platform fee.
   */
  static calculateFees = asyncHandler(async (req: Request, res: Response) => {
    try {
      const { amount, taskCategory } = req.query;

      if (!amount || isNaN(Number(amount))) {
        return res.status(400).json({
          success: false,
          error: 'Amount is required and must be a valid number',
        });
      }

      const taskAmount = Number(amount);
      const categoryKey = typeof taskCategory === 'string' && taskCategory.trim() ? taskCategory.trim() : undefined;

      // Calculate fees for the poster (category-aware when taskCategory provided)
      const fees = await calculatePosterFees(taskAmount, categoryKey);

      return res.status(200).json({
        success: true,
        fees: {
          taskAmount: Number(fees.taskAmount),
          platformFee: Number(fees.platformFee),
          platformFeeGst: Number(fees.platformFeeGst),
          platformFeeTotal: Number(fees.platformFeeTotal),
          processingFeeShare: Number(fees.processingFeeShare),
          processingFeeGst: Number(fees.processingFeeGst),
          processingFeeTotal: Number(fees.processingFeeTotal),
          totalAmount: Number(fees.totalAmount),
          metadata: {
            calculatedAt: new Date().toISOString(),
            currency: 'INR',
          },
        },
      });
    } catch (error: any) {
      logger.error('Error calculating fees:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to calculate fees',
      });
    }
  });

  /**
   * GET /api/v1/fees/categories
   * Returns all category fee configs (admin)
   */
  static listCategories = asyncHandler(async (req: Request, res: Response) => {
    try {
      const rows = await listCategoryFeeConfigs();
      return res.status(200).json({ success: true, categories: rows });
    } catch (error: any) {
      logger.error('Error listing category fee configs:', error);
      return res.status(500).json({ success: false, error: error.message || 'Failed to list categories' });
    }
  });

  /**
   * PUT /api/v1/fees/categories/:categoryKey
   * Upsert a category fee config (admin)
   */
  static upsertCategory = asyncHandler(async (req: Request, res: Response) => {
    try {
      const { categoryKey } = req.params;
      const payload = { ...req.body, categoryKey };

      const updated = await upsertCategoryFeeConfig(payload, (req as any).user?.uid || 'system');

      return res.status(200).json({ success: true, category: updated });
    } catch (error: any) {
      logger.error('Error upserting category fee config:', error);
      return res.status(500).json({ success: false, error: error.message || 'Failed to upsert category' });
    }
  });
}
