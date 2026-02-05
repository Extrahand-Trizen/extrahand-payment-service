import logger from '../config/logger';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';

/**
 * Fee structure configuration interface
 */
export interface FeeStructure {
  // Platform fees (charged to both poster and performer)
  platformFee: {
    percentage: number; // 10-15% (constant)
    gstPercentage: number; // 18% GST on platform fee
  };

  // Processing fees (split 50-50 between poster and performer)
  processingFees: {
    razorpayFeePercentage: number; // 2% of task amount
    razorpayFeeGstPercentage: number; // 18% GST on Razorpay fee
    tdsPercentage: number; // 5% TDS on platform commission
    splitRatio: {
      poster: number; // 0.5 (50%)
      performer: number; // 0.5 (50%)
    };
  };

  // Cancellation fees
  cancellationFees: {
    gracePeriodHours: number; // 24 hours
    early: number; // 5%
    medium: number; // 10%
    late: number; // 20%
    veryLate: number; // 30%
    distribution: {
      toOtherParty: number; // 0.7 (70%)
      toPlatform: number; // 0.3 (30%)
    };
  };
}

/**
 * Default fee structure (used as fallback)
 */
const DEFAULT_FEE_STRUCTURE: FeeStructure = {
  platformFee: {
    percentage: parseFloat(process.env.PLATFORM_FEE_PERCENTAGE || '0.10'), // 10%
    gstPercentage: parseFloat(process.env.GST_PERCENTAGE || '0.18'), // 18%
  },
  processingFees: {
    razorpayFeePercentage: parseFloat(process.env.RAZORPAY_FEE_PERCENTAGE || '0.02'), // 2%
    razorpayFeeGstPercentage: parseFloat(process.env.GST_PERCENTAGE || '0.18'), // 18%
    tdsPercentage: parseFloat(process.env.TDS_PERCENTAGE || '0.05'), // 5%
    splitRatio: {
      poster: 0.5, // 50%
      performer: 0.5, // 50%
    },
  },
  cancellationFees: {
    gracePeriodHours: parseFloat(process.env.CANCELLATION_GRACE_PERIOD_HOURS || '24'),
    early: parseFloat(process.env.CANCELLATION_FEE_EARLY || '0.05'), // 5%
    medium: parseFloat(process.env.CANCELLATION_FEE_MEDIUM || '0.10'), // 10%
    late: parseFloat(process.env.CANCELLATION_FEE_LATE || '0.20'), // 20%
    veryLate: parseFloat(process.env.CANCELLATION_FEE_VERY_LATE || '0.30'), // 30%
    distribution: {
      toOtherParty: 0.7, // 70%
      toPlatform: 0.3, // 30%
    },
  },
};

/**
 * Cache for fee structure (to avoid repeated DB queries)
 */
let feeStructureCache: FeeStructure | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get fee structure from SystemConfig table
 * Falls back to environment variables if not found
 */
export async function getFeeStructure(): Promise<FeeStructure> {
  // Check cache first
  const now = Date.now();
  if (feeStructureCache && (now - cacheTimestamp) < CACHE_TTL) {
    return feeStructureCache;
  }

  try {
    // Try to get from SystemConfig
    const config = await prisma.systemConfig.findUnique({
      where: { configKey: 'fee_structure' },
    });

    if (config && config.configValue) {
      // Parse JSON config value
      const feeStructure = config.configValue as unknown as FeeStructure;
      
      // Validate structure
      if (isValidFeeStructure(feeStructure)) {
        feeStructureCache = feeStructure;
        cacheTimestamp = now;
        logger.debug('✅ Fee structure loaded from SystemConfig');
        return feeStructure;
      } else {
        logger.warn('⚠️ Invalid fee structure in SystemConfig, using defaults');
      }
    } else {
      logger.debug('ℹ️ Fee structure not found in SystemConfig, using defaults');
    }
  } catch (error: any) {
    logger.warn(`⚠️ Error loading fee structure from SystemConfig: ${error.message}, using defaults`);
  }

  // Fallback to defaults (from env or hardcoded)
  feeStructureCache = DEFAULT_FEE_STRUCTURE;
  cacheTimestamp = now;
  return DEFAULT_FEE_STRUCTURE;
}

/**
 * Validate fee structure
 */
function isValidFeeStructure(structure: any): structure is FeeStructure {
  return (
    structure &&
    typeof structure.platformFee === 'object' &&
    typeof structure.platformFee.percentage === 'number' &&
    typeof structure.platformFee.gstPercentage === 'number' &&
    typeof structure.processingFees === 'object' &&
    typeof structure.processingFees.razorpayFeePercentage === 'number' &&
    typeof structure.processingFees.splitRatio === 'object' &&
    typeof structure.processingFees.splitRatio.poster === 'number' &&
    typeof structure.processingFees.splitRatio.performer === 'number' &&
    typeof structure.cancellationFees === 'object'
  );
}

/**
 * Clear fee structure cache (useful after updating SystemConfig)
 */
export function clearFeeStructureCache(): void {
  feeStructureCache = null;
  cacheTimestamp = 0;
  logger.debug('🗑️ Fee structure cache cleared');
}

/**
 * Update fee structure in SystemConfig
 */
