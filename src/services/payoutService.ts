/**
 * Payout Service
 * 
 * Handles payouts to performers with fee calculation and mock bank transfers
 * Uses Prisma for financial data storage
 */

import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';
import { createLedgerEntry, getEscrowBalance } from './ledgerService';
import { calculateFees, FeeBreakdown } from './feeCalculationService';
import { transferToBank, getBankTransferStatus } from './mockBankTransferService';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { updateUserPaymentProfile } from './userPaymentProfileService';
import { createRazorpayXPayout } from './razorpayxService';

/**
 * Generate unique payout ID
 */
function generatePayoutId(): string {
  return `payout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

function parseVerificationRef(ref?: string | null): { fundAccountId?: string } {
  if (!ref) return {};
  try {
    const parsed = JSON.parse(ref);
    return { fundAccountId: parsed.fundAccountId };
  } catch {
    return {};
  }
}

function pendingTaskPayoutJobId(taskId: string, performerUid: string): string {
  return `pending_task_payout_${taskId}_${performerUid}`;
}

async function enqueuePendingTaskCompletionPayout(params: {
  taskId: string;
  performerUid: string;
  amount: number;
  taskTitle?: string;
}): Promise<void> {
  const { taskId, performerUid, amount, taskTitle } = params;

  await prisma.jobQueue.upsert({
    where: { jobId: pendingTaskPayoutJobId(taskId, performerUid) },
    update: {
      payload: {
        taskId,
        performerUid,
        amount,
        taskTitle,
      },
      status: 'pending',
      nextRetryAt: new Date(),
      updatedAt: new Date(),
    },
    create: {
      jobId: pendingTaskPayoutJobId(taskId, performerUid),
      jobType: 'task_completion_payout',
      entityType: 'payout',
      entityId: taskId,
      payload: {
        taskId,
        performerUid,
        amount,
        taskTitle,
      },
      nextRetryAt: new Date(),
      status: 'pending',
      priority: 5,
    },
  });
}

export async function processPendingTaskCompletionPayouts(
  performerUid: string
): Promise<{ processed: number; failed: number }> {
  const jobs = await prisma.jobQueue.findMany({
    where: {
      jobType: 'task_completion_payout',
      status: 'pending',
      payload: {
        path: ['performerUid'],
        equals: performerUid,
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    const payload = (job.payload || {}) as {
      taskId?: string;
      performerUid?: string;
      amount?: number;
      taskTitle?: string;
    };

    if (!payload.taskId || !payload.performerUid || !payload.amount) {
      await prisma.jobQueue.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lastError: 'Invalid payload for pending task payout',
          completedAt: new Date(),
        },
      });
      failed += 1;
      continue;
    }

    const result = await processTaskCompletionPayout({
      taskId: payload.taskId,
      performerUid: payload.performerUid,
      amount: Number(payload.amount),
      taskTitle: payload.taskTitle,
      enqueueOnMissingBank: false,
    });

    if (result.success) {
      await prisma.jobQueue.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          lastError: null,
        },
      });
      processed += 1;
    } else {
      await prisma.jobQueue.update({
        where: { id: job.id },
        data: {
          attemptCount: { increment: 1 },
          lastError: result.error || 'Failed to process pending task payout',
          nextRetryAt: new Date(Date.now() + 5 * 60 * 1000),
        },
      });
      failed += 1;
    }
  }

  return { processed, failed };
}

/**
 * Process payout to performer
 * 
 * @param params - Payout parameters
 * @returns Payout result
 */
export async function processPayout(params: {
  razorpayOrderId: string;
  performerUid: string;
  bankAccountId?: string; // Use stored bank account
  accountNumber?: string; // Override or provide if no stored account
  ifscCode?: string;
  accountHolderName?: string;
  bankName?: string;
  userId?: string; // User who initiated the payout (for audit)
}): Promise<{
  success: boolean;
  payout?: any;
  error?: string;
}> {
  try {
    const {
      razorpayOrderId,
      performerUid,
      bankAccountId,
      accountNumber: providedAccountNumber,
      ifscCode: providedIfscCode,
      accountHolderName: providedAccountHolderName,
      bankName: providedBankName,
      userId,
    } = params;

    // Resolve bank account details
    let accountNumber: string;
    let ifscCode: string;
    let accountHolderName: string;
    let bankName: string | undefined;

    if (bankAccountId) {
      // Use stored bank account
      const bankAccount = await prisma.bankAccount.findUnique({
        where: { id: bankAccountId },
      });

      if (!bankAccount) {
        return {
          success: false,
          error: 'Bank account not found',
        };
      }

      if (bankAccount.userId !== performerUid) {
        return {
          success: false,
          error: 'Bank account does not belong to performer',
        };
      }

      accountNumber = bankAccount.accountNumber;
      ifscCode = bankAccount.ifscCode;
      accountHolderName = bankAccount.accountHolderName;
      bankName = bankAccount.bankName;
    } else if (providedAccountNumber && providedIfscCode && providedAccountHolderName) {
      // Use provided account details (backward compatible)
      accountNumber = providedAccountNumber;
      ifscCode = providedIfscCode;
      accountHolderName = providedAccountHolderName;
      bankName = providedBankName;

      // Optionally store the bank account for future use
      try {
        const existingBankAccount = await prisma.bankAccount.findFirst({
          where: {
            userId: performerUid,
            accountNumber,
            ifscCode,
          },
          select: { id: true },
        });

        if (existingBankAccount) {
          await prisma.bankAccount.update({
            where: { id: existingBankAccount.id },
            data: {
              accountHolderName,
              bankName: bankName || 'Unknown',
              updatedAt: new Date(),
            },
          });
        } else {
          await prisma.bankAccount.create({
            data: {
              id: `bank_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
              userId: performerUid,
              accountNumber,
              ifscCode,
              accountHolderName,
              bankName: bankName || 'Unknown',
              isVerified: false, // Would need verification in production
            },
          });
        }
      } catch (error: any) {
        // Log but don't fail - bank account storage is optional
        logger.warn('Could not store bank account:', error.message);
      }
    } else {
      // Try to get default bank account from profile
      const profile = await prisma.userPaymentProfile.findUnique({
        where: { userId: performerUid },
      });

      if (profile?.defaultBankAccountId) {
        const bankAccount = await prisma.bankAccount.findUnique({
          where: { id: profile.defaultBankAccountId },
        });

        if (bankAccount) {
          accountNumber = bankAccount.accountNumber;
          ifscCode = bankAccount.ifscCode;
          accountHolderName = bankAccount.accountHolderName;
          bankName = bankAccount.bankName;
        } else {
          return {
            success: false,
            error: 'Default bank account not found. Please provide bank account details.',
          };
        }
      } else {
        return {
          success: false,
          error: 'Bank account details required. Provide bankAccountId, account details, or set default bank account.',
        };
      }
    }

    logger.info('💰 Processing payout', {
      razorpayOrderId,
      performerUid,
      accountNumber: accountNumber.substring(0, 4) + '****',
    });

    // Get escrow from Postgres
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const postgresEscrow = await prisma.escrow.findUnique({
      where: { razorpayOrderId },
    });

    if (!postgresEscrow) {
      logger.warn('⚠️ Escrow not found for order:', razorpayOrderId);
      return { success: false, error: 'Escrow not found' };
    }

    // Check escrow status
    if (postgresEscrow.status !== 'held') {
      logger.warn('⚠️ Cannot payout - escrow status:', postgresEscrow.status);
      // If already released, check for existing payout (idempotency)
      if (postgresEscrow.status === 'released') {
        const existingPayout = await prisma.payout.findFirst({
          where: {
            escrowId: postgresEscrow.id,
            status: 'completed',
          },
          orderBy: { createdAt: 'desc' },
        });
        if (existingPayout) {
          return {
            success: true,
            payout: {
              payoutId: existingPayout.payoutId,
              amount: existingPayout.amount.toString(),
              netAmount: existingPayout.netAmount.toString(),
              fees: {
                platformCommission: existingPayout.platformCommission.toString(),
                gstOnCommission: existingPayout.gstOnCommission.toString(),
                tds: existingPayout.tds?.toString() || '0.00',
                total: existingPayout.platformCommission
                  .plus(existingPayout.gstOnCommission)
                  .plus(existingPayout.tds || 0)
                  .toString(),
              },
              bankTransferId: existingPayout.bankTransferId,
              status: 'completed',
              completedAt: existingPayout.completedAt,
            },
          };
        }
      }
      return { success: false, error: `Cannot payout - escrow status: ${postgresEscrow.status}` };
    }

    // Verify performer matches
    if (postgresEscrow.performerUid !== performerUid) {
      logger.warn('⚠️ Performer UID mismatch', {
        expected: postgresEscrow.performerUid,
        provided: performerUid,
      });
      return { success: false, error: 'Performer UID mismatch' };
    }

    // Idempotency check: Check if a payout is already in progress or completed
    const existingPayout = await prisma.payout.findFirst({
      where: {
        escrowId: postgresEscrow.id,
        status: { in: ['processing', 'completed'] },
      },
    });

    if (existingPayout) {
      logger.info('ℹ️ Payout already exists (idempotency)', {
        payoutId: existingPayout.payoutId,
        status: existingPayout.status,
      });
      if (existingPayout.status === 'completed') {
        return {
          success: true,
          payout: {
            payoutId: existingPayout.payoutId,
            amount: existingPayout.amount.toString(),
            netAmount: existingPayout.netAmount.toString(),
            fees: {
              platformCommission: existingPayout.platformCommission.toString(),
              gstOnCommission: existingPayout.gstOnCommission.toString(),
              tds: existingPayout.tds?.toString() || '0.00',
              total: existingPayout.platformCommission
                .plus(existingPayout.gstOnCommission)
                .plus(existingPayout.tds || 0)
                .toString(),
            },
            bankTransferId: existingPayout.bankTransferId,
            status: 'completed',
            completedAt: existingPayout.completedAt,
          },
        };
      }
      // If processing, return error (don't allow duplicate processing)
      return { success: false, error: 'Payout already in progress' };
    }

    // Get original amount
    const originalAmount = postgresEscrow.amountInRupees;

    // Calculate fees
    const feeBreakdown = calculateFees(originalAmount);

    // Net payout amount (after all fees)
    const netPayoutAmount = feeBreakdown.netAmount;

    // Get current escrow balance
    const balanceResult = await getEscrowBalance(postgresEscrow.id);
    const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');

    // Verify balance is sufficient
    if (currentBalance.lessThan(originalAmount)) {
      logger.warn('⚠️ Insufficient escrow balance', {
        currentBalance: currentBalance.toString(),
        required: originalAmount.toString(),
      });
      return { success: false, error: 'Insufficient escrow balance' };
    }

    // Generate payout ID
    const payoutId = generatePayoutId();

    // Process bank transfer (mock)
    const bankTransferResult = await transferToBank({
      amount: netPayoutAmount,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      transferType: 'NEFT',
      remarks: `Payout for task: ${postgresEscrow.taskId}`,
    });

    if (!bankTransferResult.success) {
      logger.error('❌ Bank transfer failed:', bankTransferResult.errorMessage);

        // Create failed payout record
        if (isPostgresConnected()) {
          await prisma.payout.create({
            data: {
              payoutId,
              escrowId: postgresEscrow.id,
              performerUid,
              amount: originalAmount,
              netAmount: netPayoutAmount,
              platformCommission: feeBreakdown.platformCommission,
              gstOnCommission: feeBreakdown.platformCommissionGst,
              tds: feeBreakdown.tds,
              bankTransferId: bankTransferResult.transactionId,
              status: 'failed',
              type: 'release',
              description: `Payout to ${accountHolderName} (${accountNumber.substring(accountNumber.length - 4)})`,
              errorMessage: bankTransferResult.errorMessage,
            },
          });
        }

      return {
        success: false,
        error: bankTransferResult.errorMessage || 'Bank transfer failed',
      };
    }

    // Use transaction to ensure data consistency - ALL operations atomic
    let postgresPayout: any = null;

    try {
      if (isPostgresConnected()) {
        // Wrap all database operations in a transaction for atomicity
        await prisma.$transaction(async (tx) => {
          // Get current escrow balance with row-level locking to prevent race conditions
          const latestEntry = await tx.ledger.findFirst({
            where: { escrowId: postgresEscrow.id },
            orderBy: { createdAt: 'desc' },
          });
          const currentBalance = latestEntry?.balanceAfter || new Prisma.Decimal('0.00');

          // Verify balance is sufficient (re-check inside transaction)
          if (currentBalance.lessThan(originalAmount)) {
            throw new Error('Insufficient escrow balance');
          }

          // Create payout record in Postgres
          postgresPayout = await tx.payout.create({
            data: {
              payoutId,
              escrowId: postgresEscrow.id,
              performerUid,
              amount: originalAmount,
              netAmount: netPayoutAmount,
              platformCommission: feeBreakdown.platformCommission,
              gstOnCommission: feeBreakdown.platformCommissionGst,
              tds: feeBreakdown.tds,
              bankTransferId: bankTransferResult.transactionId,
              status: 'completed',
              type: 'release',
              description: `Payout to ${accountHolderName} (${accountNumber.substring(accountNumber.length - 4)}) - ${ifscCode}`,
              completedAt: bankTransferResult.transferredAt || new Date(),
            },
          });

          // Update escrow status to 'released'
          await tx.escrow.update({
            where: { id: postgresEscrow.id },
            data: {
              status: 'released',
              releasedAt: new Date(),
            },
          });

          // Prepare all ledger entries for batch creation
          const ledgerEntries: Array<{
            transactionId: string;
            escrowId: string;
            type: string;
            amount: Prisma.Decimal;
            balanceBefore: Prisma.Decimal;
            balanceAfter: Prisma.Decimal;
            description: string;
            metadata: any;
          }> = [];

          // Helper to generate transaction ID
          const generateTxId = () => `ledger_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

          let runningBalance = currentBalance;

          // 1. Platform commission
          runningBalance = runningBalance.sub(feeBreakdown.platformCommission);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'platform_commission',
            amount: feeBreakdown.platformCommission.neg(),
            balanceBefore: currentBalance,
            balanceAfter: runningBalance,
            description: 'Platform commission',
            metadata: {
              payoutId,
              percentage: feeBreakdown.metadata.platformCommissionPercentage,
              amount: feeBreakdown.platformCommission.toString(),
            },
          });

          // 2. GST on platform commission
          const balanceBeforeGst1 = runningBalance;
          runningBalance = runningBalance.sub(feeBreakdown.platformCommissionGst);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'gst',
            amount: feeBreakdown.platformCommissionGst.neg(),
            balanceBefore: balanceBeforeGst1,
            balanceAfter: runningBalance,
            description: 'GST on platform commission',
            metadata: {
              payoutId,
              percentage: feeBreakdown.metadata.gstPercentage,
              baseAmount: feeBreakdown.platformCommission.toString(),
              amount: feeBreakdown.platformCommissionGst.toString(),
            },
          });

          // 3. Razorpay fee
          const balanceBeforeRazorpay = runningBalance;
          runningBalance = runningBalance.sub(feeBreakdown.razorpayFee);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'razorpay_fee',
            amount: feeBreakdown.razorpayFee.neg(),
            balanceBefore: balanceBeforeRazorpay,
            balanceAfter: runningBalance,
            description: 'Razorpay processing fee',
            metadata: {
              payoutId,
              percentage: feeBreakdown.metadata.razorpayFeePercentage,
              amount: feeBreakdown.razorpayFee.toString(),
            },
          });

          // 4. GST on Razorpay fee
          const balanceBeforeGst2 = runningBalance;
          runningBalance = runningBalance.sub(feeBreakdown.razorpayFeeGst);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'gst',
            amount: feeBreakdown.razorpayFeeGst.neg(),
            balanceBefore: balanceBeforeGst2,
            balanceAfter: runningBalance,
            description: 'GST on Razorpay fee',
            metadata: {
              payoutId,
              percentage: feeBreakdown.metadata.gstPercentage,
              baseAmount: feeBreakdown.razorpayFee.toString(),
              amount: feeBreakdown.razorpayFeeGst.toString(),
            },
          });

          // 5. TDS
          const balanceBeforeTds = runningBalance;
          runningBalance = runningBalance.sub(feeBreakdown.tds);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'tds',
            amount: feeBreakdown.tds.neg(),
            balanceBefore: balanceBeforeTds,
            balanceAfter: runningBalance,
            description: 'TDS deduction',
            metadata: {
              payoutId,
              percentage: feeBreakdown.metadata.tdsPercentage,
              baseAmount: feeBreakdown.platformCommission.toString(),
              amount: feeBreakdown.tds.toString(),
            },
          });

          // 6. Payout to performer
          const finalBalance = runningBalance;
          runningBalance = runningBalance.sub(netPayoutAmount);
          ledgerEntries.push({
            transactionId: generateTxId(),
            escrowId: postgresEscrow.id,
            type: 'payout',
            amount: netPayoutAmount.neg(),
            balanceBefore: finalBalance,
            balanceAfter: runningBalance, // Should be 0
            description: `Payout to performer: ${accountHolderName}`,
            metadata: {
              payoutId,
              performerUid,
              transactionId: bankTransferResult.transactionId,
              bankReferenceId: bankTransferResult.bankReferenceId,
              accountNumber: accountNumber.substring(accountNumber.length - 4),
              ifscCode,
            },
          });

          // Create all ledger entries in a single batch operation
          if (ledgerEntries.length > 0) {
            await tx.ledger.createMany({
              data: ledgerEntries,
            });
          }
        }, {
          timeout: 30000, // 30 second timeout for transaction
        });
      }

      // Escrow already updated in Postgres above (line ~190)

      // Update UserPaymentProfile cache (async, don't wait)
      updateUserPaymentProfile(performerUid, {
        type: 'payout',
        amount: netPayoutAmount,
        payoutId,
        escrowId: postgresEscrow.id,
      }).catch((error) => {
        logger.warn('Failed to update UserPaymentProfile (non-critical):', error);
      });

      logger.info('✅ Payout processed successfully', {
        payoutId,
        razorpayOrderId,
        netAmount: netPayoutAmount.toString(),
        transactionId: bankTransferResult.transactionId,
      });

      return {
        success: true,
        payout: {
          payoutId,
          amount: originalAmount.toString(),
          netAmount: netPayoutAmount.toString(),
          fees: {
            platformCommission: feeBreakdown.platformCommission.toString(),
            gstOnCommission: feeBreakdown.platformCommissionGst.toString(),
            tds: feeBreakdown.tds.toString(),
            total: feeBreakdown.totalFees.toString(),
          },
          bankTransferId: bankTransferResult.transactionId,
          status: 'completed',
          completedAt: bankTransferResult.transferredAt,
        },
      };
    } catch (error: any) {
      logger.error('❌ Error processing payout:', error);

      // Update payout status to 'failed' if it was created
      if (postgresPayout) {
        try {
          await prisma.payout.update({
            where: { id: postgresPayout.id },
            data: {
              status: 'failed',
              errorMessage: error.message,
            },
          });
        } catch (updateError) {
          logger.error('❌ Failed to update payout status:', updateError);
        }
      }

      return { success: false, error: error.message || 'Failed to process payout' };
    }
  } catch (error: any) {
    logger.error('❌ Error in payout service:', error);
    return { success: false, error: error.message || 'Failed to process payout' };
  }
}

/**
 * Process payout for task completion in RazorpayX-only mode
 * This path does not depend on escrow/order IDs.
 */
export async function processTaskCompletionPayout(params: {
  taskId: string;
  performerUid: string;
  amount: number;
  taskTitle?: string;
  userId?: string;
  enqueueOnMissingBank?: boolean;
}): Promise<{
  success: boolean;
  payout?: any;
  requiresBankAccount?: boolean;
  error?: string;
}> {
  try {
    const { taskId, performerUid, amount, taskTitle, enqueueOnMissingBank = true } = params;

    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const duplicateDescription = `Task completion payout for task ${taskId}`;

    const existing = await prisma.payout.findFirst({
      where: {
        performerUid,
        description: duplicateDescription,
        status: { in: ['processing', 'completed'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return {
        success: true,
        payout: {
          payoutId: existing.payoutId,
          amount: existing.amount.toString(),
          netAmount: existing.netAmount.toString(),
          status: existing.status,
          completedAt: existing.completedAt,
        },
      };
    }

    const paymentProfile = await prisma.userPaymentProfile.findUnique({
      where: { userId: performerUid },
    });

    if (!paymentProfile?.defaultBankAccountId) {
      if (enqueueOnMissingBank) {
        await enqueuePendingTaskCompletionPayout({ taskId, performerUid, amount, taskTitle });
      }
      return {
        success: false,
        requiresBankAccount: true,
        error: 'No bank account added for this tasker',
      };
    }

    const bankAccount = await prisma.bankAccount.findUnique({
      where: { id: paymentProfile.defaultBankAccountId },
    });

    if (!bankAccount) {
      if (enqueueOnMissingBank) {
        await enqueuePendingTaskCompletionPayout({ taskId, performerUid, amount, taskTitle });
      }
      return {
        success: false,
        requiresBankAccount: true,
        error: 'Default bank account not found',
      };
    }

    const { fundAccountId } = parseVerificationRef(bankAccount.verificationRef);
    if (!fundAccountId) {
      if (enqueueOnMissingBank) {
        await enqueuePendingTaskCompletionPayout({ taskId, performerUid, amount, taskTitle });
      }
      return {
        success: false,
        requiresBankAccount: true,
        error: 'Bank account is not linked to RazorpayX fund account',
      };
    }

    const grossAmount = new Prisma.Decimal(amount.toString());
    const feeBreakdown = calculateFees(grossAmount);
    const netAmount = feeBreakdown.netAmount;

    const payoutResponse = await createRazorpayXPayout({
      fundAccountId,
      amountInPaise: Math.round(parseFloat(netAmount.toString()) * 100),
      referenceId: `task_${taskId}`,
      narration: `Task payout ${taskId}`,
    });

    const status = payoutResponse.status === 'processed' ? 'completed' : 'processing';
    const completedAt = status === 'completed' ? new Date() : null;

    await prisma.payout.create({
      data: {
        payoutId: payoutResponse.id,
        escrowId: null,
        performerUid,
        amount: grossAmount,
        netAmount,
        platformCommission: feeBreakdown.platformCommission,
        gstOnCommission: feeBreakdown.platformCommissionGst,
        tds: feeBreakdown.tds,
        bankTransferId: payoutResponse.id,
        status,
        type: 'task_completion',
        description: duplicateDescription,
        completedAt: completedAt || undefined,
      },
    });

    if (status === 'completed') {
      updateUserPaymentProfile(performerUid, {
        type: 'payout',
        amount: netAmount,
        payoutId: payoutResponse.id,
      }).catch((error) => {
        logger.warn('Failed to update UserPaymentProfile after task completion payout', error);
      });
    }

    return {
      success: true,
      payout: {
        payoutId: payoutResponse.id,
        taskId,
        taskTitle,
        amount: grossAmount.toString(),
        netAmount: netAmount.toString(),
        status,
        fees: {
          platformCommission: feeBreakdown.platformCommission.toString(),
          gstOnCommission: feeBreakdown.platformCommissionGst.toString(),
          tds: feeBreakdown.tds.toString(),
          total: feeBreakdown.totalFees.toString(),
        },
      },
    };
  } catch (error: any) {
    logger.error('Error processing task completion payout', error);
    return {
      success: false,
      error: error.message || 'Failed to process task completion payout',
    };
  }
}

/**
 * Get payout status
 * 
 * @param payoutId - Payout ID
 * @returns Payout status
 */
export async function getPayoutStatus(payoutId: string): Promise<{
  success: boolean;
  payout?: any;
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    const payout = await prisma.payout.findUnique({
      where: { payoutId },
      include: {
        escrow: true,
      },
    });

    if (!payout) {
      return { success: false, error: 'Payout not found' };
    }

    // Get bank transfer status if transaction ID exists
    let bankTransferStatus = null;
    if (payout.bankTransferId) {
      const transferStatus = await getBankTransferStatus(payout.bankTransferId);
      bankTransferStatus = transferStatus;
    }

    return {
      success: true,
      payout: {
        payoutId: payout.payoutId,
        amount: payout.amount.toString(),
        netAmount: payout.netAmount.toString(),
        fees: {
          platformCommission: payout.platformCommission.toString(),
          gstOnCommission: payout.gstOnCommission.toString(),
          tds: payout.tds?.toString(),
        },
        bankTransferId: payout.bankTransferId,
        status: payout.status,
        type: payout.type,
        description: payout.description,
        createdAt: payout.createdAt,
        completedAt: payout.completedAt,
        bankTransferStatus,
      },
    };
  } catch (error: any) {
    logger.error('❌ Error getting payout status:', error);
    return { success: false, error: error.message || 'Failed to get payout status' };
  }
}

/**
 * Get payouts by escrow ID
 * 
 * @param escrowId - Escrow ID
 * @returns List of payouts
 */
export async function getPayoutsByEscrowId(escrowId: string): Promise<{
  success: boolean;
  payouts?: any[];
  error?: string;
}> {
  try {
    if (!isPostgresConnected()) {
      return { success: false, error: 'Postgres not connected' };
    }

    // First get Postgres escrow to find its ID
    const postgresEscrow = await prisma.escrow.findUnique({
      where: { escrowId },
    });

    if (!postgresEscrow) {
      return { success: false, error: 'Escrow not found' };
    }

    const payouts = await prisma.payout.findMany({
      where: { escrowId: postgresEscrow.id },
      orderBy: { createdAt: 'desc' },
    });

    return {
      success: true,
      payouts: payouts.map(payout => ({
        payoutId: payout.payoutId,
        amount: payout.amount.toString(),
        netAmount: payout.netAmount.toString(),
        fees: {
          platformCommission: payout.platformCommission.toString(),
          gstOnCommission: payout.gstOnCommission.toString(),
          tds: payout.tds?.toString(),
        },
        status: payout.status,
        type: payout.type,
        description: payout.description,
        createdAt: payout.createdAt,
        completedAt: payout.completedAt,
      })),
    };
  } catch (error: any) {
    logger.error('❌ Error getting payouts by escrow ID:', error);
    return { success: false, error: error.message || 'Failed to get payouts' };
  }
}

