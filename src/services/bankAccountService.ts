import { prisma } from '../config/prisma';
import logger from '../config/logger';
import {
  createRazorpayXContact,
  createRazorpayXFundAccount,
  parseRazorpayApiError,
} from './razorpayxService';
import { buildEncryptedBankAccountPersistFields } from './bankAccountSecrets';
import { maskAccountNumberForDisplay } from '../utils/bankFieldCrypto';

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
  isRazorpayClientError?: boolean;
}> {
  try {
    const accountNumber = params.accountNumber.trim();
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
    const encryptedFields = buildEncryptedBankAccountPersistFields({
      accountNumber,
      accountHolderName,
    });

    const created = await prisma.bankAccount.create({
      data: {
        userId: params.userId,
        ...encryptedFields,
        ifscCode,
        bankName: params.bankName?.trim() || 'Unknown Bank',
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

    return {
      success: true,
      bankAccountId: created.id,
      maskedAccountNumber:
        encryptedFields.accountNumber || maskAccountNumberForDisplay(accountNumber),
      fundAccountId,
    };
  } catch (error: unknown) {
    const parsed = parseRazorpayApiError(error);
    const message =
      parsed.message ||
      (error instanceof Error ? error.message : 'Failed to save bank account');

    logger.error('Error upserting bank account for payout', {
      userId: params.userId,
      error: message,
      httpStatus: parsed.httpStatus,
      isRazorpayClientError: parsed.isClientError,
    });
    return {
      success: false,
      error: message,
      isRazorpayClientError: parsed.isClientError,
    };
  }
}
