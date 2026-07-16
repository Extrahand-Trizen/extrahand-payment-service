import { Request, Response } from 'express';
import { prisma, prismaDev } from '../config/prisma';
import { applyPayoutStatusToProfile } from '../services/userPaymentProfileService';
import { notifyPayoutCompleted } from '../services/paymentNotificationService';
import { Prisma } from '@prisma/client';
import { BadRequestError, NotFoundError } from '../errors/AppError';
import { createRefundAmountPaise } from '../services/paymentService';
import { createLedgerEntry, getEscrowBalance } from '../services/ledgerService';
import { toAdminBankAccount } from '../services/bankAccountSecrets';
import { calculateFees } from '../services/feeCalculationService';
import logger from '../config/logger';

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

/**
 * Build a raw SQL query for Escrow listing with COUNT(*) OVER() window function.
 * Avoids separate COUNT(*) + findMany + include subquery — all in one round-trip.
 */
function buildEscrowQuery(
  where: Prisma.EscrowWhereInput,
  limit: number,
  offset: number,
): { sql: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (where.status && typeof where.status === 'string') {
    conditions.push(`"status" = $${idx++}`);
    params.push(where.status);
  }

  const createdAt = where.createdAt as { gte?: Date; lte?: Date } | undefined;
  if (createdAt) {
    if (createdAt.gte) {
      conditions.push(`"createdAt" >= $${idx++}`);
      params.push(createdAt.gte);
    }
    if (createdAt.lte) {
      conditions.push(`"createdAt" <= $${idx++}`);
      params.push(createdAt.lte);
    }
  }

  const orClauses = where.OR as Array<Record<string, any>> | undefined;
  if (orClauses && orClauses.length > 0) {
    const orParts: string[] = [];
    for (const clause of orClauses) {
      for (const [col, val] of Object.entries(clause)) {
        if (val && typeof val === 'object' && 'contains' in val) {
          orParts.push(`"${col}"::text ILIKE $${idx++}`);
          params.push(`%${val.contains}%`);
        }
      }
    }
    if (orParts.length > 0) {
      conditions.push(`(${orParts.join(' OR ')})`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT *, COUNT(*) OVER() AS _total_count
    FROM "Escrow"
    ${whereClause}
    ORDER BY "createdAt" DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;
  params.push(limit, offset);

  return { sql, params };
}

function toStringValue(value: Prisma.Decimal | string | number | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Prisma.Decimal) return value.toString();
  return String(value);
}

/** Returns true only when metadata.teamTest === true. null/undefined/false = real transaction. */
function isTeamTest(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).teamTest === true;
}

export class AdminFinanceController {
  static async getTransactionMetrics(req: Request, res: Response): Promise<void> {
    const { startDate, endDate } = req.query;
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    // Fetch without teamTest DB filter — Prisma JSONB NOT filter misses null/missing-key rows.
    // We filter in JS after fetching so null/missing teamTest correctly counts as real.
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
      if (start) { refundWhere.createdAt.gte = start; payoutWhere.createdAt.gte = start; }
      if (end) { refundWhere.createdAt.lte = end; payoutWhere.createdAt.lte = end; }
    }

    // Fetch all escrows, refunds, payouts from primary DB
    const [mainEscrows, mainRefunds, mainPayouts] = await Promise.all([
      prisma.escrow.findMany({ where: escrowWhere, select: { escrowId: true, paymentStatus: true, amountInRupees: true, metadata: true } }),
      prisma.refund.findMany({ where: refundWhere, select: { refundId: true, refundAmount: true, escrow: { select: { metadata: true } } }, }),
      prisma.payout.findMany({ where: payoutWhere, select: { payoutId: true, netAmount: true, metadata: true, escrow: { select: { metadata: true } } }, }),
    ]);

    let allEscrows = mainEscrows as any[];
    let allRefunds = mainRefunds as any[];
    let allPayouts = mainPayouts as any[];

    // Merge from secondary DB
    if (prismaDev) {
      try {
        const [devEscrows, devRefunds, devPayouts] = await Promise.all([
          prismaDev.escrow.findMany({ where: escrowWhere, select: { escrowId: true, paymentStatus: true, amountInRupees: true, metadata: true } }),
          prismaDev.refund.findMany({ where: refundWhere, select: { refundId: true, refundAmount: true, escrow: { select: { metadata: true } } }, }),
          prismaDev.payout.findMany({ where: payoutWhere, select: { payoutId: true, netAmount: true, metadata: true, escrow: { select: { metadata: true } } }, }),
        ]);
        const seenEscrows = new Set(allEscrows.map((r: any) => r.escrowId));
        allEscrows = [...allEscrows, ...(devEscrows as any[]).filter((r: any) => !seenEscrows.has(r.escrowId))];
        const seenRefunds = new Set(allRefunds.map((r: any) => r.refundId));
        allRefunds = [...allRefunds, ...(devRefunds as any[]).filter((r: any) => !seenRefunds.has(r.refundId))];
        const seenPayouts = new Set(allPayouts.map((r: any) => r.payoutId));
        allPayouts = [...allPayouts, ...(devPayouts as any[]).filter((r: any) => !seenPayouts.has(r.payoutId))];
      } catch (err: any) {
        logger.warn('Failed to query secondary DB for metrics:', { message: err?.message });
      }
    }

    // JS filter: real = teamTest is NOT true (null / missing key / false all count as real)
    const realEscrows = allEscrows.filter((e: any) => !isTeamTest(e.metadata));
    const realRefunds = allRefunds.filter((r: any) => !isTeamTest(r.escrow?.metadata));
    const realPayouts = allPayouts.filter((p: any) => !isTeamTest(p.metadata) && !isTeamTest(p.escrow?.metadata));

    const captured = realEscrows.filter((e: any) => e.paymentStatus === 'captured');
    const failed = realEscrows.filter((e: any) => e.paymentStatus === 'failed');
    const mergedCaptured = captured.length;
    const mergedFailed = failed.length;
    const mergedPayins = captured.reduce((sum: number, e: any) => sum + Number(e.amountInRupees ?? 0), 0);
    const mergedRefunds = realRefunds.reduce((sum: number, r: any) => sum + Number(r.refundAmount ?? 0), 0);
    const mergedPayouts = realPayouts.reduce((sum: number, p: any) => sum + Number(p.netAmount ?? 0), 0);
    const totalAttempts = mergedCaptured + mergedFailed;
    const successRate = totalAttempts > 0 ? mergedCaptured / totalAttempts : 0;

    res.json({
      success: true,
      metrics: {
        totalPayins: mergedPayins > 0 ? mergedPayins.toFixed(2) : null,
        totalRefunds: mergedRefunds > 0 ? mergedRefunds.toFixed(2) : null,
        totalPayouts: mergedPayouts > 0 ? mergedPayouts.toFixed(2) : null,
        capturedCount: mergedCaptured,
        failedCount: mergedFailed,
        successRate,
      },
    });
  }


  static async getTransactions(req: Request, res: Response): Promise<void> {
    const { status, q, startDate, endDate } = req.query;
    const transactionType = typeof req.query.transactionType === 'string' ? req.query.transactionType : undefined;
    const holdStatus = typeof req.query.holdStatus === 'string' ? req.query.holdStatus : undefined;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.EscrowWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }

    // Apply holdStatus filter if provided
    if (holdStatus) {
      where.status = holdStatus;
    }

    // NOTE: transactionType filter (real/team) is applied in JS after merging both DBs
    // to avoid Prisma JSONB NOT null-propagation bug that drops rows with null/missing teamTest.

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

    let allRows: any[] = [];
    let total = 0;

    // Determine which DB to use based on the explicit 'environment' query param.
    // 'production' (default) → prisma (ep-solitary-frost)
    // 'development'          → prismaDev (ep-solitary-violet)
    // Never fetch from both simultaneously.
    const environment = typeof req.query.environment === 'string' ? req.query.environment : 'production';
    const useDevDb = environment === 'development' && prismaDev != null;
    const targetPrisma = useDevDb ? prismaDev! : prisma;

    // Use COUNT(*) OVER() window function — single round-trip, no separate COUNT query
    const query = buildEscrowQuery(where, limit, offset);
    const raw: any[] = await targetPrisma.$queryRawUnsafe(query.sql, ...query.params);
    total = raw.length > 0 ? Number(raw[0]._total_count) : 0;
    // $queryRawUnsafe does not auto-parse JSONB — do it manually
    allRows = raw.map((r: any) => ({
      ...r,
      metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? null),
    }));

    // Apply transactionType filter in JS (avoids Prisma JSONB NOT null-propagation bug)
    if (transactionType === 'real') {
      allRows = allRows.filter((r: any) => !isTeamTest(r.metadata));
    } else if (transactionType === 'team') {
      allRows = allRows.filter((r: any) => isTeamTest(r.metadata));
    }
    // total is already correct from COUNT(*) OVER() — do NOT overwrite with allRows.length.
    // SQL already applied LIMIT/OFFSET so allRows is the correct page slice.

    // Batch fetch payouts for these escrows (instead of per-row include subquery)
    let payoutByEscrowId = new Map<string, any>();
    if (allRows.length > 0) {
      const escrowDbIds = allRows.map((r: any) => r.id);
      const payouts = await prisma.payout.findMany({
        where: { escrowId: { in: escrowDbIds } },
        select: { escrowId: true, performerUid: true, netAmount: true, amount: true, status: true },
        orderBy: { createdAt: 'desc' },
        // take: 1 per escrow — handled by groupBy in JS
      });
      for (const p of payouts) {
        if (p.escrowId && !payoutByEscrowId.has(p.escrowId)) {
          payoutByEscrowId.set(p.escrowId, p);
        }
      }
    }

    const data = allRows.map((escrow: any) => {
      const metadata = escrow.metadata && typeof escrow.metadata === 'object' ? (escrow.metadata as Record<string, unknown>) : {};
      const linkedPayout = payoutByEscrowId.get(escrow.id) ?? null;
      let payoutNetAmount: string | null = null;
      if (linkedPayout) {
        payoutNetAmount = toStringValue(linkedPayout.netAmount);
      } else if (escrow.taskAmount != null) {
        try {
          const taskAmount = new Prisma.Decimal(Number(escrow.taskAmount));
          const commission = taskAmount.mul(0.05).toDecimalPlaces(2);
          const gstOnCommission = commission.mul(0.18).toDecimalPlaces(2);
          const netAmount = taskAmount.sub(commission).sub(gstOnCommission).toDecimalPlaces(2);
          payoutNetAmount = netAmount.toString();
        } catch { /* ignore */ }
      }
      const resolvedPerformerUid =
        linkedPayout?.performerUid ||
        (escrow.performerUid !== 'pending_assignment' ? escrow.performerUid : null);
      return {
        escrowId: escrow.escrowId,
        razorpayOrderId: escrow.razorpayOrderId,
        razorpayPaymentId: escrow.razorpayPaymentId,
        taskId: escrow.taskId,
        applicationId: escrow.applicationId,
        CustomerUid: escrow.posterUid,
        performerUid: resolvedPerformerUid || 'pending_assignment',
        status: escrow.status,
        paymentStatus: escrow.paymentStatus,
        amountInRupees: toStringValue(new Prisma.Decimal(Number(escrow.amountInRupees))),
        payoutAmount: payoutNetAmount,
        createdAt: escrow.createdAt,
        teamTest: metadata.teamTest === true,
        teamTestTransferred: metadata.teamTestTransferred === true,
      };
    });

    const page = Math.floor(offset / limit) + 1;
    const pages = Math.ceil(total / limit);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages },
    });
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

  static async updateTransactionTeamTest(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { teamTest, teamTestTransferred } = req.body || {};
    if (!id) throw new BadRequestError('Transaction id is required');
    if (typeof teamTest !== 'boolean' && typeof teamTestTransferred !== 'boolean') {
      throw new BadRequestError('teamTest or teamTestTransferred must be provided as boolean');
    }

    let targetPrisma = prisma;
    let escrow = await prisma.escrow.findFirst({
      where: {
        OR: [
          { id },
          { escrowId: id },
          { razorpayOrderId: id },
          { razorpayPaymentId: id },
        ],
      },
    });
    if (!escrow && prismaDev) {
      escrow = await prismaDev.escrow.findFirst({
        where: {
          OR: [
            { id },
            { escrowId: id },
            { razorpayOrderId: id },
            { razorpayPaymentId: id },
          ],
        },
      });
      if (escrow) {
        targetPrisma = prismaDev;
      }
    }
    if (!escrow) throw new NotFoundError('Transaction not found');

    const existingMetadata = escrow.metadata && typeof escrow.metadata === 'object' ? (escrow.metadata as Record<string, unknown>) : {};
    const updatedMetadata: Record<string, unknown> = { ...existingMetadata };
    if (typeof teamTest === 'boolean') {
      updatedMetadata.teamTest = teamTest;
    }
    if (typeof teamTestTransferred === 'boolean') {
      updatedMetadata.teamTestTransferred = teamTestTransferred;
    }

    const updated = await targetPrisma.escrow.update({
      where: { id: escrow.id },
      data: {
        metadata: updatedMetadata as Prisma.InputJsonValue,
      },
    });

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'escrow',
        entityId: updated.id,
        action: 'status_changed',
        actorType: 'admin',
        newValue: updatedMetadata as Prisma.InputJsonValue,
      },
    });

    res.json({
      success: true,
      escrow: {
        escrowId: updated.escrowId,
        teamTest: updatedMetadata.teamTest === true,
        teamTestTransferred: updatedMetadata.teamTestTransferred === true,
      },
    });
  }

  static async updatePayoutTeamTest(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { teamTest } = req.body || {};
    if (!id) throw new BadRequestError('Payout id is required');
    if (typeof teamTest !== 'boolean') {
      throw new BadRequestError('teamTest must be a boolean');
    }

    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }
    if (!payout) throw new NotFoundError('Payout not found');

    const existingMetadata = payout.metadata && typeof payout.metadata === 'object' ? (payout.metadata as Record<string, unknown>) : {};
    const updatedMetadata: Record<string, unknown> = { ...existingMetadata, teamTest };

    const updated = await targetPrisma.payout.update({
      where: { id: payout.id },
      data: { metadata: updatedMetadata as Prisma.InputJsonValue },
    });

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'payout',
        entityId: updated.id,
        action: 'status_changed',
        actorType: 'admin',
        newValue: updatedMetadata as Prisma.InputJsonValue,
      },
    });

    res.json({
      success: true,
      payout: {
        payoutId: updated.payoutId,
        teamTest: updatedMetadata.teamTest === true,
      },
    });
  }

  static async updateRefundTeamTest(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const { teamTest } = req.body || {};
    if (!id) throw new BadRequestError('Refund id is required');
    if (typeof teamTest !== 'boolean') {
      throw new BadRequestError('teamTest must be a boolean');
    }

    let targetPrisma = prisma;
    let refund = await prisma.refund.findFirst({
      where: { OR: [{ id }, { refundId: id }] },
      include: { escrow: true },
    });
    if (!refund && prismaDev) {
      refund = await prismaDev.refund.findFirst({
        where: { OR: [{ id }, { refundId: id }] },
        include: { escrow: true },
      });
      if (refund) {
        targetPrisma = prismaDev;
      }
    }
    if (!refund) throw new NotFoundError('Refund not found');

    // Update the linked escrow's metadata (same as how pay-in transactions work)
    if (refund.escrow) {
      const existingMeta =
        refund.escrow.metadata && typeof refund.escrow.metadata === 'object'
          ? (refund.escrow.metadata as Record<string, unknown>)
          : {};
      const updatedMeta: Record<string, unknown> = { ...existingMeta, teamTest };
      await targetPrisma.escrow.update({
        where: { id: refund.escrow.id },
        data: { metadata: updatedMeta as Prisma.InputJsonValue },
      });
    }

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'refund',
        entityId: refund.id,
        action: 'team_test_updated',
        actorType: 'admin',
        newValue: { teamTest },
      },
    });

    res.json({
      success: true,
      refund: {
        refundId: refund.refundId,
        teamTest,
      },
    });
  }

  static async updatePayoutStatus(req: Request, res: Response): Promise<void> {
    // Express may leave encoded path segments as-is depending on settings; normalize both forms.
    const rawId = String(req.params.id || '').trim();
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      id = rawId;
    }
    const { status } = req.body || {};
    if (!id) throw new BadRequestError('Payout id is required');
    if (!status || typeof status !== 'string') {
      throw new BadRequestError('status is required');
    }

    const allowedStatuses = ['pending', 'processing', 'completed', 'failed', 'held'];
    if (!allowedStatuses.includes(status)) {
      throw new BadRequestError(`Invalid payout status. Allowed values: ${allowedStatuses.join(', ')}`);
    }

    let targetPrisma = prisma;
    // Match by internal UUID, business payoutId, or bankTransferId (RazorpayX pout_*)
    let payout = await prisma.payout.findFirst({
      where: {
        OR: [{ id }, { payoutId: id }, { bankTransferId: id }],
      },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: {
          OR: [{ id }, { payoutId: id }, { bankTransferId: id }],
        },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }
    if (!payout) {
      logger.warn('Admin payout status update: payout not found', {
        lookupId: id,
        status,
      });
      throw new NotFoundError('Payout not found');
    }

    const updated = await targetPrisma.payout.update({
      where: { id: payout.id },
      data: {
        status,
        ...(status === 'completed'
          ? { completedAt: payout.completedAt ?? new Date() }
          : {}),
      },
    });

    if (targetPrisma === prisma) {
      applyPayoutStatusToProfile(
        payout.performerUid,
        payout.status,
        status,
        payout.netAmount,
        payout.payoutId,
      ).catch((err) => {
        logger.warn('Failed to sync UserPaymentProfile after admin payout status change', {
          payoutId: payout.payoutId,
          error: err?.message,
        });
      });

      if (status === 'completed' && payout.status !== 'completed') {
        const metadata =
          payout.metadata && typeof payout.metadata === 'object' && !Array.isArray(payout.metadata)
            ? (payout.metadata as Record<string, unknown>)
            : {};
        const taskId = typeof metadata.taskId === 'string' ? metadata.taskId : null;
        const taskTitle = typeof metadata.taskTitle === 'string' ? metadata.taskTitle : null;
        notifyPayoutCompleted({
          performerUid: payout.performerUid,
          amount: payout.netAmount.toString(),
          taskId,
          taskTitle,
        }).catch((err) => {
          logger.warn('Failed to send payout completed notification after admin status change', {
            payoutId: payout.payoutId,
            error: err?.message,
          });
        });
      }
    }

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'payout',
        entityId: updated.id,
        action: 'status_changed',
        actorType: 'admin',
        newValue: { status },
      },
    });

    res.json({ success: true, payout: updated });
  }

  static async getPayouts(req: Request, res: Response): Promise<void> {
    const { status, q, startDate, endDate } = req.query;
    const transactionType = typeof req.query.transactionType === 'string' ? req.query.transactionType : undefined;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.PayoutWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }

    // NOTE: transactionType filter applied in JS after merging to avoid Prisma JSONB NOT bug.
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

    // Route to single DB based on environment param — never both simultaneously
    const environment = typeof req.query.environment === 'string' ? req.query.environment : 'production';
    const useDevDb = environment === 'development' && prismaDev != null;
    const targetPrisma = useDevDb ? prismaDev! : prisma;

    // Fetch count and page in parallel — single DB, one round-trip pair
    const [payoutTotal, payoutRows] = await Promise.all([
      targetPrisma.payout.count({ where }),
      targetPrisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: { escrow: true },
      }),
    ]);

    // Apply transactionType filter in JS (avoids Prisma JSONB NOT null-propagation bug)
    let filteredRows = payoutRows as any[];
    if (transactionType === 'real') {
      filteredRows = filteredRows.filter((r: any) => !isTeamTest(r.metadata) && !isTeamTest(r.escrow?.metadata));
    } else if (transactionType === 'team') {
      filteredRows = filteredRows.filter((r: any) => isTeamTest(r.metadata) || isTeamTest(r.escrow?.metadata));
    }

    const data = filteredRows.map((row: any) => ({
      payoutId: row.payoutId,
      performerUid: row.performerUid,
      taskId: row.taskId || row.escrow?.taskId || null,
      CustomerUid: row.escrow?.posterUid || null,
      amount: toStringValue(row.amount),
      netAmount: toStringValue(row.netAmount),
      status: row.status,
      source: row.source,
      createdAt: row.createdAt,
      metadata: row.metadata ?? null,
    }));

    const page = Math.floor(offset / limit) + 1;
    const pages = Math.ceil(payoutTotal / limit);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total: payoutTotal, pages },
    });
  }

  static async getPayoutById(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
      include: { escrow: true },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
        include: { escrow: true },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }

    if (!payout) throw new NotFoundError('Payout not found');

    const ledger = await targetPrisma.ledger.findMany({
      where: { payoutId: payout.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, payout, ledger });
  }

  static async retryPayout(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Payout id is required');

    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }
    if (!payout) throw new NotFoundError('Payout not found');

    const jobId = `payout_retry_${payout.payoutId}`;
    // Always upsert to primary jobQueue as that is where active workers poll jobs
    await prisma.jobQueue.upsert({
      where: { jobId },
      create: {
        jobId,
        jobType: 'payout_retry',
        entityType: 'payout',
        entityId: payout.id,
        payload: { payoutId: payout.payoutId, useDevDb: targetPrisma === prismaDev },
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

    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }
    if (!payout) throw new NotFoundError('Payout not found');

    const updated = await targetPrisma.payout.update({
      where: { id: payout.id },
      data: {
        status: 'held',
        errorMessage: reason || payout.errorMessage,
      },
    });

    await targetPrisma.auditLog.create({
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
    const transactionType = typeof req.query.transactionType === 'string' ? req.query.transactionType : undefined;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);
    const search = typeof q === 'string' && q.trim() ? q.trim() : undefined;

    const where: Prisma.RefundWhereInput = {};
    if (status && typeof status === 'string') {
      where.status = status;
    }

    // NOTE: transactionType filter applied in JS after merging to avoid Prisma JSONB NOT bug.
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

    let mainRefundTotal = 0;
    let refundRows: any[] = [];

    [mainRefundTotal, refundRows] = await Promise.all([
      prisma.refund.count({ where }),
      prisma.refund.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: prismaDev ? 2000 : limit,
        skip: prismaDev ? 0 : offset,
        include: { escrow: true },
      }),
    ]);

    let refundTotal = mainRefundTotal;

    if (prismaDev) {
      try {
        const [devRefundTotal, devRefundRows] = await Promise.all([
          prismaDev.refund.count({ where }),
          prismaDev.refund.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 2000,
            skip: 0,
            include: { escrow: true },
          }),
        ]);
        const seen = new Set(refundRows.map((r: any) => r.refundId));
        const uniqueDev = devRefundRows.filter((r: any) => !seen.has(r.refundId));
        refundRows = [...refundRows, ...uniqueDev];
        refundRows.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      } catch (err: any) {
        logger.warn('Failed to query secondary DB for refunds:', { message: err?.message });
      }
    }

    // Apply transactionType filter in JS (avoids Prisma JSONB NOT null-propagation bug)
    if (transactionType === 'real') {
      refundRows = refundRows.filter((r: any) => !isTeamTest(r.escrow?.metadata));
    } else if (transactionType === 'team') {
      refundRows = refundRows.filter((r: any) => isTeamTest(r.escrow?.metadata));
    }
    refundTotal = refundRows.length;
    refundRows = refundRows.slice(offset, offset + limit);

    const data = refundRows.map((row: any) => {
      // Read teamTest from the linked Escrow metadata (mirrors pay-ins/transactions approach)
      const escrowMeta =
        row.escrow?.metadata && typeof row.escrow.metadata === 'object'
          ? (row.escrow.metadata as Record<string, unknown>)
          : {};
      return {
        refundId: row.refundId,
        taskId: row.taskId,
        CustomerUid: row.escrow?.posterUid,
        performerUid: row.escrow?.performerUid,
        refundAmount: toStringValue(row.refundAmount),
        status: row.status,
        createdAt: row.createdAt,
        teamTest: escrowMeta.teamTest === true,
      };
    });

    const page = Math.floor(offset / limit) + 1;
    const pages = Math.ceil(refundTotal / limit);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total: refundTotal, pages },
    });
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
        include: { escrow: true },
      }),
    ]);

    const data = rows.map((row) => ({
      transactionId: row.transactionId,
      type: row.type,
      amount: toStringValue(row.amount),
      taskId: row.taskId,
      CustomerUid: row.escrow?.posterUid,
      performerUid: row.escrow?.performerUid,
      createdAt: row.createdAt,
    }));

    const page = Math.floor(offset / limit) + 1;
    const pages = Math.ceil(total / limit);

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, pages },
    });
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

    res.json({
      success: true,
      profile,
      bankAccounts: bankAccounts.map((row) => toAdminBankAccount(row)),
    });
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

    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id: payoutId }, { payoutId }] },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id: payoutId }, { payoutId }] },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }

    if (!payout) throw new NotFoundError('Payout not found');

    const updated = await targetPrisma.payout.update({
      where: { id: payout.id },
      data: { status: 'held', errorMessage: reason || payout.errorMessage },
    });

    await targetPrisma.auditLog.create({
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

  static async deleteTransaction(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Transaction ID is required');

    let targetPrisma = prisma;
    let escrow = await prisma.escrow.findFirst({
      where: { OR: [{ id }, { escrowId: id }] },
    });
    if (!escrow && prismaDev) {
      escrow = await prismaDev.escrow.findFirst({
        where: { OR: [{ id }, { escrowId: id }] },
      });
      if (escrow) {
        targetPrisma = prismaDev;
      }
    }
    if (!escrow) throw new NotFoundError('Transaction not found');

    await targetPrisma.escrow.delete({
      where: { id: escrow.id },
    });

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'escrow',
        entityId: escrow.id,
        action: 'deleted',
        actorType: 'admin',
        newValue: { deleted: true, escrowId: escrow.escrowId } as Prisma.InputJsonValue,
      },
    });

    res.json({ success: true, message: 'Transaction deleted successfully' });
  }

  static async deletePayout(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Payout ID is required');

    let targetPrisma = prisma;
    let payout = await prisma.payout.findFirst({
      where: { OR: [{ id }, { payoutId: id }] },
    });
    if (!payout && prismaDev) {
      payout = await prismaDev.payout.findFirst({
        where: { OR: [{ id }, { payoutId: id }] },
      });
      if (payout) {
        targetPrisma = prismaDev;
      }
    }
    if (!payout) throw new NotFoundError('Payout not found');

    await targetPrisma.payout.delete({
      where: { id: payout.id },
    });

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'payout',
        entityId: payout.id,
        action: 'deleted',
        actorType: 'admin',
        newValue: { deleted: true, payoutId: payout.payoutId } as Prisma.InputJsonValue,
      },
    });

    res.json({ success: true, message: 'Payout deleted successfully' });
  }

  static async deleteRefund(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    if (!id) throw new BadRequestError('Refund ID is required');

    let targetPrisma = prisma;
    let refund = await prisma.refund.findFirst({
      where: { OR: [{ id }, { refundId: id }] },
    });
    if (!refund && prismaDev) {
      refund = await prismaDev.refund.findFirst({
        where: { OR: [{ id }, { refundId: id }] },
      });
      if (refund) {
        targetPrisma = prismaDev;
      }
    }
    if (!refund) throw new NotFoundError('Refund not found');

    await targetPrisma.refund.delete({
      where: { id: refund.id },
    });

    await targetPrisma.auditLog.create({
      data: {
        entityType: 'refund',
        entityId: refund.id,
        action: 'deleted',
        actorType: 'admin',
        newValue: { deleted: true, refundId: refund.refundId } as Prisma.InputJsonValue,
      },
    });

    res.json({ success: true, message: 'Refund deleted successfully' });
  }
}

