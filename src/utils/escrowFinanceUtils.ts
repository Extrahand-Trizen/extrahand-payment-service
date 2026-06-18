import { Prisma } from '@prisma/client';

type EscrowAmountSource = {
  taskAmount?: unknown;
  amountInRupees?: unknown;
  metadata?: unknown;
  appliedPlatformFeePercent?: unknown;
  appliedGstPercent?: unknown;
};

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

function readMetadataRecord(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

function readAmountBreakdown(metadata: Record<string, unknown>): Record<string, unknown> {
  const amountBreakdown = metadata.amountBreakdown;
  return amountBreakdown &&
    typeof amountBreakdown === 'object' &&
    !Array.isArray(amountBreakdown)
    ? (amountBreakdown as Record<string, unknown>)
    : {};
}

function isRecurringVisitEscrow(metadata: Record<string, unknown>): boolean {
  return (
    metadata.recurringPlan === true ||
    (typeof metadata.visitId === 'string' && metadata.visitId.trim().length > 0)
  );
}

/**
 * Post & Choose recurring visits charge the visit budget only (no platform fee at booking).
 * Reverse-engineering Razorpay capture with fee multipliers would underpay the tasker.
 */
function customerPaidPlatformFeeAtBooking(
  metadata: Record<string, unknown>,
  amountBreakdown: Record<string, unknown>,
): boolean {
  if (isRecurringVisitEscrow(metadata)) {
    return false;
  }

  const platformFeeAtBooking =
    toDecimal(amountBreakdown.platformFee) ??
    toDecimal(amountBreakdown.platformFeeTotal);
  if (platformFeeAtBooking) {
    return platformFeeAtBooking.greaterThan(0);
  }

  const gstAtBooking = toDecimal(amountBreakdown.gst) ?? toDecimal(amountBreakdown.platformFeeGst);
  if (gstAtBooking) {
    return gstAtBooking.greaterThan(0);
  }

  return true;
}

/**
 * Resolve the task budget (performer payout base) from escrow — not what Razorpay captured.
 * Matches transaction history logic so recurring per-visit payouts align with normal tasks.
 */
export function resolveEscrowTaskAmountForPayout(
  escrow: EscrowAmountSource | null | undefined,
  fallbackAmount?: number | string | Prisma.Decimal,
): Prisma.Decimal {
  if (!escrow) {
    const fallback = toDecimal(fallbackAmount);
    return fallback ?? new Prisma.Decimal('0.00');
  }

  const escrowMeta = readMetadataRecord(escrow.metadata);
  const amountBreakdown = readAmountBreakdown(escrowMeta);

  const totalPaid = toDecimal(escrow.amountInRupees);
  const extraCoinsDiscount =
    toDecimal(escrowMeta.pendingCustomerCoinDiscountRupees) ||
    toDecimal(escrowMeta.customerCoinDiscountRupees) ||
    toDecimal(amountBreakdown.extraCoinsDiscount) ||
    new Prisma.Decimal('0');

  const configuredPlatformPct = normalizePercent(toDecimal(escrow.appliedPlatformFeePercent));
  const configuredGstPct = normalizePercent(toDecimal(escrow.appliedGstPercent));
  const chargePlatformFeeAtBooking = customerPaidPlatformFeeAtBooking(
    escrowMeta,
    amountBreakdown,
  );

  const derivedFromTotalPaid = (() => {
    if (!totalPaid || !configuredPlatformPct || !chargePlatformFeeAtBooking) return null;
    const gstPct = configuredGstPct || new Prisma.Decimal('0');
    const multiplier = new Prisma.Decimal('1').plus(
      configuredPlatformPct.mul(new Prisma.Decimal('1').plus(gstPct)),
    );
    if (multiplier.lessThanOrEqualTo(0)) return null;
    return totalPaid.div(multiplier).toDecimalPlaces(2);
  })();

  const visitBudgetAmount =
    toDecimal(escrowMeta.visitBudgetRupees) ||
    toDecimal(escrowMeta.originalAmountRupees) ||
    toDecimal(amountBreakdown.taskAmount) ||
    toDecimal(escrowMeta.taskAmount);

  const resolved =
    toDecimal(escrow.taskAmount) ||
    visitBudgetAmount ||
    (extraCoinsDiscount.greaterThan(0) && totalPaid
      ? totalPaid.plus(extraCoinsDiscount).toDecimalPlaces(2)
      : null) ||
    derivedFromTotalPaid ||
    totalPaid ||
    toDecimal(fallbackAmount);

  return resolved ?? new Prisma.Decimal('0.00');
}
