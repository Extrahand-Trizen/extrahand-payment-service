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
import mongoose from 'mongoose';
import { updateUserPaymentProfile } from './userPaymentProfileService';
import { createRazorpayXPayout, getRazorpayXPayoutStatus } from './razorpayxService';
import { applyPenaltyLinesInTx, planPenaltyDeductionsFromGross } from './performerPenaltyService';
import { notifyPayoutInitiated } from './paymentNotificationService';
import { getFeeStructure } from './feeConfigService';
import { applyExtraCoinsForPayout, awardExtraCoinsForCompletedTask } from './extraCoinsService';

/**
 * Generate unique payout ID
 */
function generatePayoutId(): string {
  return `payout_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function ensureExtraCoinsAwardedForTaskCompletionPayout(params: {
  payoutId: string;
  performerUid: string;
  taskId: string;
  taskAmountRupees: Prisma.Decimal;
  platformFeeRupees: Prisma.Decimal;
  context: string;
}): Promise<void> {
  const { payoutId, performerUid, taskId, taskAmountRupees, platformFeeRupees, context } = params;

  try {
    const awardResult = await awardExtraCoinsForCompletedTask({
      userId: performerUid,
      payoutId,
      taskId,
      taskAmountRupees,
      platformFeeRupees,
    });

    if (!awardResult.success) {
      logger.warn(`[payoutService] ExtraCoins award did not complete during ${context}`, {
        payoutId,
        performerUid,
        taskId,
        reason: awardResult.reason,
        error: awardResult.error,
      });
    }
  } catch (error: any) {
    logger.warn(`[payoutService] ExtraCoins award failed during ${context}`, {
      payoutId,
      performerUid,
      taskId,
      error: error?.message || 'Unknown error',
    });
  }
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

async function getProfileContact(uid: string): Promise<{ email?: string; name?: string } | null> {
  if (!uid || mongoose.connection.readyState !== 1) return null;

  try {
    const Profile = mongoose.connection.collection('profiles');
    const profile =
      (await Profile.findOne({ uid })) ||
      (mongoose.isValidObjectId(uid) ? await Profile.findOne({ _id: new mongoose.Types.ObjectId(uid) }) : null);

    if (!profile) return null;

    return {
      email: profile.email,
      name: profile.name || profile.displayName || 'Tasker',
    };
  } catch (error) {
    logger.debug('Failed to load profile contact for payout notification', { error, uid });
    return null;
  }
}

function mapRazorpayPayoutStatusToInternal(razorpayStatus?: string | null): string {
  const s = String(razorpayStatus || '').toLowerCase();

  if (!s) return 'processing';

  if (s === 'processed' || s === 'completed' || s === 'success') return 'completed';
  if (s === 'failed' || s === 'failure') return 'failed';
  if (s === 'reversed') return 'reversed';

  // Common "still in progress" states returned by payout APIs.
  if (s === 'processing' || s === 'created' || s === 'queued') return 'processing';

  return 'processing';
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

      const taskTitle = (postgresEscrow.metadata as any)?.taskTitle || null;
      const performerContact = await getProfileContact(performerUid);

      notifyPayoutInitiated({
        performerUid,
        amount: netPayoutAmount.toString(),
        taskId: postgresEscrow.taskId,
        taskTitle,
        email: performerContact?.email || null,
        userName: performerContact?.name || null,
      }).catch((error) => {
        logger.warn('Failed to send payout initiated notification', { error });
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
      if (existing.status === 'completed') {
        const existingMetadata =
          existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
            ? (existing.metadata as Record<string, unknown>)
            : {};
        const existingTaskId = typeof existingMetadata.taskId === 'string' ? existingMetadata.taskId : taskId;

        if (existingTaskId) {
          await ensureExtraCoinsAwardedForTaskCompletionPayout({
            payoutId: existing.payoutId,
            performerUid,
            taskId: existingTaskId,
            taskAmountRupees: new Prisma.Decimal(String(existingMetadata.taskAmount || existing.amount || amount || '0')),
            platformFeeRupees: new Prisma.Decimal(String(existingMetadata.platformFee || existing.platformCommission || '0')),
            context: 'existing completed payout lookup',
          });
        }
      }

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

    const selectedBankAccount = await prisma.bankAccount.findUnique({
      where: { id: paymentProfile.defaultBankAccountId },
    });

    if (!selectedBankAccount) {
      if (enqueueOnMissingBank) {
        await enqueuePendingTaskCompletionPayout({ taskId, performerUid, amount, taskTitle });
      }
      return {
        success: false,
        requiresBankAccount: true,
        error: 'Selected default bank account not found',
      };
    }

    const { fundAccountId } = parseVerificationRef(selectedBankAccount.verificationRef);
    if (!fundAccountId) {
      if (enqueueOnMissingBank) {
        await enqueuePendingTaskCompletionPayout({ taskId, performerUid, amount, taskTitle });
      }
      return {
        success: false,
        requiresBankAccount: true,
        error: 'Selected bank account is not linked to RazorpayX fund account',
      };
    }

    const grossAmount = new Prisma.Decimal(amount.toString()).toDecimalPlaces(2);
    const feeStructure = await getFeeStructure();
    const platformCommission = grossAmount
      .mul(feeStructure.platformFee.percentage)
      .toDecimalPlaces(2);
    const gstOnCommission = platformCommission
      .mul(feeStructure.platformFee.gstPercentage)
      .toDecimalPlaces(2);
    const platformFeeTotal = platformCommission.add(gstOnCommission).toDecimalPlaces(2);
    const payoutBaseAmount = Prisma.Decimal.max(
      grossAmount.sub(platformFeeTotal).toDecimalPlaces(2),
      new Prisma.Decimal('0.00')
    );

    const payoutId = generatePayoutId();

    let redeemedCoins = new Prisma.Decimal('0.00');
    let redeemedRupees = new Prisma.Decimal('0.00');
    let redeemedSources: Array<{
      transactionId: string;
      redeemedCoins: string;
      redeemedRupees: string;
    }> = [];

    try {
      const redeemResult = await applyExtraCoinsForPayout({
        userId: performerUid,
        payoutId,
        taskId,
        maxRedeemRupees: platformFeeTotal,
      });

      if (redeemResult.success) {
        redeemedCoins = new Prisma.Decimal(redeemResult.redeemedCoins);
        redeemedRupees = new Prisma.Decimal(redeemResult.redeemedRupees);
        redeemedSources = redeemResult.sources;
      } else {
        logger.warn('[payoutService] ExtraCoins redeem skipped due to service error', {
          performerUid,
          taskId,
          error: redeemResult.error,
        });
      }
    } catch (redeemError: any) {
      logger.warn('[payoutService] ExtraCoins redeem failed unexpectedly, continuing payout without bonus', {
        performerUid,
        taskId,
        error: redeemError?.message || 'Unknown error',
      });
    }

    const payoutBaseAfterExtraCoins = payoutBaseAmount
      .add(redeemedRupees)
      .toDecimalPlaces(2);

    logger.debug('[payoutService] Starting penalty planning for task completion payout', {
      performerUid,
      taskId,
      grossAmount: grossAmount.toString(),
      platformCommission: platformCommission.toString(),
      gstOnCommission: gstOnCommission.toString(),
      payoutBaseAmount: payoutBaseAmount.toString(),
      redeemedRupees: redeemedRupees.toString(),
      redeemedCoins: redeemedCoins.toString(),
      payoutBaseAfterExtraCoins: payoutBaseAfterExtraCoins.toString(),
    });

    // Fetch escrow associated with this task to check for the actual performer (may be different if linked account)
    const taskEscrow = await prisma.escrow.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });

    const linkedPerformerUids: string[] = [];
    if (taskEscrow && taskEscrow.performerUid !== performerUid) {
      linkedPerformerUids.push(taskEscrow.performerUid);
      logger.debug('[payoutService] Found different performer in escrow, will check linked accounts', {
        requestedPerformerUid: performerUid,
        escrowPerformerUid: taskEscrow.performerUid,
      });
    }

    const penaltyPlan = await planPenaltyDeductionsFromGross(
      performerUid,
      payoutBaseAfterExtraCoins,
      linkedPerformerUids
    );
    const netAmount = penaltyPlan.netTransfer;
    const totalPenaltyDeducted = penaltyPlan.totalDeducted;
    const tds = new Prisma.Decimal(0);
    const totalDeductions = platformFeeTotal
      .add(totalPenaltyDeducted)
      .sub(redeemedRupees)
      .toDecimalPlaces(2);
    const penaltyLinesMetadata = penaltyPlan.lines.map((line) => ({
      penaltyDbId: line.penaltyDbId,
      penaltyId: line.penaltyId,
      taskId: line.taskId,
      applied: line.applied.toString(),
      remainingAfter: line.remainingAfter.toString(),
    }));

    if (totalPenaltyDeducted.gt(0)) {
      logger.info('[payoutService] Penalty deductions planned for task completion payout', {
        performerUid,
        taskId,
        grossAmount: grossAmount.toString(),
        totalPenaltyDeducted: totalPenaltyDeducted.toString(),
        totalFeeDeducted: platformFeeTotal.toString(),
        netAmount: netAmount.toString(),
        deductionLineCount: penaltyPlan.lines.length,
        penaltyLines: penaltyLinesMetadata,
      });
    } else {
      logger.debug('[payoutService] No penalty deductions needed for task completion payout', {
        performerUid,
        taskId,
        grossAmount: grossAmount.toString(),
        totalFeeDeducted: platformFeeTotal.toString(),
      });
    }

    // RazorpayX narration max length is 30 chars.
    const payoutNarration = `Task ${taskId.slice(-8)} payout`;

    const metadataPayload = {
      taskId,
      taskTitle,
      posterUid: taskEscrow?.posterUid,
      grossAmount: grossAmount.toString(),
      taskAmount: grossAmount.toString(),
      platformFee: platformCommission.toString(),
      platformFeeGst: gstOnCommission.toString(),
      gstAmount: gstOnCommission.toString(),
      totalFeeDeducted: platformFeeTotal.toString(),
      totalDeductions: totalDeductions.toString(),
      netAmount: netAmount.toString(),
      penaltyDeducted: totalPenaltyDeducted.toString(),
      extraCoinsBonus: redeemedRupees.toString(),
      extraCoinsBonusCoins: redeemedCoins.toString(),
      penaltyLines: penaltyLinesMetadata,
      amountBreakdown: {
        taskAmount: grossAmount.toString(),
        platformFee: platformCommission.toString(),
        gst: gstOnCommission.toString(),
        basePayout: payoutBaseAmount.toString(),
        extraCoinsBonus: redeemedRupees.toString(),
        totalFeeDeducted: platformFeeTotal.toString(),
        penaltyDeducted: totalPenaltyDeducted.toString(),
        totalDeductions: totalDeductions.toString(),
        finalPayout: netAmount.toString(),
        netAmount: netAmount.toString(),
      },
      extraCoins: {
        coinToRupee: '0.20',
        applied: redeemedRupees.gt(0),
        redeemedCoins: redeemedCoins.toString(),
        redeemedRupees: redeemedRupees.toString(),
        redeemCapRupees: platformFeeTotal.toString(),
        redeemSources: redeemedSources,
        usageRule: 'Usable at payout up to platform fee. Not withdrawable as bank cash.',
      },
      feeMeta: {
        platformFeePercentage: feeStructure.platformFee.percentage,
        gstPercentage: feeStructure.platformFee.gstPercentage,
      },
      coinFormula: '(platformFee * basePercent) * ratingMultiplier * bonuses / 0.20',
      penaltiesAppliedAt: null as string | null,
    };

    await ensureExtraCoinsAwardedForTaskCompletionPayout({
      payoutId,
      performerUid,
      taskId,
      taskAmountRupees: grossAmount,
      platformFeeRupees: platformCommission,
      context: 'payout creation',
    });

    let status: string = 'completed';

    if (netAmount.lte(0)) {
      status = 'completed';

      await prisma.$transaction(async (tx) => {
        await tx.payout.create({
          data: {
            payoutId,
            escrowId: null,
            performerUid,
            amount: grossAmount,
            netAmount,
            platformCommission,
            gstOnCommission,
            tds,
            bankTransferId: null,
            status,
            type: 'task_completion',
            description: `${duplicateDescription} (fully adjusted against pending cancellation penalties)`,
            completedAt: new Date(),
            metadata: {
              ...metadataPayload,
              penaltiesAppliedAt: new Date().toISOString(),
              noBankTransfer: true,
            } as any,
          },
        });
        if (penaltyPlan.lines.length > 0) {
          await applyPenaltyLinesInTx(tx, penaltyPlan.lines);
        }
      });
      logger.info('[payoutService] Penalty-only payout created and completed', {
        performerUid,
        taskId,
        payoutId,
        deductionLineCount: penaltyPlan.lines.length,
      });
    } else {
      logger.debug('[payoutService] Creating RazorpayX payout with penalty deduction applied', {
        performerUid,
        taskId,
        netAmount: netAmount.toString(),
      });
      const payoutResponse = await createRazorpayXPayout({
        fundAccountId,
        amountInPaise: Math.round(parseFloat(netAmount.toString()) * 100),
        referenceId: payoutId,
        narration: payoutNarration,
      });

      status = mapRazorpayPayoutStatusToInternal(payoutResponse.status);
      const completedAt = status === 'completed' ? new Date() : null;

      if (status === 'completed' && penaltyPlan.lines.length > 0) {
        await prisma.$transaction(async (tx) => {
          await tx.payout.create({
            data: {
              payoutId,
              escrowId: null,
              performerUid,
              amount: grossAmount,
              netAmount,
              platformCommission,
              gstOnCommission,
              tds,
              bankTransferId: payoutResponse.id,
              status,
              type: 'task_completion',
              description: duplicateDescription,
              completedAt: completedAt || undefined,
              errorMessage:
                status === 'failed' || status === 'reversed'
                  ? payoutResponse.failureReason || 'Payout failed'
                  : undefined,
              metadata: {
                ...metadataPayload,
                penaltiesAppliedAt: new Date().toISOString(),
              } as any,
            },
          });
          await applyPenaltyLinesInTx(tx, penaltyPlan.lines);
        });
      } else {
        await prisma.payout.create({
          data: {
            payoutId,
            escrowId: null,
            performerUid,
            amount: grossAmount,
            netAmount,
            platformCommission,
            gstOnCommission,
            tds,
            bankTransferId: payoutResponse.id,
            status,
            type: 'task_completion',
            description: duplicateDescription,
            completedAt: completedAt || undefined,
            errorMessage:
              status === 'failed' || status === 'reversed'
                ? payoutResponse.failureReason || 'Payout failed'
                : undefined,
            metadata: {
              ...metadataPayload,
              penaltiesAppliedAt:
                penaltyPlan.lines.length > 0 ? new Date().toISOString() : metadataPayload.penaltiesAppliedAt,
            } as any,
          },
        });

        if (penaltyPlan.lines.length > 0) {
          await prisma.$transaction(async (tx) => {
            await applyPenaltyLinesInTx(tx, penaltyPlan.lines);
          });
        }
      }
    }

    if (status === 'completed') {
      updateUserPaymentProfile(performerUid, {
        type: 'payout',
        amount: netAmount,
        payoutId,
      }).catch((error) => {
        logger.warn('Failed to update UserPaymentProfile after task completion payout', error);
      });

      const performerContact = await getProfileContact(performerUid);
      notifyPayoutInitiated({
        performerUid,
        amount: netAmount.toString(),
        taskTitle,
        taskId,
        email: performerContact?.email || null,
        userName: performerContact?.name || null,
      }).catch((error) => {
        logger.warn('Failed to send payout initiated notification', { error });
      });
    }

    return {
      success: true,
      payout: {
        payoutId,
        taskId,
        taskTitle,
        amount: grossAmount.toString(),
        netAmount: netAmount.toString(),
        status,
        penaltyDeducted: totalPenaltyDeducted.toString(),
        extraCoinsBonus: redeemedRupees.toString(),
        extraCoinsBonusCoins: redeemedCoins.toString(),
        penaltyLines: penaltyLinesMetadata,
        fees: {
          platformCommission: platformCommission.toString(),
          gstOnCommission: gstOnCommission.toString(),
          tds: tds.toString(),
          total: platformFeeTotal.toString(),
        },
        amountBreakdown: {
          taskAmount: grossAmount.toString(),
          platformFee: platformCommission.toString(),
          gst: gstOnCommission.toString(),
          basePayout: payoutBaseAmount.toString(),
          extraCoinsBonus: redeemedRupees.toString(),
          finalPayout: netAmount.toString(),
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

    // If this is a RazorpayX task-completion payout, poll RazorpayX for latest status.
    // This prevents "stuck processing" in the UI when the initial create call returns queued/processing.
    if (payout.type === 'task_completion' && payout.status === 'processing') {
      try {
        const razorpayLookupId = payout.bankTransferId || payout.payoutId;
        const razorpayStatus = await getRazorpayXPayoutStatus(razorpayLookupId);
        const internalStatus = mapRazorpayPayoutStatusToInternal(razorpayStatus.status);

        if (internalStatus !== payout.status) {
          await prisma.payout.update({
            where: { id: payout.id },
            data: {
              status: internalStatus,
              errorMessage:
                internalStatus === 'failed' || internalStatus === 'reversed'
                  ? razorpayStatus.failureReason || 'Payout failed'
                  : undefined,
              completedAt:
                internalStatus === 'completed'
                  ? (payout.completedAt ?? new Date())
                  : payout.completedAt,
              updatedAt: new Date(),
            },
          });

          // Keep cached earnings in sync once Razorpay indicates completion.
          if (internalStatus === 'completed') {
            const md =
              payout.metadata && typeof payout.metadata === 'object' && !Array.isArray(payout.metadata)
                ? (payout.metadata as Record<string, unknown>)
                : {};
            const penaltiesAppliedAt =
              typeof md.penaltiesAppliedAt === 'string' ? md.penaltiesAppliedAt : null;
            const penaltyLinesRaw = Array.isArray(md.penaltyLines) ? md.penaltyLines : [];

            if (!penaltiesAppliedAt && penaltyLinesRaw.length > 0) {
              const txLines = penaltyLinesRaw
                .map((line) => {
                  if (!line || typeof line !== 'object') return null;
                  const row = line as Record<string, unknown>;
                  if (
                    typeof row.penaltyDbId !== 'string' ||
                    typeof row.penaltyId !== 'string' ||
                    typeof row.taskId !== 'string'
                  ) {
                    return null;
                  }
                  return {
                    penaltyDbId: row.penaltyDbId,
                    penaltyId: row.penaltyId,
                    taskId: row.taskId,
                    applied: new Prisma.Decimal(String(row.applied || '0')),
                    remainingAfter: new Prisma.Decimal(String(row.remainingAfter || '0')),
                  };
                })
                .filter((x): x is { penaltyDbId: string; penaltyId: string; taskId: string; applied: Prisma.Decimal; remainingAfter: Prisma.Decimal } => Boolean(x));

              if (txLines.length > 0) {
                await prisma.$transaction(async (tx) => {
                  await applyPenaltyLinesInTx(tx, txLines);
                  await tx.payout.update({
                    where: { id: payout.id },
                    data: {
                      metadata: {
                        ...md,
                        penaltiesAppliedAt: new Date().toISOString(),
                      } as any,
                    },
                  });
                });
              }
            }

            updateUserPaymentProfile(payout.performerUid, {
              type: 'payout',
              amount: payout.netAmount,
              payoutId: payout.payoutId,
              escrowId: payout.escrowId || undefined,
            }).catch((err) => {
              logger.warn('Failed to update UserPaymentProfile after Razorpay payout status refresh', {
                payoutId: payout.payoutId,
                performerUid: payout.performerUid,
                error: err?.message || 'Unknown error',
              });
            });

            const taskId = typeof md.taskId === 'string' ? md.taskId : '';
            if (taskId) {
              await ensureExtraCoinsAwardedForTaskCompletionPayout({
                payoutId: payout.payoutId,
                performerUid: payout.performerUid,
                taskId,
                taskAmountRupees: new Prisma.Decimal(String(md.taskAmount || payout.amount || '0')),
                platformFeeRupees: new Prisma.Decimal(
                  String(md.platformFee || payout.platformCommission || '0')
                ),
                context: 'payout status refresh',
              });
            }
          }
        }
      } catch (e: any) {
        logger.warn('Could not refresh RazorpayX payout status', {
          payoutId,
          error: e?.message || 'Unknown error',
        });
      }
    }

    // Get mock bank transfer status if transaction ID exists
    let bankTransferStatus = null;
    if (payout.bankTransferId) {
      const transferStatus = await getBankTransferStatus(payout.bankTransferId);
      bankTransferStatus = transferStatus;
    }

    // Refresh payout after possible Razorpay update.
    const updatedPayout =
      (payout.type === 'task_completion' ? await prisma.payout.findUnique({ where: { payoutId } }) : payout) || payout;

    // Extract penalty information from metadata
    const metadata = updatedPayout.metadata && typeof updatedPayout.metadata === 'object' && !Array.isArray(updatedPayout.metadata)
      ? (updatedPayout.metadata as Record<string, unknown>)
      : {};
    const penaltyDeducted = typeof metadata.penaltyDeducted === 'string' ? metadata.penaltyDeducted : '0.00';
    const penaltyLines = Array.isArray(metadata.penaltyLines) ? metadata.penaltyLines : [];
    const extraCoinsBonus = typeof metadata.extraCoinsBonus === 'string' ? metadata.extraCoinsBonus : '0.00';
    const extraCoinsBonusCoins =
      typeof metadata.extraCoinsBonusCoins === 'string' ? metadata.extraCoinsBonusCoins : '0.00';
    const penaltiesAppliedAt = typeof metadata.penaltiesAppliedAt === 'string' ? metadata.penaltiesAppliedAt : null;

    return {
      success: true,
      payout: {
        payoutId: updatedPayout.payoutId,
        amount: updatedPayout.amount.toString(),
        netAmount: updatedPayout.netAmount.toString(),
        penaltyDeducted: penaltyDeducted,
        penaltyLines: penaltyLines,
        extraCoinsBonus,
        extraCoinsBonusCoins,
        amountBreakdown:
          metadata.amountBreakdown && typeof metadata.amountBreakdown === 'object' && !Array.isArray(metadata.amountBreakdown)
            ? metadata.amountBreakdown
            : undefined,
        penaltiesAppliedAt: penaltiesAppliedAt,
        fees: {
          platformCommission: updatedPayout.platformCommission.toString(),
          gstOnCommission: updatedPayout.gstOnCommission.toString(),
          tds: updatedPayout.tds?.toString(),
          total: updatedPayout.platformCommission
            .plus(updatedPayout.gstOnCommission)
            .plus(updatedPayout.tds || 0)
            .toString(),
        },
        bankTransferId: updatedPayout.bankTransferId,
        status: updatedPayout.status,
        type: updatedPayout.type,
        description: updatedPayout.description,
        createdAt: updatedPayout.createdAt,
        completedAt: updatedPayout.completedAt,
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
          total: payout.platformCommission
            .plus(payout.gstOnCommission)
            .plus(payout.tds || 0)
            .toString(),
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

