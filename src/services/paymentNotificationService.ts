import { InAppNotificationClient } from '../clients/InAppNotificationClient';
import logger from '../config/logger';

interface BasePayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

async function sendInApp(payload: BasePayload): Promise<void> {
  const ok = await InAppNotificationClient.send({
    userId: payload.userId,
    title: payload.title,
    body: payload.body,
    category: 'payments',
    type: 'success',
    data: payload.data,
  });

  if (!ok) {
    logger.warn('[paymentNotificationService] In-app notification skipped/failed', {
      userId: payload.userId,
      title: payload.title,
    });
  }
}

export async function notifyPaymentReceived(params: {
  posterUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
}): Promise<void> {
  const { posterUid, amount, taskTitle, taskId } = params;
  await sendInApp({
    userId: posterUid,
    title: 'Payment received',
    body: `We received ₹${amount} for${taskTitle ? ` ${taskTitle}` : ' your task'}.`,
    data: { taskId, amount },
  });
}

export async function notifyPayoutCompleted(params: {
  performerUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
}): Promise<void> {
  const { performerUid, amount, taskTitle, taskId } = params;
  await sendInApp({
    userId: performerUid,
    title: 'Payout credited',
    body: `₹${amount} has been sent to your account${taskTitle ? ` for ${taskTitle}` : ''}.`,
    data: { taskId, amount },
  });
}

export async function notifyRefundProcessed(params: {
  posterUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
  reason?: string | null;
}): Promise<void> {
  const { posterUid, amount, taskTitle, taskId, reason } = params;
  await sendInApp({
    userId: posterUid,
    title: 'Refund processed',
    body: `We processed your refund of ₹${amount}${taskTitle ? ` for ${taskTitle}` : ''}.`,
    data: { taskId, amount, reason },
  });
}

export async function notifyPenaltyCreated(params: {
  performerUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
}): Promise<void> {
  const { performerUid, amount, taskTitle, taskId } = params;
  await sendInApp({
    userId: performerUid,
    title: 'Penalty applied',
    body: `A penalty of ₹${amount} has been applied${taskTitle ? ` for ${taskTitle}` : ''}. It will be adjusted in your next payout.`,
    data: { taskId, amount },
  });
}
