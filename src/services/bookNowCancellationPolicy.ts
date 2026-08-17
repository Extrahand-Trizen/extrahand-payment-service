/**
 * Book Now fixed cancellation fees (₹) by service family.
 * Post & Choose continues to use percentage-based fees in feeCalculationService.
 */

import { Prisma } from '@prisma/client';
import { getFeeStructure } from './feeConfigService';
import type { CancellationFeeResult } from './feeCalculationService';

export type BookNowPolicyGroup = 'home_cleaning' | 'ac_services' | 'appliance_repair';

export type BookNowCancellationTier =
  | 'free'
  | 'within_24h'
  | 'within_4h'
  | 'partner_reached';

const HOME_CLEANING_CATALOG_IDS = new Set([
  'full-house',
  'bathroom',
  'kitchen',
  'sofa',
  'mattress',
  'window-glass',
]);

const FLAT_FEES: Record<
  BookNowPolicyGroup,
  { within24h: number; within4h: number; partnerReached: number }
> = {
  home_cleaning: { within24h: 99, within4h: 199, partnerReached: 299 },
  ac_services: { within24h: 99, within4h: 149, partnerReached: 249 },
  appliance_repair: { within24h: 49, within4h: 99, partnerReached: 149 },
};

export function resolveBookNowPolicyGroup(catalogId?: string | null): BookNowPolicyGroup {
  const id = String(catalogId || '').trim().toLowerCase();
  if (id === 'ac-services') return 'ac_services';
  if (id === 'appliance-repair') return 'appliance_repair';
  if (HOME_CLEANING_CATALOG_IDS.has(id)) return 'home_cleaning';
  return 'home_cleaning';
}

export function resolveBookNowCancellationTier(params: {
  taskStartDate: Date;
  cancelledAt: Date;
  partnerReachedLocation?: boolean;
}): BookNowCancellationTier {
  if (params.partnerReachedLocation) return 'partner_reached';

  const hoursUntilStart =
    (params.taskStartDate.getTime() - params.cancelledAt.getTime()) / (1000 * 60 * 60);

  if (hoursUntilStart > 24) return 'free';
  if (hoursUntilStart > 4) return 'within_24h';
  return 'within_4h';
}

function flatFeeForTier(
  group: BookNowPolicyGroup,
  tier: BookNowCancellationTier,
): { feeRupees: number; policyKey: string } {
  const fees = FLAT_FEES[group];
  switch (tier) {
    case 'free':
      return { feeRupees: 0, policyKey: 'book_now_free' };
    case 'within_24h':
      return { feeRupees: fees.within24h, policyKey: 'book_now_within_24h' };
    case 'within_4h':
      return { feeRupees: fees.within4h, policyKey: 'book_now_within_4h' };
    case 'partner_reached':
      return { feeRupees: fees.partnerReached, policyKey: 'book_now_partner_reached' };
    default:
      return { feeRupees: 0, policyKey: 'book_now_free' };
  }
}

export async function calculateBookNowCancellationFee(params: {
  catalogId?: string | null;
  /** Captured / refundable amount in rupees for this line (includes GST when full order). */
  amount: number | Prisma.Decimal;
  taskStartDate: Date;
  cancelledAt: Date;
  partnerReachedLocation?: boolean;
  /**
   * Whether a Partner/Helper is actually assigned to the task.
   * When false, customer pays ₹0 fee and receives 100% of `amount` back.
   * When omitted, falls back to existing time-based tiers (legacy callers).
   */
  partnerAssigned?: boolean;
}): Promise<CancellationFeeResult & { policyKey: string; tier: BookNowCancellationTier }> {
  const feeStructure = await getFeeStructure();
  const originalAmount = new Prisma.Decimal(params.amount.toString());
  const group = resolveBookNowPolicyGroup(params.catalogId);

  // No partner assigned → full refund of amount paid (incl. GST portion in amount); no time fees.
  if (params.partnerAssigned === false) {
    const zero = new Prisma.Decimal('0.00');
    return {
      cancellationFee: zero,
      cancellationFeePercentage: 0,
      refundAmount: originalAmount.toDecimalPlaces(2),
      toOtherParty: zero,
      toPlatform: zero,
      policyKey: 'book_now_no_partner_assigned',
      tier: 'free',
      feeBreakdown: {
        originalAmount,
        cancellationFee: zero,
        refundAmount: originalAmount.toDecimalPlaces(2),
        toOtherParty: zero,
        toPlatform: zero,
      },
    };
  }

  const tier = resolveBookNowCancellationTier({
    taskStartDate: params.taskStartDate,
    cancelledAt: params.cancelledAt,
    partnerReachedLocation: params.partnerReachedLocation,
  });
  const { feeRupees, policyKey } = flatFeeForTier(group, tier);

  let cancellationFee = new Prisma.Decimal(feeRupees);
  if (cancellationFee.greaterThan(originalAmount)) {
    cancellationFee = originalAmount.toDecimalPlaces(2);
  }

  let refundAmount = originalAmount.sub(cancellationFee).toDecimalPlaces(2);
  if (refundAmount.lessThan(0)) {
    refundAmount = new Prisma.Decimal('0.00');
  }

  const cancellationFeePercentage = originalAmount.greaterThan(0)
    ? parseFloat(cancellationFee.div(originalAmount).toDecimalPlaces(4).toString())
    : 0;

  const toOtherParty = cancellationFee
    .mul(feeStructure.cancellationFees.distribution.toOtherParty)
    .toDecimalPlaces(2);
  const toPlatform = cancellationFee
    .mul(feeStructure.cancellationFees.distribution.toPlatform)
    .toDecimalPlaces(2);

  return {
    cancellationFee,
    cancellationFeePercentage,
    refundAmount,
    toOtherParty,
    toPlatform,
    policyKey,
    tier,
    feeBreakdown: {
      originalAmount,
      cancellationFee,
      refundAmount,
      toOtherParty,
      toPlatform,
    },
  };
}

export function describeBookNowCancellationPolicy(params: {
  catalogId?: string | null;
  tier: BookNowCancellationTier;
  cancellationFee: number | Prisma.Decimal;
}): { label: string; policyKey: string } {
  const group = resolveBookNowPolicyGroup(params.catalogId);
  const fee = Math.round(parseFloat(String(params.cancellationFee)) || 0);
  const tier = params.tier;

  if (tier === 'free' || fee <= 0) {
    return {
      label: 'Free cancellation — more than 24 hours before service',
      policyKey: 'book_now_free',
    };
  }

  const groupLabel =
    group === 'ac_services'
      ? 'AC Services'
      : group === 'appliance_repair'
        ? 'Appliance Repair'
        : 'Home Cleaning';

  if (tier === 'partner_reached') {
    return {
      label: `₹${fee} cancellation fee (${groupLabel}) — partner reached location`,
      policyKey: 'book_now_partner_reached',
    };
  }
  if (tier === 'within_4h') {
    return {
      label: `₹${fee} cancellation fee (${groupLabel}) — within 4 hours of service`,
      policyKey: 'book_now_within_4h',
    };
  }
  return {
    label: `₹${fee} cancellation fee (${groupLabel}) — within 24 hours of service`,
    policyKey: 'book_now_within_24h',
  };
}
