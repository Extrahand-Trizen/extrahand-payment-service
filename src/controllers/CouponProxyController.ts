import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { ensurePostgresReady } from '../config/database';
import { CouponClient } from '../clients/CouponClient';
import { BadRequestError } from '../errors/AppError';

/**
 * Internal: used by coupon-service for firstBookingOnly checks.
 * Successful = escrow payment captured / held / released (any Book Now or marketplace pay-in).
 */
export async function hasSuccessfulPayment(req: Request, res: Response): Promise<void> {
  const userId = String(req.params.userId || '').trim();
  if (!userId) {
    throw new BadRequestError('userId is required');
  }

  if (!(await ensurePostgresReady())) {
    res.status(503).json({
      success: false,
      hasSuccessfulPayment: false,
      error: 'Payment database not ready',
    });
    return;
  }

  const count = await prisma.escrow.count({
    where: {
      posterUid: userId,
      OR: [
        { paymentStatus: 'captured' },
        { status: { in: ['held', 'released', 'completed'] } },
      ],
    },
  });

  res.json({
    success: true,
    hasSuccessfulPayment: count > 0,
    paymentCount: count,
  });
}

/**
 * Customer validate coupon — Payment Service proxies to Coupon Service (no local rules).
 */
export async function validateCoupon(req: Request, res: Response): Promise<void> {
  const userId = String(
    (req as any).user?.uid ||
      req.headers['x-user-id'] ||
      req.body?.userId ||
      ''
  ).trim();

  if (!userId) {
    throw new BadRequestError('Authenticated user is required');
  }

  const couponCode = String(req.body?.couponCode || '').trim();
  const flowTypeRaw = String(req.body?.flowType || '').toUpperCase();
  const flowType =
    flowTypeRaw === 'BOOK_NOW' ||
    flowTypeRaw === 'POST_COMPARE' ||
    flowTypeRaw === 'QUICK_COMMERCE'
      ? flowTypeRaw
      : null;
  const amount = Number(req.body?.amount);

  if (!couponCode) throw new BadRequestError('couponCode is required');
  if (!flowType) {
    throw new BadRequestError('flowType must be BOOK_NOW, POST_COMPARE, or QUICK_COMMERCE');
  }
  if (!(amount > 0)) throw new BadRequestError('amount must be a positive number');

  const result = await CouponClient.validate({
    couponCode,
    userId,
    flowType,
    amount,
    serviceIds: Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : [],
    lineItems: Array.isArray(req.body?.lineItems) ? req.body.lineItems : [],
  });

  if (!result.valid) {
    res.status(400).json({
      success: false,
      valid: false,
      code: result.code,
      message: result.message || result.error,
      error: result.message || result.error,
    });
    return;
  }

  res.json({
    success: true,
    valid: true,
    couponId: result.couponId,
    couponCode: result.couponCode,
    discountType: result.discountType,
    discountAmount: result.discountAmount,
    originalAmount: result.originalAmount,
    amountAfterCoupon: result.amountAfterCoupon,
    eligibleAmount: result.eligibleAmount,
    eligibleServiceIds: result.eligibleServiceIds,
  });
}

/**
 * List coupons for checkout with AVAILABLE / ALREADY_USED / NOT_AVAILABLE status.
 */
export async function listEligibleCoupons(req: Request, res: Response): Promise<void> {
  const userId = String(
    (req as any).user?.uid ||
      req.headers['x-user-id'] ||
      req.body?.userId ||
      ''
  ).trim();

  if (!userId) {
    throw new BadRequestError('Authenticated user is required');
  }

  const flowTypeRaw = String(req.body?.flowType || '').toUpperCase();
  const flowType =
    flowTypeRaw === 'BOOK_NOW' ||
    flowTypeRaw === 'POST_COMPARE' ||
    flowTypeRaw === 'QUICK_COMMERCE'
      ? flowTypeRaw
      : null;
  const amount = Number(req.body?.amount);

  if (!flowType) {
    throw new BadRequestError('flowType must be BOOK_NOW, POST_COMPARE, or QUICK_COMMERCE');
  }
  if (!(amount > 0)) throw new BadRequestError('amount must be a positive number');

  const result = await CouponClient.listEligible({
    userId,
    flowType,
    amount,
    serviceIds: Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : [],
    lineItems: Array.isArray(req.body?.lineItems) ? req.body.lineItems : [],
  });

  if (!result.success) {
    res.status(502).json({
      success: false,
      coupons: [],
      message: result.message || result.error || 'Unable to load coupons',
      error: result.message || result.error || 'Unable to load coupons',
    });
    return;
  }

  res.json({
    success: true,
    coupons: result.coupons || [],
  });
}
