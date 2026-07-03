import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { BadRequestError } from '../errors/AppError';
import logger from '../config/logger';

export class CascadeDeleteController {
  /**
   * DELETE /api/v1/cascade-delete/user/:uid
   * Service-to-service endpoint to delete a user's financial profile data.
   * This includes ExtraCoin balances, Bank accounts, and Payment profiles.
   */
  static async deleteUserData(req: Request, res: Response): Promise<void> {
    const { uid } = req.params;

    if (!uid) {
      throw new BadRequestError('User ID (uid) is required');
    }

    logger.info(`[Payment CascadeDelete] Received cascade delete request for user: ${uid}`);

    try {
      // Execute all deletions in a transaction
      const result = await prisma.$transaction(async (tx) => {
        // 1. Delete ExtraCoin Wallets
        const deletedWallets = await tx.extraCoinWallet.deleteMany({
          where: { userId: uid }
        });

        // 2. Delete ExtraCoin Transactions
        const deletedCoinTx = await tx.extraCoinTransaction.deleteMany({
          where: { userId: uid }
        });

        // 3. Delete Bank Accounts
        const deletedBanks = await tx.bankAccount.deleteMany({
          where: { userId: uid }
        });

        // 4. Delete User Payment Profile
        const deletedProfiles = await tx.userPaymentProfile.deleteMany({
          where: { userId: uid }
        });

        return {
          deletedWallets: deletedWallets.count,
          deletedCoinTransactions: deletedCoinTx.count,
          deletedBankAccounts: deletedBanks.count,
          deletedPaymentProfiles: deletedProfiles.count,
        };
      });

      logger.info(`[Payment CascadeDelete] Successfully deleted payment data for user: ${uid}`, result);

      res.json({
        success: true,
        data: result,
        message: 'Payment user data deleted successfully'
      });
    } catch (error: any) {
      logger.error(`[Payment CascadeDelete] Failed to delete payment data for user: ${uid}`, { error: error.message });
      throw error;
    }
  }
}
