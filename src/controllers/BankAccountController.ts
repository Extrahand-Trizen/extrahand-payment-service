import { Request, Response } from 'express';
import { BadRequestError } from '../errors/AppError';
import { upsertTaskerBankAccount } from '../services/bankAccountService';
import { prisma } from '../config/prisma';
import { toTaskerFacingBankAccount } from '../services/bankAccountSecrets';
import logger from '../config/logger';

function headerString(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === 'string' && v.trim().length > 0);
    return first?.trim();
  }
  if (typeof raw === 'string' && raw.trim().length > 0) {
    // Some proxies concatenate duplicate headers as "a, b"
    return raw.split(',')[0]?.trim() || undefined;
  }
  return undefined;
}

function collectLinkedIds(...values: Array<string | string[] | undefined | null>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        const s = String(item || '').trim();
        if (s) out.add(s);
      }
      continue;
    }
    const text = String(value).trim();
    if (!text) continue;
    for (const part of text.split(',')) {
      const s = part.trim();
      if (s) out.add(s);
    }
  }
  return Array.from(out);
}

/** Firebase uid + profile Mongo id (+ optional body/query linked ids). */
function resolveCallerUserIds(req: Request): string[] {
  const headerUid = headerString(req, 'x-user-id');
  const profileId = headerString(req, 'x-profile-id');
  const bodyUid =
    typeof req.body?.userId === 'string' && req.body.userId.trim()
      ? req.body.userId.trim()
      : undefined;
  const queryUid =
    typeof req.query?.userId === 'string' && req.query.userId.trim()
      ? req.query.userId.trim()
      : undefined;
  const bodyLinked = req.body?.linkedUserIds;
  const queryLinked = req.query?.linkedUserIds;

  return collectLinkedIds(headerUid, profileId, bodyUid, queryUid, bodyLinked, queryLinked as string | undefined);
}

export class BankAccountController {
  static async upsertBankAccount(req: Request, res: Response): Promise<void> {
    const callerIds = resolveCallerUserIds(req);
    const userId = callerIds[0];

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
      if (result.isRazorpayClientError) {
        throw new BadRequestError(result.error || 'Bank account could not be verified. Check details and try again.');
      }
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
    const callerIds = resolveCallerUserIds(req);

    if (callerIds.length === 0) {
      throw new BadRequestError('User id is required (x-user-id header)');
    }

    const accounts = await prisma.bankAccount.findMany({
      where: { userId: { in: callerIds } },
      orderBy: { createdAt: 'desc' },
    });

    const profiles = await prisma.userPaymentProfile.findMany({
      where: { userId: { in: callerIds } },
      select: { userId: true, defaultBankAccountId: true },
    });
    const defaultIds = new Set(
      profiles
        .map((p) => p.defaultBankAccountId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );

    res.json({
      success: true,
      data: accounts.map((account) => ({
        ...toTaskerFacingBankAccount(account),
        isDefault: defaultIds.has(account.id),
      })),
    });
  }

  static async deleteBankAccount(req: Request, res: Response): Promise<void> {
    const callerIds = resolveCallerUserIds(req);
    const bankAccountId = String(req.params.bankAccountId || '').trim();

    if (callerIds.length === 0) {
      throw new BadRequestError('User id is required (x-user-id header)');
    }

    if (!bankAccountId) {
      throw new BadRequestError('bankAccountId is required');
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, userId: true },
    });

    // Ownership: bank row must belong to Firebase uid and/or profile id for this caller.
    if (!bankAccount || !callerIds.includes(bankAccount.userId)) {
      logger.warn('[BankAccount] Delete denied — not found or ownership mismatch', {
        bankAccountId,
        callerIds,
        ownerUserId: bankAccount?.userId ?? null,
      });
      throw new BadRequestError('Bank account not found');
    }

    // Clear default pointer(s) first, then hard-delete inside one transaction so a
    // partial failure cannot leave UI thinking the row is gone while Postgres still has it.
    const deleted = await prisma.$transaction(async (tx) => {
      await tx.userPaymentProfile.updateMany({
        where: { defaultBankAccountId: bankAccountId },
        data: { defaultBankAccountId: null, updatedAt: new Date() },
      });

      const result = await tx.bankAccount.deleteMany({
        where: {
          id: bankAccountId,
          userId: bankAccount.userId,
        },
      });

      if (result.count === 0) {
        throw new BadRequestError('Bank account not found or already deleted');
      }

      // Re-point default to newest remaining account for any of the caller's identities.
      const remaining = await tx.bankAccount.findFirst({
        where: { userId: { in: callerIds } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      if (remaining) {
        // Prefer updating the primary caller profile (first id); create if missing.
        const primaryUserId = callerIds[0];
        await tx.userPaymentProfile.upsert({
          where: { userId: primaryUserId },
          update: { defaultBankAccountId: remaining.id, updatedAt: new Date() },
          create: { userId: primaryUserId, defaultBankAccountId: remaining.id },
        });
      }

      return result.count;
    });

    logger.info('[BankAccount] Deleted bank account', {
      bankAccountId,
      ownerUserId: bankAccount.userId,
      callerIds,
      deletedCount: deleted,
    });

    res.json({
      success: true,
      message: 'Bank account deleted successfully',
      data: { bankAccountId, deleted: true },
    });
  }

  static async setDefaultBankAccount(req: Request, res: Response): Promise<void> {
    const callerIds = resolveCallerUserIds(req);
    const bankAccountId = String(req.params.bankAccountId || '').trim();
    const primaryUserId = callerIds[0];

    if (!primaryUserId) {
      throw new BadRequestError('User id is required (x-user-id header)');
    }

    if (!bankAccountId) {
      throw new BadRequestError('bankAccountId is required');
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, userId: true },
    });

    if (!bankAccount || !callerIds.includes(bankAccount.userId)) {
      throw new BadRequestError('Bank account not found');
    }

    await prisma.userPaymentProfile.upsert({
      where: { userId: primaryUserId },
      update: {
        defaultBankAccountId: bankAccountId,
        updatedAt: new Date(),
      },
      create: {
        userId: primaryUserId,
        defaultBankAccountId: bankAccountId,
      },
    });

    res.json({
      success: true,
      data: { defaultBankAccountId: bankAccountId },
      message: 'Default bank account updated',
    });
  }
}
