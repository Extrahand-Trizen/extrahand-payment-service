import type { PrismaClient } from '@prisma/client';
import { prisma } from '../config/prisma';

export async function getPaymentTimelineEvents(
  paymentId: string,
  refundId?: string | null,
  database: PrismaClient = prisma,
): Promise<Array<{ eventType: string; occurredAt: Date }>> {
  const paymentEventTypes = [
    'payment.authorized',
    'payment.captured',
    'payment.refunded',
  ];
  const refundEventTypes = [
    'refund.created',
    'refund.processed',
    'refund.failed',
  ];
  const filters = [
    {
      eventType: { in: paymentEventTypes },
      payload: {
        path: ['payload', 'payment', 'entity', 'id'],
        equals: paymentId,
      },
    },
    {
      eventType: { in: refundEventTypes },
      payload: {
        path: ['payload', 'refund', 'entity', 'payment_id'],
        equals: paymentId,
      },
    },
    ...(refundId
      ? [
          {
            eventType: { in: refundEventTypes },
            payload: {
              path: ['payload', 'refund', 'entity', 'id'],
              equals: refundId,
            },
          },
        ]
      : []),
  ];

  const auditEvents = await database.auditLog.findMany({
    where: {
      entityType: 'webhook',
      processed: true,
      OR: filters,
    },
    select: { eventType: true, payload: true, createdAt: true },
  });

  return auditEvents.flatMap((auditEvent) => {
    if (!auditEvent.eventType) return [];
    const event = auditEvent.payload as { created_at?: number | string } | null;
    const timestamp = Number(event?.created_at);
    return [{
      eventType: auditEvent.eventType,
      occurredAt:
        Number.isFinite(timestamp) && timestamp > 0
          ? new Date(timestamp * 1000)
          : auditEvent.createdAt,
    }];
  }).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
}

export async function getRefundWebhookEvents(
  refundId?: string | null,
  database: PrismaClient = prisma,
): Promise<Array<{ eventType: string; occurredAt: Date }>> {
  if (!refundId) return [];

  const refundEventTypes = [
    'refund.created',
    'refund.processed',
    'refund.failed',
  ];

  const auditEvents = await database.auditLog.findMany({
    where: {
      entityType: 'webhook',
      eventType: { in: refundEventTypes },
      payload: {
        path: ['payload', 'refund', 'entity', 'id'],
        equals: refundId,
      },
    },
    select: { eventType: true, payload: true, createdAt: true },
  });

  return auditEvents.flatMap((auditEvent) => {
    if (!auditEvent.eventType) return [];
    const event = auditEvent.payload as { created_at?: number | string } | null;
    const timestamp = Number(event?.created_at);
    return [{
      eventType: auditEvent.eventType,
      occurredAt:
        Number.isFinite(timestamp) && timestamp > 0
          ? new Date(timestamp * 1000)
          : auditEvent.createdAt,
    }];
  }).sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
}
