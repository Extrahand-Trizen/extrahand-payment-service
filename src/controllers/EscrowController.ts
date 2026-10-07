import { Response, Request } from 'express';
import {
  createEscrow,
  createBookingEscrow,
  attachPerformerToEscrow,
  resetPerformerOnEscrow,
  reassignRecurringVisitEscrow,
  linkRealTaskIdToBookingEscrow,
  getEscrowStatus,
  getEscrowByTaskId,
  getEscrowByTaskIdAndVisitId,
  getEscrowByBookingOrderId,
  releaseEscrow,
  updateEscrowAutoRelease,
  convertPostgresEscrowToFrontendFormat,
} from '../services/escrowService';
import {
  settlePendingRecurringVisitOrders,
  withRecurringVisitOrderLock,
} from '../services/recurringVisitOrderService';
import { getTaskDeletionSafety } from '../services/deletionSafetyService';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../errors/AppError';
import { TaskServiceClient } from '../clients/TaskServiceClient';
import { calculatePosterFees } from '../services/feeCalculationService';
import { pickCategoryFeeConfigKey } from '../services/feeConfigService';
import {
  isPaidEscrowRecord,
  readEscrowVisitAmountRupees,
  readRecurringVisitOrderScope,
  validateRecurringVisitOrderAmounts,
  visitAmountsMatch,
} from '../utils/recurringVisitOrderValidation';

export class EscrowController {
  /**
   * POST /api/v1/escrow/create
   * Create escrow when offer is accepted
   */
  static async createEscrow(req: Request, res: Response): Promise<void> {
    const {
      taskId,
      applicationId,
      posterUid,
      performerUid,
      amount,
      taskAmount,
      currency,
      autoReleaseAfterDays,
      metadata,
      taskCategory,
      taskTitle: taskTitleBody,
    } = req.body;

    // Validation
    if (!taskId || !posterUid || !performerUid || !amount) {
      throw new BadRequestError('Missing required fields: taskId, posterUid, performerUid, amount');
    }

    if (amount <= 0) {
      throw new BadRequestError('Amount must be greater than 0');
    }

    const baseMeta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...(metadata as Record<string, unknown>) }
        : {};
    const titleFromBody =
      typeof taskTitleBody === 'string' && taskTitleBody.trim().length > 0
        ? taskTitleBody.trim()
        : undefined;
    if (titleFromBody && !baseMeta.taskTitle && !baseMeta.taskTitleSnapshot) {
      baseMeta.taskTitle = titleFromBody;
    }

    const authenticatedUid = String(req.headers['x-user-id'] || '').trim() || posterUid;
    let escrowPosterUid = posterUid;
    let quotedVisitAmount: number | undefined;

    const visitScope = readRecurringVisitOrderScope(String(taskId), baseMeta);
    if (visitScope && 'error' in visitScope) {
      throw new BadRequestError(visitScope.error);
    }
    if (visitScope) {
      const quoteResult = await TaskServiceClient.quoteRecurringVisitPayment({
        parentTaskId: visitScope.parentTaskId,
        visitId: visitScope.visitId,
        posterUid: authenticatedUid,
        applicationId:
          String(applicationId || baseMeta.applicationId || '').trim() || undefined,
      });
      if (!quoteResult.ok) {
        if (quoteResult.status === 403) throw new ForbiddenError(quoteResult.error);
        if (quoteResult.status === 404) throw new NotFoundError(quoteResult.error);
        if (quoteResult.status === 409) throw new ConflictError(quoteResult.error);
        if (quoteResult.status < 500) throw new BadRequestError(quoteResult.error);
        throw new Error(quoteResult.error);
      }
      const { quote } = quoteResult;

      const feeCategoryKey = pickCategoryFeeConfigKey(quote.categorySlug || quote.category);
      const fees = await calculatePosterFees(quote.amount, feeCategoryKey);
      const amountCheck = validateRecurringVisitOrderAmounts({
        quotedVisitAmount: quote.amount,
        quotedPlatformFeeTotal: Number(fees.platformFeeTotal),
        requestedTaskAmount: taskAmount,
        requestedGrossAmount: amount,
      });
      if (!amountCheck.ok) {
        throw new BadRequestError(amountCheck.message);
      }

      baseMeta.visitId = visitScope.visitId;
      baseMeta.parentTaskId = visitScope.parentTaskId;
      baseMeta.recurringPlan = true;
      baseMeta.visitBudgetRupees = quote.amount;
      escrowPosterUid = authenticatedUid;
      quotedVisitAmount = quote.amount;

      const visitAmount = quote.amount;
      const outcome = await withRecurringVisitOrderLock(
        visitScope.parentTaskId,
        visitScope.visitId,
        async () => {
          const existingForVisit = await getEscrowByTaskIdAndVisitId(
            visitScope.parentTaskId,
            visitScope.visitId,
          );
          if (existingForVisit && isPaidEscrowRecord(existingForVisit)) {
            const paidVisitAmount = readEscrowVisitAmountRupees(existingForVisit);
            if (paidVisitAmount != null && visitAmountsMatch(paidVisitAmount, visitAmount)) {
              return { kind: 'alreadyPaid' as const, escrow: existingForVisit };
            }
            throw new ConflictError('A payment for this visit is already on hold');
          }

          const { reuse } = await settlePendingRecurringVisitOrders({
            parentTaskId: visitScope.parentTaskId,
            visitId: visitScope.visitId,
            posterUid: escrowPosterUid,
            performerUid,
            applicationId: applicationId || null,
            grossAmountRupees: Number(amount),
            quotedVisitAmountRupees: visitAmount,
            metadata: baseMeta,
            authenticatedUid,
          });
          if (reuse) {
            return {
              kind: 'reused' as const,
              escrow: await convertPostgresEscrowToFrontendFormat(reuse),
              order: reuse.razorpayOrderData,
            };
          }

          const created = await createEscrow({
            taskId,
            applicationId,
            posterUid: escrowPosterUid,
            performerUid,
            amount,
            taskAmount: visitAmount,
            currency,
            autoReleaseAfterDays,
            taskCategory,
            metadata: baseMeta,
            authenticatedUid,
          });
          return { kind: 'created' as const, result: created };
        },
      );

      if (outcome.kind === 'alreadyPaid') {
        res.status(200).json({ success: true, alreadyPaid: true, escrow: outcome.escrow });
        return;
      }
      if (outcome.kind === 'reused') {
        res.status(200).json({ success: true, reused: true, escrow: outcome.escrow, order: outcome.order });
        return;
      }
      if (!outcome.result.success) {
        throw new Error(outcome.result.error || 'Failed to create escrow');
      }
      res.status(201).json({
        success: true,
        escrow: outcome.result.escrow,
        order: outcome.result.order,
      });
      return;
    }

