/**
 * Fee Calculation Service
 * 
 * Calculates all fees (Razorpay fees, platform commission, GST, TDS, cancellation fees)
 * Uses configurable fee structure from SystemConfig (with env variable fallback)
 * Supports separate fee calculations for poster and performer
 */

import logger from '../config/logger';
import { Prisma } from '@prisma/client';
import { getFeeStructure, getFeeStructureForCategory } from './feeConfigService';

/**
 * Fee calculation result interface (for performer - legacy support)
 */
export interface FeeBreakdown {
  // Original amounts
  originalAmount: Prisma.Decimal; // Original amount in rupees
  originalAmountInPaise: number; // Original amount in paise

  // Razorpay fees
  razorpayFee: Prisma.Decimal; // Razorpay fee in rupees
  razorpayFeeGst: Prisma.Decimal; // GST on Razorpay fee
  razorpayFeeTotal: Prisma.Decimal; // Razorpay fee + GST

  // Platform fees
  platformCommission: Prisma.Decimal; // Platform commission in rupees
  platformCommissionGst: Prisma.Decimal; // GST on platform commission
  platformCommissionTotal: Prisma.Decimal; // Platform commission + GST

  // Tax deductions
  tds: Prisma.Decimal; // TDS in rupees (if applicable)

  // Net amounts
  netAmount: Prisma.Decimal; // Amount after all fees (for payout)
  totalFees: Prisma.Decimal; // Total fees deducted

  // Cancellation fees (if applicable)
  cancellationFee?: Prisma.Decimal;
  cancellationFeePercentage?: number;

  // Metadata
  metadata: {
    razorpayFeePercentage: number;
    platformCommissionPercentage: number;
    gstPercentage: number;
    tdsPercentage: number;
    cancellationFeePercentage?: number;
  };
}

/**
 * Poster fee breakdown (what poster pays upfront)
 */
export interface PosterFeeBreakdown {
  taskAmount: Prisma.Decimal; // Original task amount
  platformFee: Prisma.Decimal; // Platform service fee (10-15%)
  platformFeeGst: Prisma.Decimal; // GST on platform fee
  platformFeeTotal: Prisma.Decimal; // Platform fee + GST
  
  // Processing fees (50% of total processing fees)
  processingFeeShare: Prisma.Decimal; // Poster's share of processing fees (50%)
  processingFeeGst: Prisma.Decimal; // GST on processing fee share
  processingFeeTotal: Prisma.Decimal; // Processing fee share + GST
  
  // Total amount poster needs to pay
  totalAmount: Prisma.Decimal; // Task amount + all fees
  
  // Metadata
  metadata: {
    platformFeePercentage: number;
    processingFeeSplitRatio: number; // 0.5 (50%)
    gstPercentage: number;
  };
}

/**
 * Performer fee breakdown (what performer gets after deductions)
 */
export interface PerformerFeeBreakdown {
  taskAmount: Prisma.Decimal; // Original task amount
  platformFee: Prisma.Decimal; // Platform service fee (10-15%)
  platformFeeGst: Prisma.Decimal; // GST on platform fee
  platformFeeTotal: Prisma.Decimal; // Platform fee + GST
  
  // Processing fees (50% of total processing fees)
  processingFeeShare: Prisma.Decimal; // Performer's share of processing fees (50%)
  processingFeeGst: Prisma.Decimal; // GST on processing fee share
  processingFeeTotal: Prisma.Decimal; // Processing fee share + GST
  
  // TDS (on platform commission)
  tds: Prisma.Decimal; // TDS in rupees
  
  // Net amount performer receives
  netAmount: Prisma.Decimal; // Task amount - all deductions
  totalDeductions: Prisma.Decimal; // Total deductions
  
  // Metadata
  metadata: {
    platformFeePercentage: number;
    processingFeeSplitRatio: number; // 0.5 (50%)
    gstPercentage: number;
    tdsPercentage: number;
  };
}

