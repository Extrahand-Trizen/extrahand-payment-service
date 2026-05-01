import { Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../errors/AppError';
import { createRefundAmountPaise } from '../services/paymentService';
import { createLedgerEntry, getEscrowBalance } from '../services/ledgerService';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_LIMIT);
}

function parseOffset(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(Math.floor(parsed), 0);
}

function toStringValue(value: Prisma.Decimal | string | number | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Prisma.Decimal) return value.toString();
  return String(value);
}

export class AdminFinanceController {
  static async getTransactionMetrics(req: Request, res: Response): Promise<void> {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const escrowWhere: Prisma.EscrowWhereInput = {};
    if (start || end) {
      escrowWhere.createdAt = {};
      if (start) escrowWhere.createdAt.gte = start;
      if (end) escrowWhere.createdAt.lte = end;
    }

    const refundWhere: Prisma.RefundWhereInput = { status: 'completed' };
    const payoutWhere: Prisma.PayoutWhereInput = { status: 'completed' };

    if (start || end) {
      refundWhere.createdAt = {};
      payoutWhere.createdAt = {};
      if (start) {
        refundWhere.createdAt.gte = start;
        payoutWhere.createdAt.gte = start;
      }
      if (end) {
        refundWhere.createdAt.lte = end;
        payoutWhere.createdAt.lte = end;
      }
    }

    const [capturedCount, failedCount, totalPayins, totalRefunds, totalPayouts] = await Promise.all([
      prisma.escrow.count({ where: { ...escrowWhere, paymentStatus: 'captured' } }),
      prisma.escrow.count({ where: { ...escrowWhere, paymentStatus: 'failed' } }),
      prisma.escrow.aggregate({
        where: { ...escrowWhere, paymentStatus: 'captured' },
        _sum: { amountInRupees: true },
      }),
      prisma.refund.aggregate({
        where: refundWhere,
        _sum: { refundAmount: true },
      }),
      prisma.payout.aggregate({
        where: payoutWhere,
        _sum: { netAmount: true },
      }),
    ]);

    const totalAttempts = capturedCount + failedCount;
    const successRate = totalAttempts > 0 ? capturedCount / totalAttempts : 0;

    res.json({
      success: true,
      metrics: {
        totalPayins: toStringValue(totalPayins._sum?.amountInRupees),
        totalRefunds: toStringValue(totalRefunds._sum?.refundAmount),
        totalPayouts: toStringValue(totalPayouts._sum?.netAmount),
        capturedCount,
        failedCount,
        successRate,
      },
    });
  }

  static async getTransactions(req: Request, res: Response): Promise<void> {
    const { status, q, startDate, endDate } = req.query;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.EscrowWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }

    if (search) {
      where.OR = [
        { escrowId: { contains: search, mode: 'insensitive' } },
        { razorpayOrderId: { contains: search, mode: 'insensitive' } },
        { razorpayPaymentId: { contains: search, mode: 'insensitive' } },
        { taskId: { contains: search, mode: 'insensitive' } },
        { posterUid: { contains: search, mode: 'insensitive' } },
        { performerUid: { contains: search, mode: 'insensitive' } },
      ];
    }

