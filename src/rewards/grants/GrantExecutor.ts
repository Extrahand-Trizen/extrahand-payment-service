import { Prisma } from '@prisma/client';
import logger from '../../config/logger';
import { prisma } from '../../config/prisma';
import type { GrantSpec, IssueGrantResult, IssueGrantsResult } from '../types/GrantSpec';
import { logPaymentReferralCoins } from '../referralCoinsLogger';
import { parseWalletRole } from '../utils/walletRole';

const ZERO = new Prisma.Decimal('0.00');

function toDecimal(value: string | number | Prisma.Decimal): Prisma.Decimal {
  if (value instanceof Prisma.Decimal) return value;
  return new Prisma.Decimal(String(value));
}

function generateCoinTransactionId(prefix: 'earned' | 'redeemed' | 'expired'): string {
  return `xcoin_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

export function warnIfNonCanonicalUid(uid: string, context: string): void {
  if (OBJECT_ID_PATTERN.test(uid)) {
    logger.warn('[GrantExecutor] recipientUid looks like Mongo ObjectId — use Firebase uid', {
      context,
      uidPrefix: uid.slice(0, 8),
    });
  }
}

/**
 * Sole writer for earned ExtraCoins (idempotent via unique idempotencyKey).
 */
export async function issueGrant(spec: GrantSpec): Promise<IssueGrantResult> {
  const { idempotencyKey, recipientUid, metadata } = spec;
  const walletRole = parseWalletRole(spec.walletRole);
  warnIfNonCanonicalUid(recipientUid, `issueGrant:${metadata.source}`);

  const coins = toDecimal(spec.coins).toDecimalPlaces(2);
  const rupeeValue = toDecimal(spec.rupeeValue).toDecimalPlaces(2);

  if (coins.lessThanOrEqualTo(ZERO) && rupeeValue.lessThanOrEqualTo(ZERO)) {
    return {
      success: true,
      idempotencyKey,
      coins: '0',
      rupeeValue: '0',
    };
  }

  try {
    const existing = await prisma.extraCoinTransaction.findUnique({
      where: { idempotencyKey },
      select: { transactionId: true, coins: true, rupeeValue: true },
    });

    if (existing) {
      return {
        success: true,
        idempotencyKey,
        transactionId: existing.transactionId,
        coins: existing.coins.toString(),
        rupeeValue: existing.rupeeValue.toString(),
        duplicate: true,
      };
    }

    const expiresAt = spec.expiresAt ? new Date(spec.expiresAt) : undefined;

    await prisma.$transaction(async (tx) => {
      await tx.extraCoinTransaction.create({
        data: {
          transactionId: generateCoinTransactionId('earned'),
          userId: recipientUid,
          walletRole,
          type: 'earned',
          status: 'completed',
          coins,
          rupeeValue,
          remainingCoins: coins,
          remainingRupees: rupeeValue,
          expiresAt,
          taskId: spec.taskId,
          sourcePayoutId: spec.sourcePayoutId,
          idempotencyKey,
          metadata: {
            ...metadata,
            idempotencyKey,
          } as Prisma.JsonObject,
        },
      });

      await tx.extraCoinWallet.upsert({
        where: { userId_walletRole: { userId: recipientUid, walletRole } },
        update: {
          balanceCoins: { increment: coins },
          balanceRupees: { increment: rupeeValue },
          lifetimeEarnedCoins: { increment: coins },
          lastUpdatedAt: new Date(),
        },
        create: {
          userId: recipientUid,
          walletRole,
          balanceCoins: coins,
          balanceRupees: rupeeValue,
          lifetimeEarnedCoins: coins,
          lifetimeUsedCoins: ZERO,
          lastUpdatedAt: new Date(),
        },
      });
    });

    const row = await prisma.extraCoinTransaction.findUnique({
      where: { idempotencyKey },
      select: { transactionId: true },
    });

    logPaymentReferralCoins('wallet_credit_ok', {
      idempotencyKey,
      recipientUid,
      walletRole,
      source: metadata.source,
      coins: coins.toString(),
      rupeeValue: rupeeValue.toString(),
      transactionId: row?.transactionId,
    });
    logger.info('[GrantExecutor] Grant issued', {
      idempotencyKey,
      recipientUid,
      walletRole,
      source: metadata.source,
      coins: coins.toString(),
    });

    return {
      success: true,
      idempotencyKey,
      transactionId: row?.transactionId,
      coins: coins.toString(),
      rupeeValue: rupeeValue.toString(),
    };
  } catch (error: unknown) {
    const prismaError = error as { code?: string };
    if (prismaError.code === 'P2002') {
      const existing = await prisma.extraCoinTransaction.findUnique({
        where: { idempotencyKey },
        select: { transactionId: true, coins: true, rupeeValue: true },
      });
      if (existing) {
        return {
          success: true,
          idempotencyKey,
          transactionId: existing.transactionId,
          coins: existing.coins.toString(),
          rupeeValue: existing.rupeeValue.toString(),
          duplicate: true,
        };
      }
    }

    logPaymentReferralCoins(
      'issue_grant_item_error',
      {
        idempotencyKey,
        recipientUid,
        source: metadata.source,
        error: error instanceof Error ? error.message : String(error),
        prismaCode: prismaError.code,
      },
      'error'
    );
    logger.error('[GrantExecutor] issueGrant failed', { idempotencyKey, recipientUid, error });
    return {
      success: false,
      idempotencyKey,
      coins: '0',
      rupeeValue: '0',
      error: error instanceof Error ? error.message : 'Failed to issue grant',
    };
  }
}

export async function issueGrants(grants: GrantSpec[]): Promise<IssueGrantsResult> {
  const results: IssueGrantResult[] = [];
  for (const spec of grants) {
    results.push(await issueGrant(spec));
  }
  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const allOk = failed === 0;
  const partial = succeeded > 0 && failed > 0;
  return { success: allOk, partial, results };
}