/**
 * Cancellation fee calculation result
 */
export interface CancellationFeeResult {
  cancellationFee: Prisma.Decimal;
  cancellationFeePercentage: number;
  refundAmount: Prisma.Decimal;
  toOtherParty: Prisma.Decimal; // Amount to other party (compensation)
  toPlatform: Prisma.Decimal; // Amount to platform
  feeBreakdown: {
    originalAmount: Prisma.Decimal;
    cancellationFee: Prisma.Decimal;
    refundAmount: Prisma.Decimal;
    toOtherParty: Prisma.Decimal;
    toPlatform: Prisma.Decimal;
  };
}

/**
 * Get fee percentages from environment variables (with defaults for testing)
 * @deprecated Use getFeeStructure() from feeConfigService instead
 */
function getFeePercentages() {
  return {
    razorpayFee: parseFloat(process.env.RAZORPAY_FEE_PERCENTAGE || '0.02'), // 2%
    platformCommission: parseFloat(process.env.PLATFORM_COMMISSION_PERCENTAGE || '0.05'), // 5%
    gst: parseFloat(process.env.GST_PERCENTAGE || '0.18'), // 18%
    tds: parseFloat(process.env.TDS_PERCENTAGE || '0.05'), // 5%
    cancellationFeeEarly: parseFloat(process.env.CANCELLATION_FEE_EARLY || '0.05'), // 5%
    cancellationFeeMedium: parseFloat(process.env.CANCELLATION_FEE_MEDIUM || '0.10'), // 10%
    cancellationFeeLate: parseFloat(process.env.CANCELLATION_FEE_LATE || '0.20'), // 20%
    cancellationFeeVeryLate: parseFloat(process.env.CANCELLATION_FEE_VERY_LATE || '0.30'), // 30%
  };
}

/**
 * Calculate poster fees (what poster pays upfront)
 * Uses category-specific fee structure when taskCategory is provided (CategoryFeeConfig).
 *
 * @param taskAmount - Task amount in rupees
 * @param taskCategory - Optional task category key for category-specific GST/fees (e.g. from CategoryFeeConfig)
 * @returns Poster fee breakdown
 */
export async function calculatePosterFees(
  taskAmount: number | Prisma.Decimal,
  taskCategory?: string
): Promise<PosterFeeBreakdown> {
  const feeStructure = taskCategory
    ? await getFeeStructureForCategory(taskCategory)
    : await getFeeStructure();
  const taskAmountDecimal = new Prisma.Decimal(taskAmount.toString());

  // Calculate platform fee (10-15% of task amount)
  const platformFee = taskAmountDecimal.mul(feeStructure.platformFee.percentage).toDecimalPlaces(2);
  const platformFeeGst = platformFee.mul(feeStructure.platformFee.gstPercentage).toDecimalPlaces(2);
  const platformFeeTotal = platformFee.add(platformFeeGst).toDecimalPlaces(2);

  // Calculate total processing fees (Razorpay fee + GST)
  const razorpayFee = taskAmountDecimal.mul(feeStructure.processingFees.razorpayFeePercentage).toDecimalPlaces(2);
  const razorpayFeeGst = razorpayFee.mul(feeStructure.processingFees.razorpayFeeGstPercentage).toDecimalPlaces(2);
  const totalProcessingFees = razorpayFee.add(razorpayFeeGst).toDecimalPlaces(2);

  // Poster pays 50% of processing fees
  const processingFeeShare = totalProcessingFees.mul(feeStructure.processingFees.splitRatio.poster).toDecimalPlaces(2);
  const processingFeeGst = processingFeeShare.mul(feeStructure.processingFees.razorpayFeeGstPercentage).toDecimalPlaces(2);
  const processingFeeTotal = processingFeeShare.add(processingFeeGst).toDecimalPlaces(2);

  // Total amount poster needs to pay
  const totalAmount = taskAmountDecimal.add(platformFeeTotal).add(processingFeeTotal).toDecimalPlaces(2);

  return {
    taskAmount: taskAmountDecimal,
    platformFee,
    platformFeeGst,
    platformFeeTotal,
    processingFeeShare,
    processingFeeGst,
    processingFeeTotal,
    totalAmount,
    metadata: {
      platformFeePercentage: feeStructure.platformFee.percentage,
      processingFeeSplitRatio: feeStructure.processingFees.splitRatio.poster,
      gstPercentage: feeStructure.platformFee.gstPercentage,
    },
  };
}

