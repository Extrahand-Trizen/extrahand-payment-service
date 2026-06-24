import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { getCategoryLookupKeys } from './feeConfigService';

export type BookNowGstLineInput = {
  categorySlug: string;
  lineTotal: number;
};

export type BookNowCategoryGstBreakdown = {
  categoryKey: string;
  subtotal: number;
  gstPercentage: number;
  gstAmount: number;
};

export type BookNowOrderTotals = {
  subtotal: number;
  addonsTotal: number;
  platformFee: number;
  gst: number;
  total: number;
  categories: BookNowCategoryGstBreakdown[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const effectiveDateFilter = (now: Date) => ({
  OR: [
    { effectiveFrom: null, effectiveTo: null },
    { effectiveFrom: { lte: now }, effectiveTo: null },
    { effectiveFrom: { lte: now }, effectiveTo: { gte: now } },
  ],
});

async function loadGstPercentageForCategory(categoryKey: string): Promise<number | null> {
  const lookupKeys = getCategoryLookupKeys(categoryKey);
  const now = new Date();

  for (const key of lookupKeys) {
    const cfg = await prisma.categoryFeeConfig.findFirst({
      where: {
        categoryKey: key,
        ...effectiveDateFilter(now),
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    if (cfg?.gstPercentage != null && cfg.gstPercentage !== undefined) {
      return Number(cfg.gstPercentage);
    }
  }

  return null;
}

async function resolveBookNowGstPercentage(categoryKey: string): Promise<number> {
  const resolved = await loadGstPercentageForCategory(categoryKey);
  if (resolved != null && Number.isFinite(resolved)) {
    return resolved;
  }

  const defaultRate = await loadGstPercentageForCategory('default');
  if (defaultRate != null && Number.isFinite(defaultRate)) {
    return defaultRate;
  }

  return 0;
}

/**
 * Book Now customer totals: GST on service subtotal per category (no platform fee).
 * Tasker payout must use line service amounts only — not this total.
 */
export async function calculateBookNowOrderTotals(
  lines: BookNowGstLineInput[],
): Promise<BookNowOrderTotals> {
  const byCategory = new Map<string, number>();

  for (const line of lines) {
    const categoryKey = String(line.categorySlug || 'default').trim().toLowerCase();
    if (!categoryKey) continue;
    const lineTotal = Number(line.lineTotal);
    if (!Number.isFinite(lineTotal) || lineTotal <= 0) continue;
    byCategory.set(categoryKey, round2((byCategory.get(categoryKey) || 0) + lineTotal));
  }

  const categories: BookNowCategoryGstBreakdown[] = [];
  let subtotal = 0;
  let totalGst = 0;

  for (const [categoryKey, categorySubtotal] of byCategory.entries()) {
    subtotal = round2(subtotal + categorySubtotal);
    const gstPercentage = await resolveBookNowGstPercentage(categoryKey);
    const gstAmount = round2(categorySubtotal * gstPercentage);
    totalGst = round2(totalGst + gstAmount);
    categories.push({
      categoryKey,
      subtotal: categorySubtotal,
      gstPercentage,
      gstAmount,
    });
  }

  categories.sort((a, b) => a.categoryKey.localeCompare(b.categoryKey));

  const result: BookNowOrderTotals = {
    subtotal: round2(subtotal),
    addonsTotal: 0,
    platformFee: 0,
    gst: round2(totalGst),
    total: round2(subtotal + totalGst),
    categories,
  };

  logger.debug('[bookNowGst] calculated order totals', {
    lineCount: lines.length,
    categoryCount: categories.length,
    subtotal: result.subtotal,
    gst: result.gst,
    total: result.total,
  });

  return result;
}
