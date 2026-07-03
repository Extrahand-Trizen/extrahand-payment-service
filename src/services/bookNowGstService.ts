import { CategoryFeeMode ,Prisma} from '@prisma/client';
import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { getCategoryLookupKeys } from './feeConfigService';

const BOOK_NOW_MODE = CategoryFeeMode.BOOK_NOW;

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

const GST_CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_GST_PERCENTAGE = parseFloat(process.env.GST_PERCENTAGE || '0.18');

const gstCache = new Map<string, { value: number | null; timestamp: number }>();

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPrismaUnreachable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P1001' || error.code === 'P1017')
  );
}

async function withDbRetry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isPrismaUnreachable(error) || attempt === retries) {
        throw error;
      }
      const delayMs = 750 * (attempt + 1);
      logger.warn('[bookNowGst] Postgres unreachable, retrying', {
        attempt: attempt + 1,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

const effectiveDateFilter = (now: Date) => ({
  OR: [
    { effectiveFrom: null, effectiveTo: null },
    { effectiveFrom: { lte: now }, effectiveTo: null },
    { effectiveFrom: { lte: now }, effectiveTo: { gte: now } },
  ],
});

async function findGstPercentageForKey(
  key: string,
  mode: CategoryFeeMode,
  now: Date,
): Promise<number | null> {
  const cfg = await withDbRetry(() =>
    prisma.categoryFeeConfig.findFirst({
      where: {
        categoryKey: key,
        mode,
        ...effectiveDateFilter(now),
      },
      orderBy: { effectiveFrom: 'desc' },
    }),
  );

  if (cfg?.gstPercentage != null && cfg.gstPercentage !== undefined) {
    return Number(cfg.gstPercentage);
  }
  return null;
}

async function queryGstPercentageForCategory(categoryKey: string): Promise<number | null> {
  const lookupKeys = getCategoryLookupKeys(categoryKey);
  const now = new Date();

  for (const key of lookupKeys) {
    const bookNowRate = await findGstPercentageForKey(key, BOOK_NOW_MODE, now);
    if (bookNowRate != null) return bookNowRate;

    // Deployed prod may only have BIDDING rows (e.g. home-cleaning @ 5%) until BOOK_NOW is seeded.
    const biddingRate = await findGstPercentageForKey(key, CategoryFeeMode.BIDDING, now);
    if (biddingRate != null) return biddingRate;
  }

  if (categoryKey !== 'default') {
    const defaultCfg = await withDbRetry(() =>
      prisma.categoryFeeConfig.findUnique({
        where: {
          categoryKey_mode: { categoryKey: 'default', mode: CategoryFeeMode.BOOK_NOW },
        },
      }),
    );
    if (defaultCfg?.gstPercentage != null && defaultCfg.gstPercentage !== undefined) {
      return Number(defaultCfg.gstPercentage);
    }
  }

  return null;
}

async function loadGstPercentageForCategory(categoryKey: string): Promise<number | null> {
  const cacheKey = categoryKey.trim().toLowerCase() || 'default';
  const cached = gstCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < GST_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const value = await queryGstPercentageForCategory(cacheKey);
    gstCache.set(cacheKey, { value, timestamp: Date.now() });
    return value;
  } catch (error) {
    if (cached) {
      logger.warn('[bookNowGst] using stale GST cache after DB error', { cacheKey });
      return cached.value;
    }
    throw error;
  }
}

async function resolveBookNowGstPercentage(categoryKey: string): Promise<number> {
  try {
    const resolved = await loadGstPercentageForCategory(categoryKey);
    if (resolved != null && Number.isFinite(resolved)) {
      return resolved;
    }

    if (categoryKey !== 'default') {
      const defaultRate = await loadGstPercentageForCategory('default');
      if (defaultRate != null && Number.isFinite(defaultRate)) {
        return defaultRate;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('[bookNowGst] falling back to default GST after DB error', {
      categoryKey,
      message,
    });
  }

  return Number.isFinite(FALLBACK_GST_PERCENTAGE) ? FALLBACK_GST_PERCENTAGE : 0;
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
