import dotenv from 'dotenv';
import { Prisma } from '@prisma/client';
import { prisma, disconnectPrisma } from '../config/prisma';
import { getFeeStructure } from '../services/feeConfigService';
import { resolveEscrowTaskAmountForPayout } from '../utils/escrowFinanceUtils';

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (value == null) return null;
  try {
    const decimal = new Prisma.Decimal(String(value));
    return decimal.greaterThan(0) ? decimal : null;
  } catch {
    return null;
  }
}

function normalizePercent(value: Prisma.Decimal | null): Prisma.Decimal | null {
  if (!value) return null;
  const one = new Prisma.Decimal('1');
  const hundred = new Prisma.Decimal('100');
  return value.greaterThan(one) ? value.div(hundred) : value;
}

dotenv.config();

const ESCROW_ID = process.argv[2] || 'escrow_1782100409517_73wku5g';

async function main() {
  try {
    const escrow = await prisma.escrow.findUnique({ where: { escrowId: ESCROW_ID } });
    if (!escrow) {
      console.log('Escrow not found');
      return;
    }

    const meta =
      escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
        ? (escrow.metadata as Record<string, unknown>)
        : {};
    const breakdown =
      meta.amountBreakdown &&
      typeof meta.amountBreakdown === 'object' &&
      !Array.isArray(meta.amountBreakdown)
        ? (meta.amountBreakdown as Record<string, unknown>)
        : {};

    const grossAmount = resolveEscrowTaskAmountForPayout(escrow).toDecimalPlaces(2);
    const feeStructure = await getFeeStructure();

    const platformPct = normalizePercent(toDecimal(escrow.appliedPlatformFeePercent))
      ?? new Prisma.Decimal(String(feeStructure.platformFee.percentage));
    const gstPct = normalizePercent(toDecimal(escrow.appliedGstPercent))
      ?? new Prisma.Decimal(String(feeStructure.platformFee.gstPercentage));

    const platformCommission = grossAmount.mul(platformPct).toDecimalPlaces(2);
    const gstOnCommission = platformCommission.mul(gstPct).toDecimalPlaces(2);
    const platformFeeTotal = platformCommission.add(gstOnCommission).toDecimalPlaces(2);
    const payoutBaseAmount = Prisma.Decimal.max(
      grossAmount.sub(platformFeeTotal).toDecimalPlaces(2),
      new Prisma.Decimal('0.00')
    );

    console.log('=== Payout calculation preview (AC Diagnosis) ===');
    console.log({
      escrowId: escrow.escrowId,
      taskId: escrow.taskId,
      taskCategory: escrow.taskCategory,
      customerPaid: escrow.amountInRupees.toString(),
      escrowTaskAmount: escrow.taskAmount?.toString() ?? null,
      resolvedGrossPayoutBase: grossAmount.toString(),
      appliedPlatformFeePercent: escrow.appliedPlatformFeePercent?.toString() ?? null,
      appliedGstPercent: escrow.appliedGstPercent?.toString() ?? null,
      metadataAmountBreakdown: breakdown,
      bookingMode: meta.bookingMode ?? null,
    });

    console.log('\n--- Fee config used (from escrow snapshot or system default) ---');
    console.log({
      platformFeePercent: platformPct.toString(),
      gstOnPlatformFeePercent: gstPct.toString(),
    });

    console.log('\n--- Expected payout breakdown (task completion path) ---');
    console.log({
      grossTaskAmount: grossAmount.toString(),
      platformCommission: platformCommission.toString(),
      gstOnCommission: gstOnCommission.toString(),
      platformFeeTotal: platformFeeTotal.toString(),
      tds: '0.00 (task completion path sets TDS to 0)',
      extraCoinsBonus: '0.00 (unless tasker redeems coins at payout)',
      penaltyDeductions: '0.00 (unless pending cancellation penalties)',
      netPayoutToBank: payoutBaseAmount.toString(),
    });

    console.log('\n--- Reverse check: customer paid vs task amount ---');
    const totalPaid = new Prisma.Decimal(escrow.amountInRupees.toString());
    const inferredTaskFromPaid = (() => {
      const multiplier = new Prisma.Decimal('1').plus(platformPct.mul(new Prisma.Decimal('1').plus(gstPct)));
      return totalPaid.div(multiplier).toDecimalPlaces(2).toString();
    })();
    console.log({
      customerPaid: totalPaid.toString(),
      inferredBaseTaskFromPaid: inferredTaskFromPaid,
      note: 'Poster pays taskAmount + platformFee + GST on platform fee',
    });
  } finally {
    await disconnectPrisma();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
