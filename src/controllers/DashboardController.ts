import { Request, Response } from 'express';
import { BadRequestError } from '../errors/AppError';
import {
  getDashboardAnomalies,
  getDashboardLedger,
  getDashboardOverview,
  getDashboardPayouts,
  getDashboardRefunds,
  getDashboardTransactions,
  getDashboardTransactionTrace,
  getDashboardUserFinancial,
  getDashboardReconciliationV2,
  retryPayoutById,
  listAdminTeam,
  createAdminInvite,
  updateAdminUserRole,
  disableAdminUser,
  getDashboardFees,
  getDashboardFeeCategories,
  updateDashboardFeeCategory,
} from '../services/dashboardService';

function parseDate(value: unknown, field: string): Date | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`Invalid ${field}. Expected ISO date string.`);
  }
  return date;
}

function parsePagination(req: Request) {
  const limitRaw = Number(req.query.limit ?? 50);
  const offsetRaw = Number(req.query.offset ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(Math.floor(offsetRaw), 0) : 0;
  return { limit, offset };
}

export class DashboardController {
  static async getOverview(req: Request, res: Response): Promise<void> {
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    const overview = await getDashboardOverview({ from, to });
    res.json({ success: true, overview });
  }

  static async getPayouts(req: Request, res: Response): Promise<void> {
    const { limit, offset } = parsePagination(req);
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const performerUid = typeof req.query.performerUid === 'string' ? req.query.performerUid : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;

    const result = await getDashboardPayouts({
      limit,
      offset,
      from,
      to,
      status,
      performerUid,
      source,
    });

    res.json({ success: true, ...result, limit, offset });
  }

  static async getRefunds(req: Request, res: Response): Promise<void> {
    const { limit, offset } = parsePagination(req);
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const cancelledBy = typeof req.query.cancelledBy === 'string' ? req.query.cancelledBy : undefined;
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;

    const result = await getDashboardRefunds({
      limit,
      offset,
      from,
      to,
      status,
      cancelledBy,
      taskId,
    });

    res.json({ success: true, ...result, limit, offset });
  }

  static async getLedger(req: Request, res: Response): Promise<void> {
    const { limit, offset } = parsePagination(req);
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type : undefined;
    const direction = typeof req.query.direction === 'string' ? req.query.direction : undefined;

    const result = await getDashboardLedger({
      limit,
      offset,
      from,
      to,
      userId,
      taskId,
      type,
      direction,
    });

    res.json({ success: true, ...result, limit, offset });
  }

  static async getAnomalies(_req: Request, res: Response): Promise<void> {
    const anomalies = await getDashboardAnomalies();
    res.json({ success: true, anomalies });
  }

  static async getTransactions(req: Request, res: Response): Promise<void> {
    const { limit, offset } = parsePagination(req);
    const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    if (!userId) throw new BadRequestError('userId is required');

    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    const type = typeof req.query.type === 'string' ? (req.query.type as any) : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const category = typeof req.query.category === 'string' ? (req.query.category as any) : undefined;
    const linkedUserIds =
      typeof req.query.linkedUserIds === 'string' && req.query.linkedUserIds.trim()
        ? req.query.linkedUserIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    const result = await getDashboardTransactions({
      userId,
      linkedUserIds,
      from,
      to,
      type,
      status,
      category,
      limit,
      offset,
    });

    res.json({ success: true, ...result, limit, offset });
  }

  static async getTransactionTrace(req: Request, res: Response): Promise<void> {
    const transactionRef = req.params.id;
    if (!transactionRef) throw new BadRequestError('transaction reference is required');
    const trace = await getDashboardTransactionTrace(transactionRef);
    res.json({ success: true, trace });
  }

  static async getUserFinancial(req: Request, res: Response): Promise<void> {
    const userId = req.params.userId;
    if (!userId) throw new BadRequestError('userId is required');
    const linkedUserIds =
      typeof req.query.linkedUserIds === 'string' && req.query.linkedUserIds.trim()
        ? req.query.linkedUserIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const result = await getDashboardUserFinancial(userId, linkedUserIds);
    res.json({ success: true, data: result });
  }

  static async getReconciliation(req: Request, res: Response): Promise<void> {
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    if (!from || !to) {
      throw new BadRequestError('from and to query params are required (ISO date strings)');
    }
    const mode = req.query.mode === 'orders' ? 'orders' : 'payments';
    const pageRaw = Number(req.query.page ?? 1);
    const limitRaw = Number(req.query.limit ?? 100);
    const page = Number.isFinite(pageRaw) ? Math.max(Math.floor(pageRaw), 1) : 1;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 500) : 100;
    const result = await getDashboardReconciliationV2({ from, to, mode, page, limit });
    res.json({ success: true, reconciliation: result });
  }

  static async exportReconciliationCsv(req: Request, res: Response): Promise<void> {
    const from = parseDate(req.query.from, 'from');
    const to = parseDate(req.query.to, 'to');
    if (!from || !to) {
      throw new BadRequestError('from and to query params are required (ISO date strings)');
    }
    const mode = req.query.mode === 'orders' ? 'orders' : 'payments';
    // Export all rows (up to safe cap per mismatch bucket page)
    const result = await getDashboardReconciliationV2({ from, to, mode, page: 1, limit: 500 });

    const lines: string[] = [];
    lines.push('bucket,referenceId,localId,razorpayAmountPaise,localAmountPaise,differencePaise,razorpayStatus,localStatus,localPaymentStatus');

    const pushRow = (cols: Array<string | number | null | undefined>) => {
      const escaped = cols.map((c) => {
        const value = c == null ? '' : String(c);
        const quoted = value.replace(/"/g, '""');
        return `"${quoted}"`;
      });
      lines.push(escaped.join(','));
    };

    const mismatches: any = result.mismatches;

    for (const row of mismatches.missingInDb?.items || []) {
      pushRow([
        'missingInDb',
        row.razorpayPaymentId || row.razorpayOrderId,
        '',
        row.amountPaise,
        '',
        '',
        row.status || '',
        '',
        '',
      ]);
    }
    for (const row of mismatches.amountMismatches?.items || []) {
      pushRow([
        'amountMismatches',
        row.razorpayPaymentId || row.razorpayOrderId,
        row.localEscrowId,
        row.razorpayAmountPaise,
        row.localAmountPaise,
        row.differencePaise,
        '',
        '',
        '',
      ]);
    }
    for (const row of mismatches.statusMismatches?.items || []) {
      pushRow([
        'statusMismatches',
        row.razorpayPaymentId || row.razorpayOrderId,
        row.localEscrowId,
        '',
        '',
        '',
        row.razorpayStatus,
        row.localEscrowStatus,
        row.localPaymentStatus || '',
      ]);
    }
    for (const row of mismatches.inDbNotInRazorpay?.items || []) {
      pushRow([
        'inDbNotInRazorpay',
        row.razorpayPaymentId || row.razorpayOrderId,
        row.localEscrowId,
        '',
        row.amountPaise,
        '',
        '',
        row.status || '',
        row.paymentStatus || '',
      ]);
    }

    const filename = `reconciliation_${mode}_${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(lines.join('\n'));
  }

  static async retryPayout(req: Request, res: Response): Promise<void> {
    const payoutId = req.params.id;
    if (!payoutId) throw new BadRequestError('payout id is required');
    const actorId =
      (typeof req.headers['x-user-id'] === 'string' && req.headers['x-user-id']) ||
      (typeof req.headers['x-service-name'] === 'string' && req.headers['x-service-name']) ||
      'system';
    const result = await retryPayoutById(payoutId, actorId);
    res.json({ success: true, result });
  }

  static async getAdminTeam(_req: Request, res: Response): Promise<void> {
    const items = await listAdminTeam();
    res.json({ success: true, items });
  }

  static async inviteAdmin(req: Request, res: Response): Promise<void> {
    const { email, role, invitedBy, expiresInHours } = req.body || {};
    if (!email || typeof email !== 'string') {
      throw new BadRequestError('email is required');
    }
    if (!role || typeof role !== 'string') {
      throw new BadRequestError('role is required');
    }
    const invite = await createAdminInvite({
      email,
      role,
      invitedBy: typeof invitedBy === 'string' && invitedBy ? invitedBy : 'system',
      expiresInHours: typeof expiresInHours === 'number' ? expiresInHours : undefined,
    });
    res.status(201).json({ success: true, invite });
  }

  static async setAdminRole(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const role = req.body?.role;
    if (!id) throw new BadRequestError('admin id is required');
    if (!role || typeof role !== 'string') throw new BadRequestError('role is required');
    const user = await updateAdminUserRole(id, role);
    res.json({ success: true, user });
  }

  static async disableAdmin(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    if (!id) throw new BadRequestError('admin id is required');
    const user = await disableAdminUser(id);
    res.json({ success: true, user });
  }

  static async getFees(_req: Request, res: Response): Promise<void> {
    const data = await getDashboardFees();
    res.json({ success: true, ...data });
  }

  static async getFeeCategories(_req: Request, res: Response): Promise<void> {
    const categories = await getDashboardFeeCategories();
    res.json({ success: true, categories });
  }

  static async upsertFeeCategory(req: Request, res: Response): Promise<void> {
    const categoryKey = req.params.key;
    if (!categoryKey) throw new BadRequestError('category key is required');
    const actorId =
      (typeof req.headers['x-user-id'] === 'string' && req.headers['x-user-id']) ||
      (typeof req.headers['x-service-name'] === 'string' && req.headers['x-service-name']) ||
      'system';
    const category = await updateDashboardFeeCategory(categoryKey, req.body || {}, actorId);
    res.json({ success: true, category });
  }
}

