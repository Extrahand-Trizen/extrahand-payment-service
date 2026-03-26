import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { createRazorpayXContact, createRazorpayXFundAccount } from './razorpayxService';
import { processPendingTaskCompletionPayouts } from './payoutService';

function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `XXXX${accountNumber.slice(-4)}`;
}

async function processPendingPayoutsAfterBankAdd(userId: string): Promise<void> {
  processPendingTaskCompletionPayouts(userId)
    .then((result) => {
      if (result.processed > 0 || result.failed > 0) {
        logger.info('Processed pending task completion payouts after bank account add', {
          userId,
          processed: result.processed,
          failed: result.failed,
        });
      }
    })
    .catch((error: any) => {
      logger.warn('Failed to process pending payouts after bank account add', {
        userId,
        error: error?.message || 'Unknown error',
      });
    });
}

export async function upsertTaskerBankAccount(params: {
  userId: string;
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  bankName?: string;
  email?: string;
  phone?: string;
  setAsDefault?: boolean;
}): Promise<{
  success: boolean;
  bankAccountId?: string;
  maskedAccountNumber?: string;
  fundAccountId?: string;
  error?: string;
}> {
  try {
    const accountNumber = params.accountNumber.trim();
    const maskedAccountNumber = maskAccountNumber(accountNumber);
    const ifscCode = params.ifscCode.trim().toUpperCase();
    const accountHolderName = params.accountHolderName.trim();

    if (!accountNumber || !ifscCode || !accountHolderName) {
      return { success: false, error: 'accountNumber, ifscCode and accountHolderName are required' };
    }

    const contact = await createRazorpayXContact({
      name: accountHolderName,
      email: params.email,
      phone: params.phone,
      referenceId: params.userId,
    });

    const fund = await createRazorpayXFundAccount({
      contactId: contact.id,
      accountHolderName,
      ifscCode,
      accountNumber,
    });
    const fundAccountId = fund.id;

    const verificationRef = JSON.stringify({ contactId: contact.id, fundAccountId });

    const created = await prisma.bankAccount.create({
      data: {
        userId: params.userId,
        // Store only masked account number; never persist full account number.
        accountNumber: maskedAccountNumber,
        ifscCode,
        accountHolderName,
        bankName: 'Unknown Bank',
        isVerified: true,
        verifiedAt: new Date(),
        verificationRef,
      },
    });

    const profile = await prisma.userPaymentProfile.findUnique({
      where: { userId: params.userId },
    });

    if (params.setAsDefault || !profile?.defaultBankAccountId) {
      await prisma.userPaymentProfile.upsert({
        where: { userId: params.userId },
        update: {
          defaultBankAccountId: created.id,
          updatedAt: new Date(),
        },
        create: {
          userId: params.userId,
          defaultBankAccountId: created.id,
        },
      });
    }

    await processPendingPayoutsAfterBankAdd(params.userId);

    return {
      success: true,
      bankAccountId: created.id,
      maskedAccountNumber,
      fundAccountId,
    };
  } catch (error: any) {
    logger.error('Error upserting bank account for payout', {
      userId: params.userId,
      error: error.message,
    });
    return {
      success: false,
      error: error.message || 'Failed to save bank account',
    };
  }
}