export async function updateFeeStructure(
  feeStructure: FeeStructure,
  updatedBy?: string
): Promise<void> {
  try {
    await prisma.systemConfig.upsert({
      where: { configKey: 'fee_structure' },
      update: {
        configValue: feeStructure as any,
        description: 'Fee structure configuration (platform fees, processing fees, cancellation fees)',
        category: 'fees',
        updatedBy,
        updatedAt: new Date(),
      },
      create: {
        configKey: 'fee_structure',
        configValue: feeStructure as any,
        description: 'Fee structure configuration (platform fees, processing fees, cancellation fees)',
        category: 'fees',
        updatedBy,
      },
    });

    // Clear cache to force reload
    clearFeeStructureCache();
    logger.info('✅ Fee structure updated in SystemConfig');
  } catch (error: any) {
    logger.error(`❌ Error updating fee structure: ${error.message}`);
    throw error;
  }
}

/**
 * Initialize default fee structure in SystemConfig (if not exists)
 */
export async function initializeDefaultFeeStructure(): Promise<void> {
  try {
    const existing = await prisma.systemConfig.findUnique({
      where: { configKey: 'fee_structure' },
    });

    if (existing) {
      logger.info('ℹ️ Fee structure already exists in SystemConfig');
      return;
    }

    await updateFeeStructure(DEFAULT_FEE_STRUCTURE);
    logger.info('✅ Default fee structure initialized in SystemConfig');
  } catch (error: any) {
    logger.error(`❌ Error initializing fee structure: ${error.message}`);
    throw error;
  }
}

/**
 * Get fee structure merged with per-category overrides.
 * Falls back to base getFeeStructure() when no category config is found.
 */
export async function getFeeStructureForCategory(categoryKey?: string): Promise<FeeStructure> {
  const base = await getFeeStructure();

  const key = categoryKey || 'default';

  try {
    const now = new Date();

    const cfg = await prisma.categoryFeeConfig.findFirst({
      where: {
        categoryKey: key,
        OR: [
          { effectiveFrom: null, effectiveTo: null },
          { effectiveFrom: { lte: now }, effectiveTo: null },
          { effectiveFrom: { lte: now }, effectiveTo: { gte: now } },
        ],
      },
      orderBy: { effectiveFrom: 'desc' },
    }) as any;

    // If not found, try to load the default row
    const effectiveCfg = cfg ?? (await prisma.categoryFeeConfig.findUnique({ where: { categoryKey: 'default' } }) as any);

    if (!effectiveCfg) return base;

    // Convert Decimal fields (if present) to numbers
    const cfgGst = effectiveCfg.gstPercentage !== null && effectiveCfg.gstPercentage !== undefined
      ? Number(effectiveCfg.gstPercentage)
      : undefined;

    const cfgPlatform = effectiveCfg.platformFeePercentage !== null && effectiveCfg.platformFeePercentage !== undefined
      ? Number(effectiveCfg.platformFeePercentage)
      : undefined;

    const cfgRazorpayGst = effectiveCfg.razorpayFeeGstPercentage !== null && effectiveCfg.razorpayFeeGstPercentage !== undefined
      ? Number(effectiveCfg.razorpayFeeGstPercentage)
      : undefined;

    return {
      ...base,
      platformFee: {
        ...base.platformFee,
        percentage: cfgPlatform ?? base.platformFee.percentage,
        gstPercentage: cfgGst ?? base.platformFee.gstPercentage,
      },
      processingFees: {
        ...base.processingFees,
        razorpayFeeGstPercentage: cfgRazorpayGst ?? base.processingFees.razorpayFeeGstPercentage,
      },
    };
  } catch (error: any) {
    logger.warn(`⚠️ Error loading CategoryFeeConfig for '${categoryKey}': ${error.message}`);
    return base;
  }
}

/**
 * List all category fee configs (for admin UI)
 */
export async function listCategoryFeeConfigs(): Promise<any[]> {
  return await prisma.categoryFeeConfig.findMany({ orderBy: { categoryKey: 'asc' } }) as any[];
}

/**
 * Upsert category fee config row
 */
export async function upsertCategoryFeeConfig(payload: any, updatedBy?: string): Promise<any> {
  const { categoryKey } = payload;
  if (!categoryKey) throw new Error('categoryKey is required');

  const data = {
    categoryKey,
    displayName: payload.displayName ?? null,
    gstPercentage: payload.gstPercentage ?? undefined,
    platformFeePercentage: payload.platformFeePercentage ?? undefined,
    razorpayFeeGstPercentage: payload.razorpayFeeGstPercentage ?? undefined,
    minPrice: payload.minPrice ?? undefined,
    maxPrice: payload.maxPrice ?? undefined,
    effectiveFrom: payload.effectiveFrom ? new Date(payload.effectiveFrom) : undefined,
    effectiveTo: payload.effectiveTo ? new Date(payload.effectiveTo) : undefined,
    updatedBy: updatedBy ?? payload.updatedBy ?? null,
  } as any;

  const result = await prisma.categoryFeeConfig.upsert({
    where: { categoryKey },
    create: { ...data },
    update: { ...data },
  });

  // Clear fee structure cache so changes take effect immediately
  clearFeeStructureCache();

  return result;
}


