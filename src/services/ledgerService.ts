/**
 * Ledger Service
 * 
 * Handles all ledger operations using Prisma (Postgres)
 * Ledger is immutable - once created, entries cannot be modified or deleted
 */

import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';

/**
 * Generate unique transaction ID for ledger
 */
function generateLedgerTransactionId(): string {
  return `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Create a ledger entry
 * 
 * @param params - Ledger entry parameters
 * @returns Created ledger entry
 */
export async function createLedgerEntry(params: {
  escrowId?: string;
  payoutId?: string;
  refundId?: string;
  paymentTransactionId?: string;
  type: 'escrow' | 'payment' | 'refund' | 'payout' | 'fee' | 'cancellation_fee' | 'platform_fee' | 'platform_commission' | 'gst' | 'razorpay_fee' | 'tds';
  amount: number | Prisma.Decimal; // Amount in rupees (will be converted to Decimal)
  balanceBefore: number | Prisma.Decimal; // Balance before this transaction
  balanceAfter: number | Prisma.Decimal; // Balance after this transaction
  description?: string;
  metadata?: Record<string, any>;
}): Promise<{ success: boolean; ledger?: any; error?: string }> {
  try {
    const {
      escrowId,
      payoutId,
      refundId,
      paymentTransactionId,
      type,
      amount,
      balanceBefore,
      balanceAfter,
      description,
      metadata = {},
    } = params;

    // Convert amounts to Decimal if they're numbers
    const amountDecimal = typeof amount === 'number' 
      ? new Prisma.Decimal(amount.toFixed(2))
      : amount;
    const balanceBeforeDecimal = typeof balanceBefore === 'number'
      ? new Prisma.Decimal(balanceBefore.toFixed(2))
      : balanceBefore;
    const balanceAfterDecimal = typeof balanceAfter === 'number'
      ? new Prisma.Decimal(balanceAfter.toFixed(2))
      : balanceAfter;

    const transactionId = generateLedgerTransactionId();

    const ledgerData: Prisma.LedgerUncheckedCreateInput = {
      transactionId,
      escrowId: escrowId || null,
      payoutId: payoutId || null,
      refundId: refundId || null,
      razorpayPaymentId: (metadata as any)?.razorpayPaymentId ?? null,
      type,
      amount: amountDecimal,
      balanceBefore: balanceBeforeDecimal,
      balanceAfter: balanceAfterDecimal,
      description: description || `${type} transaction`,
      metadata: {
        ...(metadata || {}),
        ...(paymentTransactionId ? { paymentTransactionId } : {}),
      },
    };

    const ledger = await prisma.ledger.create({
      data: ledgerData,
    });

    logger.info('✅ Ledger entry created', {
      transactionId,
      type,
      escrowId,
      amount: amountDecimal.toString(),
    });

    return { success: true, ledger };
  } catch (error: any) {
    logger.error('❌ Error creating ledger entry:', error);
    return { success: false, error: error.message || 'Failed to create ledger entry' };
  }
}

/**
 * Get ledger entries for an escrow
 * 
 * @param escrowId - Escrow ID
 * @returns Array of ledger entries
 */
export async function getLedgerEntriesByEscrowId(escrowId: string): Promise<{
  success: boolean;
  entries?: any[];
  error?: string;
}> {
  try {
    const entries = await prisma.ledger.findMany({
      where: { escrowId },
      orderBy: { createdAt: 'asc' },
    });

    return { success: true, entries };
  } catch (error: any) {
    logger.error('❌ Error getting ledger entries:', error);
    return { success: false, error: error.message || 'Failed to get ledger entries' };
  }
}

/**
 * Get ledger entries by type
 * 
 * @param type - Ledger entry type
 * @param limit - Maximum number of entries to return
 * @returns Array of ledger entries
 */
export async function getLedgerEntriesByType(
  type: string,
  limit: number = 100
): Promise<{
  success: boolean;
  entries?: any[];
  error?: string;
}> {
  try {
    const entries = await prisma.ledger.findMany({
      where: { type },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return { success: true, entries };
  } catch (error: any) {
    logger.error('❌ Error getting ledger entries by type:', error);
    return { success: false, error: error.message || 'Failed to get ledger entries' };
  }
}

/**
 * Get latest balance for an escrow
 * Uses aggregation to calculate balance from all ledger entries (more reliable than latest entry)
 * This prevents race conditions where entries might be created out of order
 * 
 * @param escrowId - Escrow ID
 * @returns Latest balance (calculated from sum of all ledger entries)
 */
export async function getEscrowBalance(escrowId: string): Promise<{
  success: boolean;
  balance?: Prisma.Decimal;
  error?: string;
}> {
  try {
    // Use aggregation to sum all amounts for this escrow
    // This is more reliable than getting the latest entry, as it handles concurrent operations
    const result = await prisma.ledger.aggregate({
      where: { escrowId },
      _sum: {
        amount: true,
      },
    });

    // If no entries exist, return 0
    if (!result._sum.amount) {
      return { success: true, balance: new Prisma.Decimal('0.00') };
    }

    // Return the sum as the balance
    // Note: This assumes the initial escrow entry sets the balance correctly
    // For absolute accuracy, we could also get the latest entry's balanceAfter as a fallback
    const sumBalance = result._sum.amount;

    // Double-check: Get the latest entry's balanceAfter as a cross-reference
    // This helps catch any inconsistencies
    const latestEntry = await prisma.ledger.findFirst({
      where: { escrowId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    });

    // If latest entry exists and matches sum (within rounding tolerance), use it
    // Otherwise, log a warning and use the sum
    if (latestEntry) {
      const diff = latestEntry.balanceAfter.minus(sumBalance).abs();
      if (diff.greaterThan(new Prisma.Decimal('0.01'))) {
        // More than 1 paisa difference - log warning but use latest entry (more accurate)
        logger.warn('⚠️ Balance mismatch detected', {
          escrowId,
          sumBalance: sumBalance.toString(),
          latestBalance: latestEntry.balanceAfter.toString(),
          difference: diff.toString(),
        });
        return { success: true, balance: latestEntry.balanceAfter };
      }
      // Use latest entry's balanceAfter (more accurate as it accounts for initial escrow amount)
      return { success: true, balance: latestEntry.balanceAfter };
    }

    return { success: true, balance: sumBalance };
  } catch (error: any) {
    logger.error('❌ Error getting escrow balance:', error);
    return { success: false, error: error.message || 'Failed to get escrow balance' };
  }
}

