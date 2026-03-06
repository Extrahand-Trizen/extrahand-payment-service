import { Response, Request } from 'express';
import { processPayout, getPayoutStatus, getPayoutsByEscrowId } from '../services/payoutService';
import { BadRequestError, NotFoundError, ForbiddenError } from '../errors/AppError';
import { getPaymentWithdrawalVerificationStatus } from '../lib/verificationGate';

export class PayoutController {
  /**
   * POST /api/v1/payouts/process
   * Process a payout to performer
   * STEP 5: Requires PAN + Bank verification
   */
  static async processPayout(req: Request, res: Response): Promise<void> {
    const {
      razorpayOrderId,
      performerUid,
      bankAccountId,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      userId,
      userProfile, // Profile should be passed from gateway after fetching
    } = req.body;

    // Validate required fields
    if (!razorpayOrderId || !performerUid) {
      throw new BadRequestError('razorpayOrderId and performerUid are required');
    }

    // STEP 5: Verify PAN and Bank verification before allowing withdrawal
    const verificationStatus = getPaymentWithdrawalVerificationStatus(userProfile || null);
    
    if (!verificationStatus.allowed) {
      throw new ForbiddenError(
        verificationStatus.message || 
        `Verification required for withdrawals. Please verify: ${verificationStatus.missing.join(", ")}`
      );
    }

    // Bank account validation: either bankAccountId OR account details
    if (!bankAccountId && (!accountNumber || !ifscCode || !accountHolderName)) {
      throw new BadRequestError(
        'Either bankAccountId or (accountNumber, ifscCode, accountHolderName) are required'
      );
    }

    const result = await processPayout({
      razorpayOrderId,
      performerUid,
      bankAccountId,
      accountNumber,
      ifscCode,
      accountHolderName,
      bankName,
      userId,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to process payout');
    }

    res.json({
      success: true,
      payout: result.payout,
    });
  }

  /**
   * GET /api/v1/payouts/status/:payoutId
   * Get payout status
   */
  static async getPayoutStatus(req: Request, res: Response): Promise<void> {
    const { payoutId } = req.params;

    if (!payoutId) {
      throw new BadRequestError('payoutId is required');
    }

    const result = await getPayoutStatus(payoutId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Payout not found');
    }

    res.json({
      success: true,
      payout: result.payout,
    });
  }

  /**
   * GET /api/v1/payouts/escrow/:escrowId
   * Get all payouts for an escrow
   */
  static async getPayoutsByEscrowId(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;

    if (!escrowId) {
      throw new BadRequestError('escrowId is required');
    }

    const result = await getPayoutsByEscrowId(escrowId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Payouts not found');
    }

    res.json({
      success: true,
      payouts: result.payouts,
    });
  }
}


