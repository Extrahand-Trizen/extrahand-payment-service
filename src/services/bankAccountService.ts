import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { createRazorpayXContact, createRazorpayXFundAccount } from './razorpayxService';

function maskAccountNumber(accountNumber: string): string {
  if (accountNumber.length <= 4) return accountNumber;
  return `XXXX${accountNumber.slice(-4)}`;
}

function parseVerificationRef(ref?: string | null): { contactId?: string; fundAccountId?: string } {
  if (!ref) return {};
  try {
    const parsed = JSON.parse(ref);
    return {
      contactId: parsed.contactId,
      fundAccountId: parsed.fundAccountId,
    };
  } catch {
    return {};
  }
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

    let existing = await prisma.bankAccount.findFirst({
      where: {
        userId: params.userId,
        ifscCode,
        OR: [
          { accountNumber: maskedAccountNumber },
          // Backward compatibility for older rows that may still have full account number.
          { accountNumber },
        ],
      },
      orderBy: { updatedAt: 'desc' },
    });

    let contactId: string | undefined;
    let fundAccountId: string | undefined;

    if (existing?.verificationRef) {
      const parsed = parseVerificationRef(existing.verificationRef);
      contactId = parsed.contactId;
      fundAccountId = parsed.fundAccountId;
    }

    if (!contactId) {
      const existingContactRecord = await prisma.bankAccount.findFirst({
        where: {
          userId: params.userId,
          verificationRef: {
            not: null,
          },
        },
        orderBy: { updatedAt: 'desc' },
        select: { verificationRef: true },
      });

      if (existingContactRecord?.verificationRef) {
        const parsed = parseVerificationRef(existingContactRecord.verificationRef);
        contactId = parsed.contactId;
      }
    }

    if (!contactId) {
      const contact = await createRazorpayXContact({
        name: accountHolderName,
        email: params.email,
        phone: params.phone,
        referenceId: params.userId,
      });
      contactId = contact.id;
    }

    if (!fundAccountId) {
      const fund = await createRazorpayXFundAccount({
        contactId,
        accountHolderName,
        ifscCode,
        accountNumber,
      });
      fundAccountId = fund.id;
    }

    const verificationRef = JSON.stringify({ contactId, fundAccountId });

    if (existing) {
      existing = await prisma.bankAccount.update({
        where: { id: existing.id },
        data: {
          accountNumber: maskedAccountNumber,
          accountHolderName,
          bankName: existing.bankName || 'Unknown Bank',
          isVerified: true,
          verifiedAt: new Date(),
          verificationRef,
        },
      });
    } else {
      existing = await prisma.bankAccount.create({
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
    }

    const profile = await prisma.userPaymentProfile.findUnique({
      where: { userId: params.userId },
    });

    if (params.setAsDefault || !profile?.defaultBankAccountId) {
      await prisma.userPaymentProfile.upsert({
        where: { userId: params.userId },
        update: {
          defaultBankAccountId: existing.id,
          updatedAt: new Date(),
        },
        create: {
          userId: params.userId,
          defaultBankAccountId: existing.id,
        },
      });
    }

    return {
      success: true,
      bankAccountId: existing.id,
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