    // No nested includes — all required fields are directly on Escrow.
    // Nested include across 3 relations on large datasets caused 500 timeouts.
    const [total, rows] = await Promise.all([
      prisma.escrow.count({ where }),
      prisma.escrow.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    const data = rows.map((escrow) => ({
      escrowId: escrow.escrowId,
      razorpayOrderId: escrow.razorpayOrderId,
      razorpayPaymentId: escrow.razorpayPaymentId,
      taskId: escrow.taskId,
      applicationId: escrow.applicationId,
      posterUid: escrow.posterUid,
      performerUid: escrow.performerUid,
      status: escrow.status,
      paymentStatus: escrow.paymentStatus,
      amountInRupees: toStringValue(escrow.amountInRupees),
      createdAt: escrow.createdAt,
    }));

    res.json({ success: true, total, limit, offset, transactions: data });
  }

  static async getTransactionById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Transaction id is required');

    const escrow = await prisma.escrow.findFirst({
      where: {
        OR: [
          { id },
          { escrowId: id },
          { razorpayOrderId: id },
          { razorpayPaymentId: id },
        ],
      },
    });

    let resolvedEscrow = escrow;
    if (!resolvedEscrow) {
      const transaction = await prisma.transaction.findFirst({
        where: {
          OR: [{ id: id }, { razorpayPaymentId: id }, { razorpayOrderId: id }],
        },
      });
      if (transaction?.razorpayOrderId) {
        resolvedEscrow = await prisma.escrow.findUnique({
          where: { razorpayOrderId: transaction.razorpayOrderId },
        });
      }
    }

    if (!resolvedEscrow) {
      const payout = await prisma.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
        include: { escrow: true },
      });
      resolvedEscrow = payout?.escrow || null;
    }

    if (!resolvedEscrow) {
      const refund = await prisma.refund.findFirst({
        where: { OR: [{ id }, { refundId: id }] },
        include: { escrow: true },
      });
      resolvedEscrow = refund?.escrow || null;
    }

    if (!resolvedEscrow) throw new NotFoundError('Transaction not found');

    const [transactions, payouts, refunds, ledger] = await Promise.all([
      prisma.transaction.findMany({
        where: { razorpayOrderId: resolvedEscrow.razorpayOrderId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payout.findMany({
        where: { escrowId: resolvedEscrow.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.refund.findMany({
        where: { escrowId: resolvedEscrow.id },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.ledger.findMany({
        where: { escrowId: resolvedEscrow.id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    res.json({
      success: true,
      escrow: resolvedEscrow,
      transactions,
      payouts,
      refunds,
      ledger,
    });
  }

  static async getPayouts(req: Request, res: Response): Promise<void> {
    const { status, q, startDate, endDate } = req.query;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.PayoutWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }
    if (search) {
      where.OR = [
        { payoutId: { contains: search, mode: 'insensitive' } },
        { performerUid: { contains: search, mode: 'insensitive' } },
        { escrow: { taskId: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.payout.count({ where }),
      prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { escrow: true },
      }),
    ]);

    res.json({ success: true, total, limit, offset, payouts: rows });
  }

  static async getPayoutById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
      include: { escrow: true },
    });

    if (!payout) throw new NotFoundError('Payout not found');

    const ledger = await prisma.ledger.findMany({
      where: { payoutId: payout.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, payout, ledger });
  }

  static async retryPayout(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Payout id is required');

    const payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout) throw new NotFoundError('Payout not found');

    const jobId = `payout_retry_${payout.payoutId}`;
    await prisma.jobQueue.upsert({
      where: { jobId },
      create: {
        jobId,
        jobType: 'payout_retry',
        entityType: 'payout',
        entityId: payout.id,
        payload: { payoutId: payout.payoutId },
        status: 'pending',
        nextRetryAt: new Date(),
        priority: 5,
      },
      update: {
        status: 'pending',
        nextRetryAt: new Date(),
        lastError: null,
        attemptCount: 0,
      },
    });

    res.json({ success: true, payoutId: payout.payoutId, jobId });
  }

  static async holdPayout(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { reason } = req.body || {};
    if (!id) throw new BadRequestError('Payout id is required');

    const payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout) throw new NotFoundError('Payout not found');

    const updated = await prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: 'held',
        errorMessage: reason || payout.errorMessage,
      },
    });

    await prisma.auditLog.create({
      data: {
        entityType: 'payout',
        entityId: updated.id,
        action: 'status_changed',
        actorType: 'admin',
        newValue: { status: 'held', reason },
      },
    });

    res.json({ success: true, payout: updated });
  }

  static async getRefunds(req: Request, res: Response): Promise<void> {
    const { status, q, startDate, endDate } = req.query;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.RefundWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate as string);
      if (endDate) where.createdAt.lte = new Date(endDate as string);
    }
    if (search) {
      where.OR = [
        { refundId: { contains: search, mode: 'insensitive' } },
        { paymentId: { contains: search, mode: 'insensitive' } },
        { escrow: { taskId: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, rows] = await Promise.all([
      prisma.refund.count({ where }),
      prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { escrow: true },
      }),
    ]);

    res.json({ success: true, total, limit, offset, refunds: rows });
  }

  static async getRefundById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const refund = await prisma.refund.findFirst({
      where: { OR: [{ id }, { refundId: id }] },
      include: { escrow: true },
    });
    if (!refund) throw new NotFoundError('Refund not found');

    const ledger = await prisma.ledger.findMany({
      where: { refundId: refund.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, refund, ledger });
  }

  static async manualRefund(req: Request, res: Response): Promise<void> {
    const { razorpayOrderId, razorpayPaymentId, amount, reason, cancelledBy } = req.body || {};
    if (!razorpayOrderId || !razorpayPaymentId) {
      throw new BadRequestError('razorpayOrderId and razorpayPaymentId are required');
    }

    const escrow = await prisma.escrow.findUnique({ where: { razorpayOrderId } });
    if (!escrow) throw new NotFoundError('Escrow not found');

    const amountPaise = amount != null ? Math.round(Number(amount) * 100) : undefined;
    const fallbackPaise = Math.round(Number(escrow.amountInRupees.toString()) * 100);
    const razorpayRefund = await createRefundAmountPaise(
      razorpayPaymentId,
      amountPaise != null && Number.isFinite(amountPaise) ? amountPaise : fallbackPaise
    );

    if (!razorpayRefund.success) {
      throw new Error(razorpayRefund.error || 'Failed to create refund');
    }

    const refundId = `refund_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const refundAmount = new Prisma.Decimal(
      amount != null && Number.isFinite(Number(amount))
        ? Number(amount).toFixed(2)
        : escrow.amountInRupees.toString()
    );

    const refund = await prisma.refund.create({
      data: {
        refundId,
        escrowId: escrow.id,
        paymentId: razorpayPaymentId,
        razorpayRefundId: razorpayRefund.refund.id,
        refundAmount,
        status: 'completed',
        reason: reason || 'Manual refund',
        cancelledBy: cancelledBy || 'poster',
      },
    });

    await prisma.escrow.update({
      where: { id: escrow.id },
      data: { status: 'refunded', refundedAt: new Date() },
    });

    const balanceResult = await getEscrowBalance(escrow.id);
    const currentBalance = balanceResult.balance || new Prisma.Decimal('0.00');
    await createLedgerEntry({
      escrowId: escrow.id,
      refundId: refund.id,
      type: 'refund',
      amount: refundAmount.neg(),
      balanceBefore: currentBalance,
      balanceAfter: currentBalance.sub(refundAmount),
      description: `Manual refund: ${reason || 'No reason provided'}`,
      metadata: {
        refundId: refund.refundId,
        razorpayRefundId: refund.razorpayRefundId,
        reason,
      },
    });

    await prisma.auditLog.create({
      data: {
        entityType: 'refund',
        entityId: refund.id,
        action: 'created',
        actorType: 'admin',
        newValue: {
          refundId: refund.refundId,
          razorpayRefundId: refund.razorpayRefundId,
          refundAmount: refund.refundAmount.toString(),
        },
      },
    });

    res.json({ success: true, refund });
  }

  static async getLedger(req: Request, res: Response): Promise<void> {
    const { type, escrowId, payoutId, refundId } = req.query;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const where: Prisma.LedgerWhereInput = {};
    if (type && typeof type === 'string') where.type = type;
    if (escrowId && typeof escrowId === 'string') where.escrowId = escrowId;
    if (payoutId && typeof payoutId === 'string') where.payoutId = payoutId;
    if (refundId && typeof refundId === 'string') where.refundId = refundId;

    const [total, rows] = await Promise.all([
      prisma.ledger.count({ where }),
      prisma.ledger.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    res.json({ success: true, total, limit, offset, ledger: rows });
  }

  static async getLedgerById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const ledger = await prisma.ledger.findFirst({
      where: { OR: [{ id }, { transactionId: id }] },
    });
    if (!ledger) throw new NotFoundError('Ledger entry not found');

    res.json({ success: true, ledger });
  }

  static async getUserFinancialProfile(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('User id is required');

    const [profile, bankAccounts] = await Promise.all([
      prisma.userPaymentProfile.findUnique({ where: { userId: id } }),
      prisma.bankAccount.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } }),
    ]);

    res.json({ success: true, profile, bankAccounts });
  }

  static async getReconciliation(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const [total, rows, payinAgg, payoutAgg, refundAgg, escrowHeld] = await Promise.all([
      prisma.reconciliation.count(),
      prisma.reconciliation.findMany({
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset,
      }),
      // Computed: total captured pay-ins
      prisma.escrow.aggregate({
        where: { paymentStatus: 'captured' },
        _sum: { amountInRupees: true },
        _count: { _all: true },
      }),
      // Computed: total released payouts
      prisma.payout.aggregate({
        where: { status: { notIn: ['failed', 'held'] } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      // Computed: total completed refunds
      prisma.refund.aggregate({
        where: { status: 'completed' },
        _sum: { refundAmount: true },
        _count: { _all: true },
      }),
      // Computed: funds currently held in escrow
      prisma.escrow.aggregate({
        where: { status: 'held' },
        _sum: { amountInRupees: true },
        _count: { _all: true },
      }),
    ]);

    const computedSummary = {
      totalCaptures:      toStringValue(payinAgg._sum.amountInRupees) ?? '0',
      captureCount:       payinAgg._count._all,
      totalPayouts:       toStringValue(payoutAgg._sum.netAmount) ?? '0',
      payoutCount:        payoutAgg._count._all,
      totalRefunds:       toStringValue(refundAgg._sum.refundAmount) ?? '0',
      refundCount:        refundAgg._count._all,
      heldInEscrow:       toStringValue(escrowHeld._sum.amountInRupees) ?? '0',
      heldEscrowCount:    escrowHeld._count._all,
    };

    // ── Compute daily rows from actual transaction data ──────────────────────
    // Used when the formal Reconciliation table is empty (no reconciliation job has run).
    const windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [dailyEscrows, dailyPayouts, dailyRefunds] = await Promise.all([
      prisma.escrow.findMany({
        where: { paymentStatus: 'captured', createdAt: { gte: windowStart } },
        select: { amountInRupees: true, createdAt: true },
      }),
      prisma.payout.findMany({
        where: { status: { notIn: ['failed', 'held'] }, createdAt: { gte: windowStart } },
        select: { netAmount: true, createdAt: true },
      }),
      prisma.refund.findMany({
        where: { status: 'completed', createdAt: { gte: windowStart } },
        select: { refundAmount: true, createdAt: true },
      }),
    ]);

    // Group by YYYY-MM-DD
    const byDate: Record<string, {
      payins: number; payinCount: number;
      payouts: number; payoutCount: number;
      refunds: number; refundCount: number;
    }> = {};

    const getDate = (d: Date) => d.toISOString().split('T')[0];

    for (const e of dailyEscrows) {
      const k = getDate(e.createdAt);
      if (!byDate[k]) byDate[k] = { payins: 0, payinCount: 0, payouts: 0, payoutCount: 0, refunds: 0, refundCount: 0 };
      byDate[k].payins += Number(e.amountInRupees);
      byDate[k].payinCount += 1;
    }
    for (const p of dailyPayouts) {
      const k = getDate(p.createdAt);
      if (!byDate[k]) byDate[k] = { payins: 0, payinCount: 0, payouts: 0, payoutCount: 0, refunds: 0, refundCount: 0 };
      byDate[k].payouts += Number(p.netAmount);
      byDate[k].payoutCount += 1;
    }
    for (const r of dailyRefunds) {
      const k = getDate(r.createdAt);
      if (!byDate[k]) byDate[k] = { payins: 0, payinCount: 0, payouts: 0, payoutCount: 0, refunds: 0, refundCount: 0 };
      byDate[k].refunds += Number(r.refundAmount);
      byDate[k].refundCount += 1;
    }

    const computedDailyRows = Object.entries(byDate)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(offset, offset + limit)
      .map(([date, d]) => ({
        date,
        totalPayins:  d.payins.toFixed(2),
        payinCount:   d.payinCount,
        totalPayouts: d.payouts.toFixed(2),
        payoutCount:  d.payoutCount,
        totalRefunds: d.refunds.toFixed(2),
        refundCount:  d.refundCount,
        netFlow:      (d.payins - d.payouts - d.refunds).toFixed(2),
      }));

    res.json({
      success: true,
      total,
      limit,
      offset,
      reconciliations: rows,
      computedSummary,
      computedDailyRows,
      computedDailyTotal: Object.keys(byDate).length,
    });
  }

  static async getRiskFlags(req: Request, res: Response): Promise<void> {
    const duplicateAccounts = await prisma.bankAccount.groupBy({
      by: ['accountNumber', 'ifscCode'],
      _count: { _all: true },
      having: {
        accountNumber: { _count: { gt: 1 } },
      },
    });

    const refundAgg = await prisma.refund.groupBy({
      by: ['escrowId'],
      _count: { _all: true },
      where: { status: 'completed' },
    });

    res.json({
      success: true,
      flags: {
        duplicateBankAccounts: duplicateAccounts,
        refundCountsByEscrow: refundAgg,
      },
    });
  }

  static async freezeUser(req: Request, res: Response): Promise<void> {
    const { userId, reason } = req.body || {};
    if (!userId) throw new BadRequestError('userId is required');

    await prisma.auditLog.create({
      data: {
        entityType: 'user',
        entityId: userId,
        action: 'status_changed',
        actorType: 'admin',
        newValue: { status: 'frozen', reason },
      },
    });

    res.json({ success: true, userId, status: 'frozen' });
  }

  static async freezePayout(req: Request, res: Response): Promise<void> {
    const { payoutId, reason } = req.body || {};
    if (!payoutId) throw new BadRequestError('payoutId is required');

    const payout = await prisma.payout.findFirst({
      where: { OR: [{ id: payoutId }, { payoutId }] },
    });

    if (!payout) throw new NotFoundError('Payout not found');

    const updated = await prisma.payout.update({
      where: { id: payout.id },
      data: { status: 'held', errorMessage: reason || payout.errorMessage },
    });

    await prisma.auditLog.create({
      data: {
        entityType: 'payout',
        entityId: updated.id,
        action: 'status_changed',
        actorType: 'admin',
        newValue: { status: 'held', reason },
      },
    });

    res.json({ success: true, payout: updated });
  }

  static async getAuditLogs(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const [total, rows] = await Promise.all([
      prisma.auditLog.count(),
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    res.json({ success: true, total, limit, offset, logs: rows });
  }

  static async getAlerts(req: Request, res: Response): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [failedPayouts, failedPayments, completedRefunds] = await Promise.all([
      prisma.payout.count({ where: { status: 'failed', createdAt: { gte: since } } }),
      prisma.escrow.count({ where: { paymentStatus: 'failed', updatedAt: { gte: since } } }),
      prisma.refund.count({ where: { status: 'completed', createdAt: { gte: since } } }),
    ]);

    res.json({
      success: true,
      alerts: [
        {
          type: 'failed_payout_spike',
          count: failedPayouts,
          windowHours: 24,
        },
        {
          type: 'payment_failures',
          count: failedPayments,
          windowHours: 24,
        },
        {
          type: 'refund_spike',
          count: completedRefunds,
          windowHours: 24,
        },
      ],
    });
  }

  static async listUserProfiles(req: Request, res: Response): Promise<void> {
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;

    const where: any = q
      ? { userId: { contains: q, mode: 'insensitive' } }
      : {};

    const [total, profiles] = await Promise.all([
      prisma.userPaymentProfile.count({ where }),
      prisma.userPaymentProfile.findMany({
        where,
        orderBy: { lastUpdatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
    ]);

    const data = profiles.map((p) => ({
      userId: p.userId,
      totalEarnings:    toStringValue(p.totalEarnings),
      totalPayments:    toStringValue(p.totalPayments),
      totalRefunds:     toStringValue(p.totalRefunds),
      totalFees:        toStringValue(p.totalFees),
      payoutCount:      p.payoutCount,
      paymentCount:     p.paymentCount,
      refundCount:      p.refundCount,
      lastPayoutDate:   p.lastPayoutDate,
      lastPaymentDate:  p.lastPaymentDate,
      lastUpdatedAt:    p.lastUpdatedAt,
    }));

    res.json({ success: true, total, limit, offset, users: data });
  }
}
