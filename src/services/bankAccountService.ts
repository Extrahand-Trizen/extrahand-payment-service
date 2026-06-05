import { prisma } from '../config/prisma';
import logger from '../config/logger';
import {
  createRazorpayXContact,
  createRazorpayXFundAccount,
  parseRazorpayApiError,
} from './razorpayxService';

function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `XXXX${accountNumber.slice(-4)}`;
}

function maskAccountHolderName(name: string): string {
  const v = (name || '').trim();
  if (!v) return v;
  const parts = v.split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const lastInitial = parts.length > 1 ? parts[parts.length - 1]?.[0] : '';
  const firstMasked = first.length <= 2 ? first[0] + '*' : first.slice(0, 2) + '*'.repeat(Math.min(6, first.length - 2));
  return lastInitial ? `${firstMasked} ${lastInitial}.` : firstMasked;
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
  /** Razorpay returned 4xx — safe to show message to user; map to HTTP 400 */
  isRazorpayClientError?: boolean;
}> {
  try {
    const accountNumber = params.accountNumber.trim();
    const maskedAccountNumber = maskAccountNumber(accountNumber);
    const ifscCode = params.ifscCode.trim().toUpperCase();
    const accountHolderName = params.accountHolderName.trim();
    const maskedAccountHolderName = maskAccountHolderName(accountHolderName);

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
        // Tokenization-first: never persist raw bank details. Store only masked display values + Razorpay tokens.
        accountNumber: maskedAccountNumber,
        // IFSC is intentionally stored fully (industry-standard display/operational format).
        ifscCode,
        accountHolderName: maskedAccountHolderName,
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
      maskedAccountNumber,
      fundAccountId,
    };
  } catch (error: unknown) {
    const parsed = parseRazorpayApiError(error);
    logger.error('Error upserting bank account for payout', {
      userId: params.userId,
      error: parsed.message,
      httpStatus: parsed.httpStatus,
      isRazorpayClientError: parsed.isClientError,
    });
    return {
      success: false,
      error: parsed.message || 'Failed to save bank account',
      isRazorpayClientError: parsed.isClientError,
    };
  }
}
