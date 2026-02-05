import { Request, Response } from 'express';
import { getFeeStructure } from '../services/feeConfigService';
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
   * GET /api/v1/fees/calculate?amount=:amount
   * Calculate actual fee breakdown for a given task amount
   * Returns calculated amounts for all fees
   */
  static calculateFees = asyncHandler(async (req: Request, res: Response) => {
    try {
      const { amount } = req.query;

      if (!amount || isNaN(Number(amount))) {
        return res.status(400).json({
          success: false,
          error: 'Amount is required and must be a valid number',
        });
      }

      const taskAmount = Number(amount);
      
      // Calculate fees for the poster (what they will pay)
      const fees = await calculatePosterFees(taskAmount);

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
}
