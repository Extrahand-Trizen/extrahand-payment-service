/**
 * Mock Bank Transfer Service
 * 
 * Simulates bank transfers with delays and success/failure scenarios
 * Production-ready: Replace with real bank API in production
 */

import logger from '../config/logger';
import { Prisma } from '@prisma/client';

/**
 * Bank transfer result interface
 */
export interface BankTransferResult {
  success: boolean;
  transactionId?: string;
  bankReferenceId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  errorCode?: string;
  transferredAt?: Date;
  estimatedArrival?: Date;
}

/**
 * Mock bank account details (for testing)
 */
interface MockBankAccount {
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  bankName: string;
}

/**
 * Generate mock transaction ID
 */
function generateMockTransactionId(): string {
  return `TXN${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

/**
 * Generate mock bank reference ID
 */
function generateMockBankReferenceId(): string {
  return `BANK${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

/**
 * Simulate network delay (1-3 seconds)
 */
function simulateDelay(): Promise<void> {
  const delay = Math.random() * 2000 + 1000; // 1-3 seconds
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Simulate bank transfer failure (10% failure rate for testing)
 */
function shouldSimulateFailure(): boolean {
  // 10% chance of failure for testing
  return Math.random() < 0.10;
}

/**
 * Transfer money to bank account (mock implementation)
 * 
 * @param params - Transfer parameters
 * @returns Transfer result
 */
export async function transferToBank(params: {
  amount: number | Prisma.Decimal;
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  bankName?: string;
  transferType?: 'NEFT' | 'IMPS' | 'RTGS';
  remarks?: string;
}): Promise<BankTransferResult> {
  try {
    const {
      amount,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName = 'Mock Bank',
      transferType = 'NEFT',
      remarks,
    } = params;

    const amountDecimal = new Prisma.Decimal(amount.toString());
    const amountInRupees = parseFloat(amountDecimal.toString());

    logger.info('🏦 Processing mock bank transfer', {
      amount: amountInRupees,
      accountNumber: accountNumber.substring(0, 4) + '****', // Mask account number
      ifscCode,
      accountHolderName,
      bankName,
      transferType,
    });

    // Simulate network delay (1-3 seconds)
    await simulateDelay();

    // Simulate failure (10% chance)
    if (shouldSimulateFailure()) {
      logger.warn('⚠️ Mock bank transfer failed (simulated)', {
        amount: amountInRupees,
        accountNumber: accountNumber.substring(0, 4) + '****',
      });

      return {
        success: false,
        status: 'failed',
        errorMessage: 'Bank transfer failed - insufficient funds or account issue',
        errorCode: 'BANK_TRANSFER_FAILED',
      };
    }

    // Generate mock transaction IDs
    const transactionId = generateMockTransactionId();
    const bankReferenceId = generateMockBankReferenceId();

    // Simulate transfer completion
    const transferredAt = new Date();
    const estimatedArrival = new Date(transferredAt.getTime() + 2 * 60 * 60 * 1000); // 2 hours later

    logger.info('✅ Mock bank transfer completed', {
      transactionId,
      bankReferenceId,
      amount: amountInRupees,
      accountNumber: accountNumber.substring(0, 4) + '****',
      transferredAt,
    });

    return {
      success: true,
      transactionId,
      bankReferenceId,
      status: 'completed',
      transferredAt,
      estimatedArrival,
    };
  } catch (error: any) {
    logger.error('❌ Error in mock bank transfer:', error);
    return {
      success: false,
      status: 'failed',
      errorMessage: error.message || 'Bank transfer failed',
      errorCode: 'BANK_TRANSFER_ERROR',
    };
  }
}

/**
 * Get bank transfer status (mock implementation)
 * 
 * @param transactionId - Transaction ID
 * @returns Transfer status
 */
export async function getBankTransferStatus(transactionId: string): Promise<BankTransferResult> {
  try {
    logger.info('📊 Getting mock bank transfer status', { transactionId });

    // Simulate network delay
    await simulateDelay();

    // For mock, assume all transfers are completed
    // In production, this would query the bank API
    return {
      success: true,
      transactionId,
      status: 'completed',
      transferredAt: new Date(),
    };
  } catch (error: any) {
    logger.error('❌ Error getting bank transfer status:', error);
    return {
      success: false,
      status: 'failed',
      errorMessage: error.message || 'Failed to get transfer status',
      errorCode: 'STATUS_CHECK_ERROR',
    };
  }
}

/**
 * Validate bank account details (mock implementation)
 * 
 * @param accountNumber - Account number
 * @param ifscCode - IFSC code
 * @returns Validation result
 */
export async function validateBankAccount(params: {
  accountNumber: string;
  ifscCode: string;
}): Promise<{
  success: boolean;
  valid?: boolean;
  accountHolderName?: string;
  bankName?: string;
  error?: string;
}> {
  try {
    const { accountNumber, ifscCode } = params;

    logger.info('🔍 Validating mock bank account', {
      accountNumber: accountNumber.substring(0, 4) + '****',
      ifscCode,
    });

    // Simulate network delay
    await simulateDelay();

    // Mock validation - always returns valid for testing
    // In production, this would query the bank API or use IFSC lookup
    return {
      success: true,
      valid: true,
      accountHolderName: 'Mock Account Holder',
      bankName: 'Mock Bank',
    };
  } catch (error: any) {
    logger.error('❌ Error validating bank account:', error);
    return {
      success: false,
      valid: false,
      error: error.message || 'Failed to validate bank account',
    };
  }
}