/**
 * Calculate performer fees (what performer gets after deductions)
 * 
 * @param taskAmount - Task amount in rupees
 * @returns Performer fee breakdown
 */
export async function calculatePerformerFees(taskAmount: number | Prisma.Decimal): Promise<PerformerFeeBreakdown> {
  const feeStructure = await getFeeStructure();
  const taskAmountDecimal = new Prisma.Decimal(taskAmount.toString());

  // Calculate platform fee (10-15% of task amount)
  const platformFee = taskAmountDecimal.mul(feeStructure.platformFee.percentage).toDecimalPlaces(2);
  const platformFeeGst = platformFee.mul(feeStructure.platformFee.gstPercentage).toDecimalPlaces(2);
  const platformFeeTotal = platformFee.add(platformFeeGst).toDecimalPlaces(2);

  // Calculate total processing fees (Razorpay fee + GST)
  const razorpayFee = taskAmountDecimal.mul(feeStructure.processingFees.razorpayFeePercentage).toDecimalPlaces(2);
  const razorpayFeeGst = razorpayFee.mul(feeStructure.processingFees.razorpayFeeGstPercentage).toDecimalPlaces(2);
  const totalProcessingFees = razorpayFee.add(razorpayFeeGst).toDecimalPlaces(2);

  // Performer pays 50% of processing fees
  const processingFeeShare = totalProcessingFees.mul(feeStructure.processingFees.splitRatio.performer).toDecimalPlaces(2);
  const processingFeeGst = processingFeeShare.mul(feeStructure.processingFees.razorpayFeeGstPercentage).toDecimalPlaces(2);
  const processingFeeTotal = processingFeeShare.add(processingFeeGst).toDecimalPlaces(2);

  // Calculate TDS (5% of platform commission)
  const tds = platformFee.mul(feeStructure.processingFees.tdsPercentage).toDecimalPlaces(2);

  // Calculate total deductions
  const totalDeductions = platformFeeTotal.add(processingFeeTotal).add(tds).toDecimalPlaces(2);

  // Calculate net amount performer receives
  const netAmount = taskAmountDecimal.sub(totalDeductions).toDecimalPlaces(2);

  return {
    taskAmount: taskAmountDecimal,
    platformFee,
    platformFeeGst,
    platformFeeTotal,
    processingFeeShare,
    processingFeeGst,
    processingFeeTotal,
    tds,
    netAmount,
    totalDeductions,
    metadata: {
      platformFeePercentage: feeStructure.platformFee.percentage,
      processingFeeSplitRatio: feeStructure.processingFees.splitRatio.performer,
      gstPercentage: feeStructure.platformFee.gstPercentage,
      tdsPercentage: feeStructure.processingFees.tdsPercentage,
    },
  };
}

/**
 * Calculate total amount poster needs to pay (task amount + all fees)
 * 
 * @param taskAmount - Task amount in rupees
 * @returns Total amount poster needs to pay
 */
export async function calculatePosterTotalAmount(taskAmount: number | Prisma.Decimal): Promise<Prisma.Decimal> {
  const posterFees = await calculatePosterFees(taskAmount);
  return posterFees.totalAmount;
}

/**
 * Calculate all fees for a payment (legacy function - for backward compatibility)
 * 
 * @param amount - Amount in rupees
 * @returns Fee breakdown
 */
