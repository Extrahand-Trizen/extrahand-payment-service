import { Response, Request } from 'express';
import { getUserEarnings, getEarningsByPeriod, getEarningsStats } from '../services/earningsService';
import { getPendingPenaltySummary } from '../services/performerPenaltyService';
import { BadRequestError } from '../errors/AppError';
import logger from '../config/logger';

export class EarningsController {
  /**
   * GET /api/v1/earnings/:userId
   * Get total earnings for a user
   */
  /**
   * GET /api/v1/earnings/:userId/pending-cancellation-penalties
   * Always returns 200 on recoverable errors so clients (e.g. profile payments) can still load transactions.
   */
  static async getPendingCancellationPenalties(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const linkedRaw = req.query.linkedUserIds;

    logger.debug('[EarningsController.getPendingCancellationPenalties] Received request', {
      userId,
      linkedUserIds: linkedRaw,
    });

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const linkedParsed =
      typeof linkedRaw === 'string' && linkedRaw.trim()
        ? linkedRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== userId)
        : [];

    logger.debug('[EarningsController.getPendingCancellationPenalties] Parsed linked users', {
      userId,
      linkedUserCount: linkedParsed.length,
      allUserIds: [userId, ...linkedParsed],
    });

    const result = await getPendingPenaltySummary(userId, linkedParsed);

    if (!result.success) {
      logger.warn('[EarningsController.getPendingCancellationPenalties] Service failed, returning fallback', {
        userId,
        linkedUserCount: linkedParsed.length,
        error: result.error,
      });
      res.status(200).json({
        success: true,
        totalRemaining: '0',
        items: [],
      });
      return;
    }

    logger.info('[EarningsController.getPendingCancellationPenalties] Successfully fetched penalties', {
      userId,
      linkedUserCount: linkedParsed.length,
      totalRemaining: result.totalRemaining,
      penaltyCount: (result.items || []).length,
    });

    res.json({
      success: true,
      totalRemaining: result.totalRemaining || '0',
      items: result.items || [],
    });
  }

  static async getEarnings(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const linkedRaw = req.query.linkedUserIds;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const linkedParsed =
      typeof linkedRaw === 'string' && linkedRaw.trim()
        ? linkedRaw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== userId)
        : [];

    const result = await getUserEarnings(userId, linkedParsed);

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

