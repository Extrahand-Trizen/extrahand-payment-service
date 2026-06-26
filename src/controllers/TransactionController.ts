import { Response, Request } from 'express';
import { getUserTransactions, getTransactionSummary } from '../services/transactionHistoryService';
import { getExtraCoinsWallet } from '../services/extraCoinsService';
import { issueGrants } from '../rewards/grants/GrantExecutor';
import type { GrantSpec } from '../rewards/types/GrantSpec';
import { BadRequestError } from '../errors/AppError';
import { logPaymentReferralCoins } from '../rewards/referralCoinsLogger';
import { parseWalletRole } from '../rewards/utils/walletRole';
import { parseQueryEndDateInclusive, parseQueryStartDate } from '../utils/queryDateRange';

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
      startDate: startDate ? parseQueryStartDate(startDate as string) : undefined,
      endDate: endDate ? parseQueryEndDateInclusive(endDate as string) : undefined,
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

    const start = startDate ? parseQueryStartDate(startDate as string) : undefined;
    const end = endDate ? parseQueryEndDateInclusive(endDate as string) : undefined;
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

  /**
   * GET /api/v1/transactions/:userId/wallet
   * Get ExtraCoins wallet details for a user
   */
  static async getExtraCoinsWallet(req: Request, res: Response): Promise<void> {
    const { userId } = req.params;
    const { linkedUserIds, walletRole } = req.query;

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

    const result = await getExtraCoinsWallet(
      userId,
      linkedParsed,
      parseWalletRole(walletRole)
    );

    if (!result.success) {
      throw new Error(result.error || 'Failed to get ExtraCoins wallet');
    }

    res.json({
      success: true,
      wallet: result.wallet,
    });
  }

  /**
   * POST /api/v1/transactions/issue-grants
   */
  static async issueGrants(req: Request, res: Response): Promise<void> {
    const { grants } = req.body as { grants?: GrantSpec[] };
    if (!Array.isArray(grants) || grants.length === 0) {
      throw new BadRequestError('grants array is required');
    }
    logPaymentReferralCoins('issue_grants_request', {
      grantCount: grants.length,
      recipients: grants.map((g) => ({
        recipientUid: g.recipientUid,
        walletRole: g.walletRole || 'tasker',
        coins: g.coins,
        source: g.metadata?.source,
        idempotencyKey: g.idempotencyKey,
      })),
    });
    const result = await issueGrants(grants);
    logPaymentReferralCoins('issue_grants_response', {
      success: result.success,
      partial: result.partial,
      results: result.results,
    }, result.success && !result.partial ? 'info' : 'warn');
    res.json(result);
  }
}