export function calculateFees(amount: number | Prisma.Decimal): FeeBreakdown {
  const percentages = getFeePercentages();
  const originalAmount = new Prisma.Decimal(amount.toString());
  const originalAmountInPaise = Math.round(parseFloat(originalAmount.toString()) * 100);

  // Calculate Razorpay fee (2% of amount)
  const razorpayFee = originalAmount.mul(percentages.razorpayFee);
  const razorpayFeeGst = razorpayFee.mul(percentages.gst);
  const razorpayFeeTotal = razorpayFee.add(razorpayFeeGst);

  // Calculate platform commission (10% of amount)
  const platformCommission = originalAmount.mul(percentages.platformCommission);
  const platformCommissionGst = platformCommission.mul(percentages.gst);
  const platformCommissionTotal = platformCommission.add(platformCommissionGst);

  // Calculate TDS (5% of platform commission, if applicable)
  const tds = platformCommission.mul(percentages.tds);

  // Calculate total fees
  const totalFees = razorpayFeeTotal.add(platformCommissionTotal).add(tds);

  // Calculate net amount (amount after all fees)
  const netAmount = originalAmount.sub(totalFees);

  return {
    originalAmount,
    originalAmountInPaise,
    razorpayFee: razorpayFee.toDecimalPlaces(2),
    razorpayFeeGst: razorpayFeeGst.toDecimalPlaces(2),
    razorpayFeeTotal: razorpayFeeTotal.toDecimalPlaces(2),
    platformCommission: platformCommission.toDecimalPlaces(2),
    platformCommissionGst: platformCommissionGst.toDecimalPlaces(2),
    platformCommissionTotal: platformCommissionTotal.toDecimalPlaces(2),
    tds: tds.toDecimalPlaces(2),
    netAmount: netAmount.toDecimalPlaces(2),
    totalFees: totalFees.toDecimalPlaces(2),
    metadata: {
      razorpayFeePercentage: percentages.razorpayFee,
      platformCommissionPercentage: percentages.platformCommission,
      gstPercentage: percentages.gst,
      tdsPercentage: percentages.tds,
    },
  };
}

/**
 * Calculate cancellation fee based on time and role
 * 
 * @param amount - Original amount in rupees
 * @param taskStartDate - Task start date
 * @param cancelledAt - Cancellation date
 * @param cancelledBy - Who cancelled ('poster' or 'performer')
 * @returns Cancellation fee result
 */
