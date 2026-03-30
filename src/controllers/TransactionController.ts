import { Response, Request } from 'express';
import { getUserTransactions, getTransactionSummary } from '../services/transactionHistoryService';
import { BadRequestError } from '../errors/AppError';

export class TransactionController {
  /**
   * GET /api/v1/transactions/:userId
   * Get all transactions for a user
   */
  static async getUserTransactions(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const { limit, offset, startDate, endDate, type, status, category, linkedUserIds } = req.query;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const linkedParsed =
      typeof linkedUserIds === 'string' && linkedUserIds.trim()
        ? linkedUserIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const options = {
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      type: type as 'payment' | 'payout' | 'refund' | 'compensation' | 'fee' | 'escrow' | undefined,
      status: status as string | undefined,
      category: category as 'earnings' | 'payments' | 'all' | undefined,
      linkedUserIds: linkedParsed,
    };

    const result = await getUserTransactions(userId, options);

    if (!result.success) {
      throw new Error(result.error || 'Failed to get transactions');
    }

    res.json({
      success: true,
      transactions: result.transactions,
      total: result.total,
      limit: options.limit,
      offset: options.offset
    });
  }

  /**
   * GET /api/v1/transactions/:userId/summary
   * Get transaction summary for a user
   */
  static async getTransactionSummary(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const { startDate, endDate, linkedUserIds } = req.query;

    if (!userId) {
      throw new BadRequestError('User ID is required');
    }

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;
    const linkedParsed =
      typeof linkedUserIds === 'string' && linkedUserIds.trim()
        ? linkedUserIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const result = await getTransactionSummary(userId, start, end, linkedParsed);

    if (!result.success) {
      throw new Error(result.error || 'Failed to get transaction summary');
    }

    res.json({
      success: true,
      summary: result.summary
    });
  }
}


