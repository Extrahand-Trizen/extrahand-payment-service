import { Response, Request } from 'express';
import { getUserEarnings, getEarningsByPeriod, getEarningsStats } from '../services/earningsService';
import { BadRequestError } from '../errors/AppError';

export class EarningsController {
  /**
   * GET /api/v1/earnings/:userId
   * Get total earnings for a user
   */
  static async getEarnings(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const result = await getUserEarnings(userId);

    if (!result.success) {
      throw new Error(result.error || 'Failed to get earnings');
    }

    res.json({
      success: true,
      earnings: result.earnings
    });
  }

  /**
   * GET /api/v1/earnings/:userId/period
   * Get earnings breakdown by period (monthly)
   */
  static async getEarningsByPeriod(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const result = await getEarningsByPeriod(userId, start, end);

    if (!result.success) {
      throw new Error(result.error || 'Failed to get earnings by period');
    }

    res.json({
      success: true,
      earnings: result.earnings
    });
  }

  /**
   * GET /api/v1/earnings/:userId/stats
   * Get earnings statistics for a user
   */
  static async getEarningsStats(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const result = await getEarningsStats(userId);

    if (!result.success) {
      throw new Error(result.error || 'Failed to get earnings stats');
    }

    res.json({
      success: true,
      stats: result.stats
    });
  }
}

