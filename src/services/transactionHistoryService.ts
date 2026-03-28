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
    
    logger.info(`[TransactionHistory] Fetching transactions for user ${userId} with category filter: ${categoryFilter || 'all'}`);

    const transactions: Transaction[] = [];

    // 1. Get escrows where user is poster or performer
    // Apply database-level filtering for better performance
    const escrowWhere: Prisma.EscrowWhereInput = {
      OR: [
        { posterUid: userId },
        { performerUid: userId }
      ]
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
          where: categoryFilter === 'earnings' 
            ? { performerUid: userId, status: statusFilter || undefined }
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
    escrows.forEach(escrow => {
      const isPoster = escrow.posterUid === userId;
      const isPerformer = escrow.performerUid === userId;

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
          }
        });
      }

      // Payouts from this escrow (money earned)
      escrow.payouts.forEach(payout => {
        if ((!typeFilter || typeFilter === 'payout') && payout.performerUid === userId) {
          // Always add payout transactions when user is the performer (they earned)
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
              grossAmount: payout.amount.toString(),
              platformCommission: payout.platformCommission.toString(),
              gstOnCommission: payout.gstOnCommission.toString(),
              tds: payout.tds?.toString() || '0',
              netAmount: payout.netAmount.toString(),
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
      escrow.refunds.forEach(refund => {
        if (!typeFilter || typeFilter === 'refund' || typeFilter === 'compensation') {
          // Any refund credited to the poster (regardless of who cancelled the task)
          const isPosterRefund = escrow.posterUid === userId;
          const isPerformerCompensation =
            escrow.performerUid === userId &&
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
                originalAmount: escrow.amountInRupees.toString()
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

    // Tasker cancellation penalties (pending recovery from future payouts)
    if (!typeFilter || typeFilter === 'cancellation_penalty') {
      const penalties = await prisma.performerCancellationPenalty.findMany({
        where: {
          performerUid: userId,
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
    }

    // Include payouts that are not linked to an escrow (RazorpayX-only flow)
    if (!typeFilter || typeFilter === 'payout') {
      const standalonePayouts = await prisma.payout.findMany({
        where: {
          performerUid: userId,
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
            grossAmount: payout.amount.toString(),
            platformCommission: payout.platformCommission.toString(),
            gstOnCommission: payout.gstOnCommission.toString(),
            tds: payout.tds?.toString() || '0',
            netAmount: payout.netAmount.toString(),
            ...pm,
          },
        });
      });
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
  endDate?: Date
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
      endDate
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
          totalRefunds = totalRefunds.plus(amount);
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

