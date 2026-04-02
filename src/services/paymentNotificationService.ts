import { InAppNotificationClient } from '../clients/InAppNotificationClient';
import { EmailServiceClient } from '../clients/EmailServiceClient';
import logger from '../config/logger';

interface BasePayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

async function sendInApp(payload: BasePayload): Promise<void> {
  logger.info('[paymentNotificationService] Sending in-app notification', {
    userId: payload.userId,
    title: payload.title,
    hasTaskId: !!payload.data?.taskId,
  });

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
  } else {
    logger.info('[paymentNotificationService] In-app notification delivered', {
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
  logger.info('[paymentNotificationService] notifyPaymentReceived', {
    posterUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
  });
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
  logger.info('[paymentNotificationService] notifyPayoutCompleted', {
    performerUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
  });
  await sendInApp({
    userId: performerUid,
    title: 'Payout credited',
    body: `₹${amount} has been sent to your account${taskTitle ? ` for ${taskTitle}` : ''}.`,
    data: { taskId, amount },
  });
}

export async function notifyRefundInitiated(params: {
  posterUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
  reason?: string | null;
  email?: string | null;
  userName?: string | null;
}): Promise<void> {
  const { posterUid, amount, taskTitle, taskId, reason, email, userName } = params;
  logger.info('[paymentNotificationService] notifyRefundInitiated', {
    posterUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
    hasReason: !!reason,
    hasEmail: !!email,
  });

  await sendInApp({
    userId: posterUid,
    title: 'Refund initiated',
    body: `Your refund of ₹${amount}${taskTitle ? ` for ${taskTitle}` : ''} has been initiated. You will receive it in 5-7 days.`,
    data: { taskId, amount, reason },
  });

  if (email && userName) {
    const sent = await EmailServiceClient.sendRefundInitiated(email, userName, {
      amount: Number(amount),
      taskTitle: taskTitle || undefined,
      refundReason: reason || undefined,
      processingTime: '5-7 days',
    });
    if (!sent) {
      logger.warn('[paymentNotificationService] Refund initiated email not sent', { email });
    }
  }
}

export async function notifyPayoutInitiated(params: {
  performerUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
  email?: string | null;
  userName?: string | null;
}): Promise<void> {
  const { performerUid, amount, taskTitle, taskId, email, userName } = params;
  logger.info('[paymentNotificationService] notifyPayoutInitiated', {
    performerUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
    hasEmail: !!email,
  });

  await sendInApp({
    userId: performerUid,
    title: 'Payout initiated',
    body: `Your payout of ₹${amount}${taskTitle ? ` for ${taskTitle}` : ''} has been initiated. It will be sent in a few minutes.`,
    data: { taskId, amount },
  });

  if (email && userName) {
    const sent = await EmailServiceClient.sendPayoutInitiated(email, userName, {
      amount: Number(amount),
      taskTitle: taskTitle || undefined,
      processingTime: 'a few minutes',
    });
    if (!sent) {
      logger.warn('[paymentNotificationService] Payout initiated email not sent', { email });
    }
  }
}

export async function notifyRefundProcessed(params: {
  posterUid: string;
  amount: string | number;
  taskTitle?: string | null;
  taskId?: string | null;
  reason?: string | null;
}): Promise<void> {
  const { posterUid, amount, taskTitle, taskId, reason } = params;
  logger.info('[paymentNotificationService] notifyRefundProcessed', {
    posterUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
    hasReason: !!reason,
  });
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
  logger.info('[paymentNotificationService] notifyPenaltyCreated', {
    performerUid,
    amount,
    taskId,
    hasTaskTitle: !!taskTitle,
  });
  await sendInApp({
    userId: performerUid,
    title: 'Penalty applied',
    body: `A penalty of ₹${amount} has been applied${taskTitle ? ` for ${taskTitle}` : ''}. It will be adjusted in your next payout.`,
    data: { taskId, amount },
  });
}