    const result = await createEscrow({
      taskId,
      applicationId,
      posterUid: escrowPosterUid,
      performerUid,
      amount,
      taskAmount: quotedVisitAmount ?? taskAmount,
      currency,
      autoReleaseAfterDays,
      taskCategory,
      metadata: baseMeta,
      authenticatedUid,
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to create escrow');
    }

    res.status(201).json({
      success: true,
      escrow: result.escrow,
      order: result.order, // Razorpay order for frontend
    });
  }

  /**
   * POST /api/v1/escrow/create-booking
   * Book Now: create escrow before helper is assigned
   */
  static async createBookingEscrow(req: Request, res: Response): Promise<void> {
    const {
      taskId,
      bookingOrderId,
      posterUid,
      amount,
      taskAmount,
      currency,
      metadata,
      taskCategory,
      taskTitle: taskTitleBody,
    } = req.body;

    if (!taskId || !bookingOrderId || !posterUid || !amount) {
      throw new BadRequestError(
        'Missing required fields: taskId, bookingOrderId, posterUid, amount'
      );
    }

    if (amount <= 0) {
      throw new BadRequestError('Amount must be greater than 0');
    }

    const baseMeta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? { ...(metadata as Record<string, unknown>) }
        : {};
    const titleFromBody =
      typeof taskTitleBody === 'string' && taskTitleBody.trim().length > 0
        ? taskTitleBody.trim()
        : undefined;
    if (titleFromBody && !baseMeta.taskTitle && !baseMeta.taskTitleSnapshot) {
      baseMeta.taskTitle = titleFromBody;
    }

    const result = await createBookingEscrow({
      taskId,
      bookingOrderId,
      posterUid,
      amount,
      taskAmount,
      currency,
      taskCategory,
      metadata: baseMeta,
      authenticatedUid: String(req.headers['x-user-id'] || '').trim() || posterUid,
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to create booking escrow');
    }

    res.status(201).json({
      success: true,
      escrow: result.escrow,
      order: result.order,
    });
  }

  /**
   * PATCH /api/v1/escrow/:escrowId/attach-performer
   */
  static async attachPerformer(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;
    const { performerUid, applicationId } = req.body;

    if (!performerUid) {
      throw new BadRequestError('performerUid is required');
    }

    const result = await attachPerformerToEscrow({
      escrowId,
      performerUid,
      applicationId,
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to attach performer');
    }

    res.json({
      success: true,
      escrow: result.escrow,
    });
  }

  /**
   * PATCH /api/v1/escrow/:escrowId/reset-performer
   */
  static async resetPerformer(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;
    const result = await resetPerformerOnEscrow(escrowId);
    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to reset performer');
    }
    res.json({ success: true });
  }

  /**
   * PATCH /api/v1/escrow/:escrowId/reassign-recurring-visit
   */
  static async reassignRecurringVisit(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;
    const { taskId, fromVisitId, toVisitId } = req.body;

    if (!taskId || !fromVisitId || !toVisitId) {
      throw new BadRequestError('taskId, fromVisitId, and toVisitId are required');
    }

    const result = await reassignRecurringVisitEscrow({
      escrowId,
      taskId,
      fromVisitId,
      toVisitId,
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to reassign recurring visit escrow');
    }

    res.json({
      success: true,
      escrow: result.escrow,
    });
  }

  /**
   * PATCH /api/v1/escrow/:escrowId/link-task
   * Link real Mongo task ID to Book Now escrow after materialization
   */
  static async linkTask(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;
    const { taskId, bookingOrderId, lineItemTaskIds } = req.body;

    if (!taskId) {
      throw new BadRequestError('taskId is required');
    }

    const result = await linkRealTaskIdToBookingEscrow({
      escrowId,
      taskId,
      bookingOrderId,
      lineItemTaskIds,
    });

    if (!result.success) {
      throw new BadRequestError(result.error || 'Failed to link task to escrow');
    }

    res.json({
      success: true,
      escrow: result.escrow,
    });
  }

  /**
   * GET /api/v1/escrow/status/:escrowId
   * Get escrow status by escrow ID
   */
  static async getEscrowStatus(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;

    const result = await getEscrowStatus(escrowId);

    if (!result.success) {
      throw new NotFoundError(result.error || 'Escrow not found');
    }

    res.json({
      success: true,
      escrow: result.escrow,
    });
  }

  /**
   * GET /api/v1/escrow/booking-order/:bookingOrderId
   * Get escrow by Book Now booking order id
   */
  static async getEscrowByBookingOrderId(req: Request, res: Response): Promise<void> {
    const { bookingOrderId } = req.params;

    const escrow = await getEscrowByBookingOrderId(bookingOrderId);

    if (!escrow) {
      throw new NotFoundError('Escrow not found for this booking order');
    }

    res.json({
      success: true,
      escrow,
    });
  }

  /**
   * GET /api/v1/escrow/task/:taskId/deletion-safety
   * Financial safety snapshot for task hard/soft delete decisions.
   */
  static async getTaskDeletionSafety(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params;
    if (!taskId?.trim()) {
      throw new BadRequestError('taskId is required');
    }
    const bookingOrderId =
      typeof req.query.bookingOrderId === 'string' ? req.query.bookingOrderId.trim() : undefined;

    const safety = await getTaskDeletionSafety(taskId.trim(), { bookingOrderId });
    res.json({
      success: true,
      ...safety,
    });
  }

  /**
   * GET /api/v1/escrow/task/:taskId
   * Get escrow by task ID
   */
  static async getEscrowByTaskId(req: Request, res: Response): Promise<void> {
    const { taskId } = req.params;
    const visitId =
      typeof req.query.visitId === 'string' && req.query.visitId.trim()
        ? req.query.visitId.trim()
        : undefined;

    const escrow = visitId
      ? await getEscrowByTaskIdAndVisitId(taskId, visitId)
      : await getEscrowByTaskId(taskId);

    if (!escrow) {
      if (visitId) {
        res.json({ success: true, escrow: null });
        return;
      }
      throw new NotFoundError('Escrow not found for this task');
    }

    res.json({
      success: true,
      escrow,
    });
  }

  /**
   * POST /api/v1/escrow/release/:escrowId
   * Release escrow funds to performer
   */
  static async releaseEscrow(req: Request, res: Response): Promise<void> {
    const { escrowId } = req.params;
    const { releasedBy, metadata } = req.body;

    // Validation
    if (!releasedBy) {
      throw new BadRequestError('releasedBy (user UID) is required');
    }

    const result = await releaseEscrow(escrowId, releasedBy, metadata);

    if (!result.success) {
      // Determine appropriate error type
      if (result.error?.includes('not found')) {
        throw new NotFoundError(result.error);
      }
      if (result.error?.includes('cannot be released')) {
        throw new BadRequestError(result.error);
      }
      throw new Error(result.error || 'Failed to release escrow');
    }

    res.json({
      success: true,
      escrow: result.escrow,
      transaction: result.transaction,
      message: 'Escrow funds released successfully',
    });
  }

  /**
   * PUT /api/v1/escrow/auto-release
   * Update escrow auto-release date (for revisions)
   */
  static async updateAutoRelease(req: Request, res: Response): Promise<void> {
    const { razorpayOrderId, autoReleaseDate } = req.body;

    // Validation
    if (!razorpayOrderId) {
      throw new BadRequestError('razorpayOrderId is required');
    }

    // Parse autoReleaseDate if provided
    let releaseDate: Date | null = null;
    if (autoReleaseDate) {
      releaseDate = new Date(autoReleaseDate);
      if (isNaN(releaseDate.getTime())) {
        throw new BadRequestError('Invalid autoReleaseDate format');
      }
    }

    const result = await updateEscrowAutoRelease(razorpayOrderId, releaseDate);

    if (!result.success) {
      throw new Error(result.error || 'Failed to update escrow auto-release');
    }

    res.json({
      success: true,
      message: releaseDate ? 'Auto-release date set successfully' : 'Auto-release cancelled successfully',
    });
  }
}


