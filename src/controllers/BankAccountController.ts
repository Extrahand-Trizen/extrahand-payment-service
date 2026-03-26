import { Request, Response } from 'express';
import { BadRequestError } from '../errors/AppError';
import { upsertTaskerBankAccount } from '../services/bankAccountService';
import { prisma } from '../config/prisma';

function maskForResponse(accountNumber: string): string {
  if (!accountNumber) return accountNumber;
  if (accountNumber.startsWith('XXXX')) return accountNumber;
  return accountNumber.length <= 4 ? accountNumber : `XXXX${accountNumber.slice(-4)}`;
}

export class BankAccountController {
  static async upsertBankAccount(req: Request, res: Response): Promise<void> {
    const userId = (req.headers['x-user-id'] as string) || req.body.userId;

    if (!userId) {
      throw new BadRequestError('User id is required (x-user-id header)');
    }

    const { accountNumber, ifscCode, accountHolderName, email, phone, setAsDefault } = req.body;

    if (!accountNumber || !ifscCode || !accountHolderName) {
      throw new BadRequestError('accountNumber, ifscCode and accountHolderName are required');
    }

    const result = await upsertTaskerBankAccount({
      userId,
      accountNumber,
      ifscCode,
      accountHolderName,
      email,
      phone,
      setAsDefault,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to save bank account');
    }

    res.json({
      success: true,
      data: {
        bankAccountId: result.bankAccountId,
        maskedAccountNumber: result.maskedAccountNumber,
        fundAccountId: result.fundAccountId,
      },
      message: 'Bank account saved successfully',
    });
  }

  static async getMyBankAccounts(req: Request, res: Response): Promise<void> {
    const userId = (req.headers['x-user-id'] as string) || req.query.userId;

    if (!userId || typeof userId !== 'string') {
      throw new BadRequestError('User id is required (x-user-id header)');
    }

    const accounts = await prisma.bankAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        bankName: true,
        accountHolderName: true,
        accountNumber: true,
        ifscCode: true,
        isVerified: true,
        createdAt: true,
      },
    });

    const profile = await prisma.userPaymentProfile.findUnique({
      where: { userId },
      select: { defaultBankAccountId: true },
    });

    res.json({
      success: true,
      data: accounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        accountHolderName: account.accountHolderName,
        accountNumber: maskForResponse(account.accountNumber),
        ifscCode: account.ifscCode,
        isVerified: account.isVerified,
        isDefault: profile?.defaultBankAccountId === account.id,
        createdAt: account.createdAt,
      })),
    });
  }
}