export async function calculateCancellationFee(params: {
  /** Total captured / escrow amount in rupees (what Razorpay can refund from) */
  amount: number | Prisma.Decimal;
  taskStartDate: Date;
  cancelledAt: Date;
  cancelledBy: 'poster' | 'performer';
  /** Poster: free cancel within 15 minutes of assignment (matches tracking UI) */
  assignedAt?: Date;
  /**
   * Base used for % cancellation fee (task budget in UI). Defaults to `amount` when omitted.
   */
  feeBaseAmount?: number | Prisma.Decimal;
}): Promise<CancellationFeeResult> {
  const { amount, taskStartDate, cancelledAt, cancelledBy, assignedAt, feeBaseAmount } = params;
  const feeStructure = await getFeeStructure();
  const originalAmount = new Prisma.Decimal(amount.toString());
  const feeBase =
    feeBaseAmount != null
      ? new Prisma.Decimal(feeBaseAmount.toString())
      : originalAmount;

  // Hours until scheduled start (positive = before start). Matches StatusUpdateSection logic.
  const hoursUntilStart = (taskStartDate.getTime() - cancelledAt.getTime()) / (1000 * 60 * 60);

  let cancellationFeePercentage: number;

  if (cancelledBy === 'poster') {
    if (assignedAt) {
      const minutesSinceAssigned = (cancelledAt.getTime() - assignedAt.getTime()) / (1000 * 60);
      if (minutesSinceAssigned <= 15) {
        cancellationFeePercentage = 0;
      } else if (hoursUntilStart > 24) {
        cancellationFeePercentage = 0;
      } else if (hoursUntilStart > 1) {
        cancellationFeePercentage = 0.10;
      } else {
        cancellationFeePercentage = 0.20;
      }
    } else if (hoursUntilStart > 24) {
      cancellationFeePercentage = 0;
    } else if (hoursUntilStart > 1) {
      cancellationFeePercentage = 0.10;
    } else {
      cancellationFeePercentage = 0.20;
    }
  } else {
    // Performer cancel: refund to poster; bands mirror tasker tracking UI
    if (hoursUntilStart > 24) {
      cancellationFeePercentage = 0;
    } else if (hoursUntilStart > 1) {
      cancellationFeePercentage = feeStructure.cancellationFees.medium;
    } else {
      cancellationFeePercentage = 0.15;
    }
  }

  // Fee % applies to task budget (UI); refund cannot exceed what was captured
  const cancellationFee = feeBase.mul(cancellationFeePercentage).toDecimalPlaces(2);
  let refundAmount = originalAmount.sub(cancellationFee).toDecimalPlaces(2);
  if (refundAmount.lessThan(0)) {
    refundAmount = new Prisma.Decimal('0.00');
  }

  // Distribute cancellation fee (from config)
  const toOtherParty = cancellationFee.mul(feeStructure.cancellationFees.distribution.toOtherParty).toDecimalPlaces(2);
  const toPlatform = cancellationFee.mul(feeStructure.cancellationFees.distribution.toPlatform).toDecimalPlaces(2);

  return {
    cancellationFee,
    cancellationFeePercentage,
    refundAmount,
    toOtherParty,
    toPlatform,
    feeBreakdown: {
      originalAmount,
      cancellationFee,
      refundAmount,
      toOtherParty,
      toPlatform,
    },
  };
}

/**
 * Calculate payout amount (amount after fees)
 * 
 * @param amount - Original amount in rupees
 * @returns Net payout amount
 */
export function calculatePayoutAmount(amount: number | Prisma.Decimal): Prisma.Decimal {
  const feeBreakdown = calculateFees(amount);
  return feeBreakdown.netAmount;
}

/**
 * Calculate refund amount with cancellation fee
 * 
 * @param amount - Original amount in rupees
 * @param taskStartDate - Task start date
 * @param cancelledAt - Cancellation date
 * @param cancelledBy - Who cancelled ('poster' or 'performer')
 * @returns Refund amount and fee breakdown
 */
export async function calculateRefundWithCancellationFee(params: {
  amount: number | Prisma.Decimal;
  taskStartDate: Date;
  cancelledAt: Date;
  cancelledBy: 'poster' | 'performer';
  assignedAt?: Date;
  feeBaseAmount?: number | Prisma.Decimal;
}): Promise<CancellationFeeResult> {
  return await calculateCancellationFee(params);
}

/**
 * Get fee breakdown for display
 * 
 * @param amount - Amount in rupees
 * @returns Human-readable fee breakdown
 */
export function getFeeBreakdownForDisplay(amount: number | Prisma.Decimal): {
  originalAmount: string;
  razorpayFee: string;
  platformCommission: string;
  gst: string;
  tds: string;
  totalFees: string;
  netAmount: string;
} {
  const breakdown = calculateFees(amount);
  return {
    originalAmount: `₹${breakdown.originalAmount.toString()}`,
    razorpayFee: `₹${breakdown.razorpayFee.toString()}`,
    platformCommission: `₹${breakdown.platformCommission.toString()}`,
    gst: `₹${breakdown.razorpayFeeGst.add(breakdown.platformCommissionGst).toString()}`,
    tds: `₹${breakdown.tds.toString()}`,
    totalFees: `₹${breakdown.totalFees.toString()}`,
    netAmount: `₹${breakdown.netAmount.toString()}`,
  };
}



