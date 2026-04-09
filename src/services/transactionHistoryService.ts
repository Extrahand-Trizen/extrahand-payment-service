import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { Prisma } from '@prisma/client';

export interface Transaction {
  id: string;
  transactionId: string;
  type: 'payment' | 'payout' | 'refund' | 'compensation' | 'fee' | 'escrow' | 'cancellation_penalty';
  amount: string;
  status: string;
  description?: string;
  date: string;
  relatedEntityId?: string; // escrowId, payoutId, refundId, etc.
  metadata?: Record<string, any>;
  // User-friendly categorization
  category?: 'earnings' | 'payments'; // earnings = money received, payments = money spent
}

/**
 * Get all transactions for a user
 * Combines data from:
 * - Escrows (as poster or performer)
 * - Payouts (as performer)
 * - Refunds (affecting user)
 * - Ledger entries (all financial movements)
 */
export async function getUserTransactions(
  userId: string,
  options?: {
    limit?: number;
    offset?: number;
    startDate?: Date;
    endDate?: Date;
    type?: Transaction['type'];
    status?: string;
    category?: 'earnings' | 'payments' | 'all'; // Simple filter: earnings (money received) or payments (money spent)
    /** Extra profile identifiers (e.g. Mongo _id + Firebase uid) so legacy escrows still match */
    linkedUserIds?: string[];
  }
): Promise<{
  success: boolean;
  transactions?: Transaction[];
  total?: number;
  error?: string;
}> {
  try {
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    const startDate = options?.startDate;
    const endDate = options?.endDate;
    const typeFilter = options?.type;
    const statusFilter = options?.status;
    const categoryFilter = options?.category; // New: earnings or payments filter
    const uidList = [
      ...new Set(
        [userId, ...(options?.linkedUserIds || [])].filter(
          (x): x is string => typeof x === 'string' && x.trim().length > 0
        )
      ),
    ];

    logger.info(
      `[TransactionHistory] Fetching transactions for userIds ${uidList.join(',')} category: ${categoryFilter || 'all'}`
    );

    const transactions: Transaction[] = [];

    if (uidList.length === 0) {
      return { success: false, error: 'User ID is required' };
    }

    // 1. Get escrows where user is poster or performer
    // Apply database-level filtering for better performance
    const escrowWhere: Prisma.EscrowWhereInput = {
      OR: [{ posterUid: { in: uidList } }, { performerUid: { in: uidList } }],
    };

    if (startDate || endDate) {
      escrowWhere.createdAt = {};
      if (startDate) escrowWhere.createdAt.gte = startDate;
      if (endDate) escrowWhere.createdAt.lte = endDate;
    }

    if (statusFilter) {
      escrowWhere.status = statusFilter;
    }

    // For proper pagination, we need to fetch more escrows initially
    // but we'll apply category/type filters at database level where possible
    // Fetch more to account for filtering (but not too many - use reasonable limit)
    const fetchLimit = Math.min(limit * 3, 500); // Cap at 500 to prevent memory issues

    const escrows = await prisma.escrow.findMany({
      where: escrowWhere,
      include: {
        payouts: {
          where:
            categoryFilter === 'earnings'
              ? { performerUid: { in: uidList }, status: statusFilter || undefined }
              : undefined,
        },
        refunds: {
          where: statusFilter ? { status: statusFilter } : undefined,
        }
      },
      orderBy: { createdAt: 'desc' },
      take: fetchLimit,
      skip: offset
    });

    // Convert escrows to transactions
    // IMPORTANT: Always add all transactions with their correct category, then filter after
    escrows.forEach((escrow) => {
      const isPoster = uidList.includes(escrow.posterUid);
      const isPerformer = uidList.includes(escrow.performerUid);
      const escrowMeta =
        escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
          ? (escrow.metadata as Record<string, unknown>)
          : {};
      const amountBreakdown =
        escrowMeta.amountBreakdown &&
        typeof escrowMeta.amountBreakdown === 'object' &&
        !Array.isArray(escrowMeta.amountBreakdown)
          ? (escrowMeta.amountBreakdown as Record<string, unknown>)
          : {};
      const toDecimal = (value: unknown): Prisma.Decimal | null => {
        if (value == null) return null;
        try {
          return new Prisma.Decimal(String(value));
        } catch {
          return null;
        }
      };
      const normalizePercent = (value: Prisma.Decimal | null): Prisma.Decimal | null => {
        if (!value) return null;
        const one = new Prisma.Decimal('1');
        const hundred = new Prisma.Decimal('100');
        return value.greaterThan(one) ? value.div(hundred) : value;
      };
      const totalPaid = new Prisma.Decimal(escrow.amountInRupees.toString());
      const configuredPlatformPct = normalizePercent(toDecimal(escrow.appliedPlatformFeePercent));
      const configuredGstPct = normalizePercent(toDecimal(escrow.appliedGstPercent));
      const derivedTaskAmount = (() => {
        if (!configuredPlatformPct) return null;
        const gstPct = configuredGstPct || new Prisma.Decimal('0');
        const multiplier = new Prisma.Decimal('1').plus(
          configuredPlatformPct.mul(new Prisma.Decimal('1').plus(gstPct))
        );
        if (multiplier.lessThanOrEqualTo(0)) return null;
        return totalPaid.div(multiplier).toDecimalPlaces(2);
      })();
      const taskAmount =
        toDecimal(escrow.taskAmount) ||
        toDecimal(amountBreakdown.taskAmount) ||
        toDecimal(escrowMeta.taskAmount) ||
        derivedTaskAmount ||
        totalPaid;
      const platformFee =
        toDecimal(amountBreakdown.platformFee) ||
        toDecimal(escrowMeta.platformFee) ||
        (configuredPlatformPct ? taskAmount.mul(configuredPlatformPct).toDecimalPlaces(2) : null) ||
        new Prisma.Decimal('0');
      const gstAmount =
        toDecimal(amountBreakdown.gst) ||
        toDecimal(escrowMeta.gstAmount) ||
        toDecimal(escrowMeta.platformFeeGst) ||
        ((configuredGstPct || configuredGstPct === null) && configuredPlatformPct
          ? taskAmount.mul(configuredPlatformPct).mul(configuredGstPct || new Prisma.Decimal('0')).toDecimalPlaces(2)
          : null) ||
        new Prisma.Decimal('0');
      const feesAndTaxes = platformFee.plus(gstAmount);
      const inferredFeesAndTaxes = totalPaid.minus(taskAmount);
      const normalizedFeesAndTaxes = inferredFeesAndTaxes.greaterThan(0)
        ? inferredFeesAndTaxes
        : new Prisma.Decimal('0');
      const finalPlatformFee = feesAndTaxes.greaterThan(0)
        ? platformFee
        : normalizedFeesAndTaxes;
      const finalGst = feesAndTaxes.greaterThan(0)
        ? gstAmount
        : new Prisma.Decimal('0');
      const latestRefund = escrow.refunds
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      const latestCompletedRefund = escrow.refunds
        .filter((refund) => refund.status === 'completed')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];

      // Escrow creation (payment) - only show if user is poster (money paid)
      // If user is performer, they'll see the payout instead
      if ((!typeFilter || typeFilter === 'payment' || typeFilter === 'escrow') && isPoster) {
        // Always add payment transactions when user is the poster (they paid)
        transactions.push({
          id: escrow.id,
          transactionId: escrow.escrowId,
          type: 'escrow',
          amount: escrow.amountInRupees.toString(),
          status: escrow.status,
          description: `Payment for task`,
          date: escrow.createdAt.toISOString(),
          relatedEntityId: escrow.escrowId,
          category: 'payments', // Money spent
          metadata: {
            taskId: escrow.taskId,
            role: 'poster',
            razorpayOrderId: escrow.razorpayOrderId,
            amountInRupees: escrow.amountInRupees.toString(),
            escrowStatus: escrow.status,
            taskAmount: taskAmount.toString(),
            platformFee: finalPlatformFee.toString(),
            gstAmount: finalGst.toString(),
            totalPaid: totalPaid.toString(),
            refundedAmount: latestCompletedRefund?.refundAmount?.toString() || '0',
            latestRefundAmount: latestRefund?.refundAmount?.toString() || '0',
            latestRefundStatus: latestRefund?.status || null,
            latestCancellationFee: latestRefund?.cancellationFee?.toString() || '0',
            latestCancelledBy: latestRefund?.cancelledBy || null,
            appliedPlatformFeePercent: configuredPlatformPct?.toString() || null,
            appliedGstPercent: configuredGstPct?.toString() || null,
          }
        });
      }

      // Payouts from this escrow (money earned)
      escrow.payouts.forEach((payout) => {
        if ((!typeFilter || typeFilter === 'payout') && uidList.includes(payout.performerUid)) {
          // Always add payout transactions when user is the performer (they earned)
          
          // Extract penalty information from payout metadata
          const payoutMetadata = payout.metadata && typeof payout.metadata === 'object' && !Array.isArray(payout.metadata)
            ? (payout.metadata as Record<string, any>)
            : {};
          const penaltyDeducted = payoutMetadata.penaltyDeducted || '0.00';
          const penaltyLines = Array.isArray(payoutMetadata.penaltyLines) ? payoutMetadata.penaltyLines : [];
          
          transactions.push({
            id: payout.id,
            transactionId: payout.payoutId,
            type: 'payout',
            amount: payout.netAmount.toString(),
            status: payout.status,
            description: `Money received from task ${escrow.taskId}`,
            date: payout.createdAt.toISOString(),
            relatedEntityId: payout.escrowId || undefined,
            category: 'earnings', // Money received
            metadata: {
              taskId: escrow.taskId,
              taskAmount: payout.amount.toString(),
              totalPaid: payout.amount.toString(),
              grossAmount: payout.amount.toString(),
              platformFee: payout.platformCommission.toString(),
              platformFeeGst: payout.gstOnCommission.toString(),
              gstAmount: payout.gstOnCommission.toString(),
              platformCommission: payout.platformCommission.toString(),
              gstOnCommission: payout.gstOnCommission.toString(),
              tds: payout.tds?.toString() || '0',
              netAmount: payout.netAmount.toString(),
              amountBreakdown: {
                taskAmount: payout.amount.toString(),
                platformFee: payout.platformCommission.toString(),
                gst: payout.gstOnCommission.toString(),
                totalDeductions: payout.platformCommission
                  .add(payout.gstOnCommission)
                  .add(payout.tds || 0)
                  .toString(),
                netAmount: payout.netAmount.toString(),
              },
              penaltyDeducted: penaltyDeducted,
              penaltyLines: penaltyLines,
              penaltiesAppliedAt: payoutMetadata.penaltiesAppliedAt || null,
              // Add task-related info if available (metadata is JSON, so we need to check type)
              ...(escrow.metadata && typeof escrow.metadata === 'object' && !Array.isArray(escrow.metadata)
                ? {
                    taskTitle: (escrow.metadata as any).taskTitle,
                    taskDescription: (escrow.metadata as any).taskDescription
                  }
                : {})
            }
          });
        }
      });

      // Refunds from this escrow
      escrow.refunds.forEach((refund) => {
        if (!typeFilter || typeFilter === 'refund' || typeFilter === 'compensation') {
          // Any refund credited to the poster (regardless of who cancelled the task)
          const isPosterRefund = uidList.includes(escrow.posterUid);
          const isPerformerCompensation =
            uidList.includes(escrow.performerUid) &&
            refund.cancelledBy === 'poster' &&
            refund.toOtherParty;

          if (isPosterRefund) {
            // Poster gets refund (money back) - this is a payment-related transaction
            transactions.push({
              id: refund.id,
              transactionId: refund.refundId,
              type: 'refund',
              amount: refund.refundAmount.toString(),
              status: refund.status,
              description: `Money returned for cancelled task ${escrow.taskId}`,
              date: refund.createdAt.toISOString(),
              relatedEntityId: refund.escrowId || undefined,
              category: 'payments', // Money returned (related to payment)
              metadata: {
                taskId: escrow.taskId,
                cancellationFee: refund.cancellationFee?.toString() || '0',
                refundAmount: refund.refundAmount.toString(),
                toOtherParty: refund.toOtherParty?.toString() || '0',
                toPlatform: refund.toPlatform?.toString() || '0',
                cancelledBy: refund.cancelledBy,
                reason: refund.reason,
                originalAmount: escrow.amountInRupees.toString(),
                taskAmount: taskAmount.toString(),
                platformFee: finalPlatformFee.toString(),
                gstAmount: finalGst.toString(),
                totalPaid: totalPaid.toString(),
              }
            });
          } else if (isPerformerCompensation) {
            // Performer gets compensation (money earned) - this is an earnings transaction
            transactions.push({
              id: refund.id,
              transactionId: refund.refundId,
              type: 'compensation',
              amount: (refund.toOtherParty?.toString() || '0'),
              status: refund.status,
              description: `Money from cancelled task ${escrow.taskId}`,
              date: refund.createdAt.toISOString(),
              relatedEntityId: refund.escrowId || undefined,
              category: 'earnings', // Money received
              metadata: {
                taskId: escrow.taskId,
                cancellationFee: refund.cancellationFee?.toString() || '0',
                refundAmount: refund.refundAmount.toString(),
                toOtherParty: refund.toOtherParty?.toString() || '0',
                toPlatform: refund.toPlatform?.toString() || '0',
                cancelledBy: refund.cancelledBy,
                reason: refund.reason
              }
            });
          }
        }
      });
    });

    // Tasker cancellation penalties — optional DB features must not break core history
    if (!typeFilter || typeFilter === 'cancellation_penalty') {
      try {
        const penalties = await prisma.performerCancellationPenalty.findMany({
          where: {
            performerUid: { in: uidList },
            status: 'pending',
            remainingAmount: { gt: new Prisma.Decimal(0) },
          },
          orderBy: { createdAt: 'desc' },
          take: fetchLimit,
        });

        penalties.forEach((pen) => {
          transactions.push({
            id: pen.id,
            transactionId: pen.penaltyId,
            type: 'cancellation_penalty',
            amount: pen.remainingAmount.toString(),
            status: 'pending',
            description: pen.taskTitle
              ? `Cancellation penalty — ${pen.taskTitle}`
              : `Cancellation penalty for task ${pen.taskId}`,
            date: pen.cancelledAt.toISOString(),
            relatedEntityId: pen.penaltyId,
            category: 'payments',
            metadata: {
              taskId: pen.taskId,
              taskTitle: pen.taskTitle,
              penaltyId: pen.penaltyId,
              originalPenaltyAmount: pen.amount.toString(),
              remainingAmount: pen.remainingAmount.toString(),
              feePercentage: pen.feePercentage?.toString(),
              reason: pen.reason,
              escrowStatus: 'pending_penalty',
            },
          });
        });
      } catch (penErr: any) {
        logger.warn('[TransactionHistory] Skipping cancellation_penalty rows', {
          message: penErr?.message,
        });
      }
    }

    // Include payouts that are not linked to an escrow (RazorpayX-only flow)
    if (!typeFilter || typeFilter === 'payout') {
      try {
        const standalonePayouts = await prisma.payout.findMany({
          where: {
            performerUid: { in: uidList },
            escrowId: null,
            ...(statusFilter ? { status: statusFilter } : {}),
            ...(startDate || endDate
              ? {
                  createdAt: {
                    ...(startDate ? { gte: startDate } : {}),
                    ...(endDate ? { lte: endDate } : {}),
                  },
                }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: fetchLimit,
        });

        standalonePayouts.forEach((payout) => {
          const pm =
            payout.metadata && typeof payout.metadata === 'object' && !Array.isArray(payout.metadata)
              ? (payout.metadata as Record<string, unknown>)
              : {};
          const penaltyDeducted =
            typeof pm.penaltyDeducted === 'string'
              ? Number.parseFloat(pm.penaltyDeducted)
              : typeof pm.penaltyDeducted === 'number'
              ? pm.penaltyDeducted
              : 0;
          const grossFromPenalty = Number.isFinite(penaltyDeducted) && penaltyDeducted > 0
            ? new Prisma.Decimal(payout.netAmount.toString()).add(new Prisma.Decimal(penaltyDeducted.toString())).toString()
            : payout.amount.toString();
          transactions.push({
            id: payout.id,
            transactionId: payout.payoutId,
            type: 'payout',
            amount: payout.netAmount.toString(),
            status: payout.status,
            description: payout.description || 'Task payout credited',
            date: payout.createdAt.toISOString(),
            relatedEntityId: payout.payoutId,
            category: 'earnings',
            metadata: {
              taskAmount: grossFromPenalty,
              totalPaid: grossFromPenalty,
              grossAmount: grossFromPenalty,
              platformFee: payout.platformCommission.toString(),
              platformFeeGst: payout.gstOnCommission.toString(),
              gstAmount: payout.gstOnCommission.toString(),
              platformCommission: payout.platformCommission.toString(),
              gstOnCommission: payout.gstOnCommission.toString(),
              tds: payout.tds?.toString() || '0',
              netAmount: payout.netAmount.toString(),
              amountBreakdown: {
                taskAmount: grossFromPenalty,
                platformFee: payout.platformCommission.toString(),
                gst: payout.gstOnCommission.toString(),
                totalDeductions: payout.platformCommission
                  .add(payout.gstOnCommission)
                  .add(payout.tds || 0)
                  .toString(),
                netAmount: payout.netAmount.toString(),
              },
              ...pm,
            },
          });
        });
      } catch (payoutErr: any) {
        logger.warn('[TransactionHistory] Skipping standalone payout rows', {
          message: payoutErr?.message,
        });
      }
    }

    // 2. Fees are now hidden - they're already deducted in netAmount
    // Individual fee entries are not shown to keep the UI clean
    // Fees are included in the payout metadata for detailed breakdown when needed

    // 3. Sort all transactions by date (newest first)
    transactions.sort((a, b) => {
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    // 4. Apply filters if specified (in-memory filtering for category/type)
    // Note: Category and type filters are complex (depend on user role) so we filter in memory
    // But we've already applied status filter at database level where possible
    let filteredTransactions = transactions;
    
    logger.info(`[TransactionHistory] Total transactions before filtering: ${transactions.length}`);
    
    // Apply category filter (earnings/payments) - in memory due to complexity
    if (categoryFilter && categoryFilter !== 'all') {
      const beforeCount = filteredTransactions.length;
      filteredTransactions = filteredTransactions.filter(t => {
        if (!t.category) {
          logger.warn(`[TransactionHistory] Transaction ${t.id} missing category, skipping from filter`);
          return false;
        }
        return t.category === categoryFilter;
      });
      
      logger.info(`[TransactionHistory] Category filter '${categoryFilter}' applied: ${beforeCount} -> ${filteredTransactions.length} transactions`);
    }
    
    // Apply type filter (in memory)
    if (typeFilter) {
      filteredTransactions = filteredTransactions.filter(t => t.type === typeFilter);
    }
    
    // Status filter already applied at database level, but double-check in case of edge cases
    if (statusFilter) {
      filteredTransactions = filteredTransactions.filter(t => t.status === statusFilter);
    }

    // 5. Get total count for pagination (before slicing)
    const total = filteredTransactions.length;

    // 6. Apply pagination (in memory - but we've already limited the initial fetch)
    const paginatedTransactions = filteredTransactions.slice(0, limit);

    logger.info(`[TransactionHistory] Returning ${paginatedTransactions.length} transactions (total: ${total}) after pagination`);

    return {
      success: true,
      transactions: paginatedTransactions,
      total
    };
  } catch (error: any) {
    logger.error('Error fetching user transactions:', error);
    return {
      success: false,
      error: error.message || 'Failed to fetch transactions'
    };
  }
}

/**
 * Get transaction summary for a user
 */
export async function getTransactionSummary(
  userId: string,
  startDate?: Date,
  endDate?: Date,
  linkedUserIds?: string[]
): Promise<{
  success: boolean;
  summary?: {
    totalPayments: string;
    totalPayouts: string;
    totalRefunds: string;
    totalCompensation: string;
    totalFees: string;
    netEarnings: string;
    transactionCount: number;
  };
  error?: string;
}> {
  try {
    // Get all transactions
    const transactionsResult = await getUserTransactions(userId, {
      limit: 10000, // Get all for summary
      startDate,
      endDate,
      linkedUserIds,
    });

    if (!transactionsResult.success || !transactionsResult.transactions) {
      return transactionsResult;
    }

    const transactions = transactionsResult.transactions;

    // Calculate totals by type
    let totalPayments = new Prisma.Decimal('0');
    let totalPayouts = new Prisma.Decimal('0');
    let totalRefunds = new Prisma.Decimal('0');
    let totalCompensation = new Prisma.Decimal('0');
    let totalFees = new Prisma.Decimal('0');

    transactions.forEach(tx => {
      const amount = new Prisma.Decimal(tx.amount);
      switch (tx.type) {
        case 'escrow':
        case 'payment':
          totalPayments = totalPayments.plus(amount);
          break;
        case 'payout':
          totalPayouts = totalPayouts.plus(amount);
          break;
        case 'refund':
          if (tx.status === 'completed') {
            totalRefunds = totalRefunds.plus(amount);
          }
          break;
        case 'compensation':
          totalCompensation = totalCompensation.plus(amount);
          break;
        case 'fee':
          totalFees = totalFees.plus(amount);
          break;
      }
    });

    // Net earnings = payouts + compensation - fees
    const netEarnings = totalPayouts.plus(totalCompensation).minus(totalFees);

    return {
      success: true,
      summary: {
        totalPayments: totalPayments.toString(),
        totalPayouts: totalPayouts.toString(),
        totalRefunds: totalRefunds.toString(),
        totalCompensation: totalCompensation.toString(),
        totalFees: totalFees.toString(),
        netEarnings: netEarnings.toString(),
        transactionCount: transactions.length
      }
    };
  } catch (error: any) {
    logger.error('Error calculating transaction summary:', error);
    return {
      success: false,
      error: error.message || 'Failed to calculate transaction summary'
    };
  }
}

