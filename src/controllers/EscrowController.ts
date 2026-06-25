import { Response, Request } from 'express';
import {
  createEscrow,
  createBookingEscrow,
  attachPerformerToEscrow,
  resetPerformerOnEscrow,
  reassignRecurringVisitEscrow,
  getEscrowStatus,
  getEscrowByTaskId,
  getEscrowByTaskIdAndVisitId,
  releaseEscrow,
} from '../services/escrowService';
import { BadRequestError, NotFoundError } from '../errors/AppError';

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

    const result = await createEscrow({
      taskId,
      applicationId,
      posterUid,
      performerUid,
      amount,
      taskAmount,
      currency,
      autoReleaseAfterDays,
      taskCategory,
      metadata: baseMeta,
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
    });

    if (!result.success) {
      throw new Error(result.error || 'Failed to create booking escrow');
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


