/**
 * Audit Log Service
 * Writes pay-in and webhook events to AuditLog for compliance and debugging.
 */

import { prisma } from '../config/prisma';
import logger from '../config/logger';
import { isPostgresConnected } from '../config/database';

type AuditAction = 'created' | 'updated' | 'deleted' | 'status_changed' | 'webhook_received';

async function createAuditEntry(data: {
  entityType: string;
  entityId?: string | null;
  action: AuditAction;
  oldValue?: object | null;
  newValue?: object | null;
  actorId?: string | null;
  actorType?: string | null;
  eventId?: string | null;
  eventType?: string | null;
  source?: string | null;
  payload?: object | null;
  processed?: boolean;
  processedAt?: Date | null;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    if (!isPostgresConnected()) return;
    await prisma.auditLog.create({
      data: {
        entityType: data.entityType,
        entityId: data.entityId ?? null,
        action: data.action,
        oldValue: data.oldValue ?? undefined,
        newValue: data.newValue ?? undefined,
        actorId: data.actorId ?? null,
        actorType: data.actorType ?? null,
        eventId: data.eventId ?? undefined,
        eventType: data.eventType ?? undefined,
        source: data.source ?? undefined,
        payload: data.payload ?? undefined,
        processed: data.processed ?? false,
        processedAt: data.processedAt ?? undefined,
        errorMessage: data.errorMessage ?? undefined,
      },
    });
  } catch (err: any) {
    logger.warn('Failed to write audit log (non-critical):', err?.message);
  }
}

/**
 * Log escrow created (pay-in)
 */
export async function logEscrowCreated(params: {
  escrowId: string;
  razorpayOrderId: string;
  taskId: string;
  posterUid: string;
  amountInRupees: string;
  actorId?: string;
}): Promise<void> {
  await createAuditEntry({
    entityType: 'escrow',
    entityId: params.escrowId,
    action: 'created',
    newValue: {
      escrowId: params.escrowId,
      razorpayOrderId: params.razorpayOrderId,
      taskId: params.taskId,
      posterUid: params.posterUid,
      amountInRupees: params.amountInRupees,
    },
    actorId: params.actorId ?? params.posterUid,
    actorType: 'user',
  });
}

/**
 * Log payment captured (escrow status -> held)
 */
export async function logPaymentCaptured(params: {
  escrowId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  actorId?: string;
}): Promise<void> {
  await createAuditEntry({
    entityType: 'escrow',
    entityId: params.escrowId,
    action: 'status_changed',
    newValue: {
      status: 'held',
      razorpayOrderId: params.razorpayOrderId,
      razorpayPaymentId: params.razorpayPaymentId,
    },
    actorId: params.actorId ?? 'system',
    actorType: 'system',
  });
}

/**
 * Log payment failed (escrow status -> cancelled)
 */
export async function logPaymentFailed(params: {
  escrowId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  errorCode?: string;
  errorDescription?: string;
}): Promise<void> {
  await createAuditEntry({
    entityType: 'escrow',
    entityId: params.escrowId,
    action: 'status_changed',
    newValue: {
      status: 'cancelled',
      razorpayOrderId: params.razorpayOrderId,
      razorpayPaymentId: params.razorpayPaymentId,
      errorCode: params.errorCode,
      errorDescription: params.errorDescription,
    },
    actorId: 'razorpay',
    actorType: 'razorpay',
  });
}

/**
 * Check if webhook event was already processed (by Razorpay event ID).
 * Use before processing to deduplicate duplicate webhook deliveries.
 */
export async function getWebhookByEventId(
  eventId: string
): Promise<{ id: string; processed: boolean } | null> {
  try {
    if (!isPostgresConnected()) return null;
    const row = await prisma.auditLog.findUnique({
      where: { eventId },
      select: { id: true, processed: true },
    });
    return row ? { id: row.id, processed: row.processed } : null;
  } catch (err: any) {
    logger.warn('Failed to lookup webhook by eventId (non-critical):', err?.message);
    return null;
  }
}

/**
 * Persist webhook receipt (before processing). Returns audit log id for later update.
 */
export async function logWebhookReceived(params: {
  eventId: string | null;
  eventType: string;
  source: string;
  payload: object;
}): Promise<string | null> {
  try {
    if (!isPostgresConnected()) return null;
    const created = await prisma.auditLog.create({
      data: {
        entityType: 'webhook',
        entityId: null,
        action: 'webhook_received',
        eventId: params.eventId ?? undefined,
        eventType: params.eventType,
        source: params.source,
        payload: params.payload as any,
        processed: false,
      },
    });
    return created.id;
  } catch (err: any) {
    logger.warn('Failed to write webhook audit log (non-critical):', err?.message);
    return null;
  }
}

/**
 * Mark webhook as processed (or failed)
 */
export async function markWebhookProcessed(
  auditLogId: string,
  success: boolean,
  errorMessage?: string | null
): Promise<void> {
  try {
    if (!isPostgresConnected()) return;
    await prisma.auditLog.update({
      where: { id: auditLogId },
      data: {
        processed: success,
        processedAt: new Date(),
        errorMessage: errorMessage ?? undefined,
      },
    });
  } catch (err: any) {
    logger.warn('Failed to update webhook audit log (non-critical):', err?.message);
  }
}
