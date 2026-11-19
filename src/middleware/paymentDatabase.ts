import { Request, RequestHandler } from 'express';
import { resolvePaymentEnvironment } from '../config/paymentEnvironment';
import {
  getPrismaClientForEnvironment,
  runWithPaymentDatabase,
  runWithPaymentEnvironment,
} from '../config/prisma';
import { BadRequestError, ConflictError } from '../errors/AppError';
import { type PaymentDatabaseEnvironment } from '../config/env';

type PaymentEnvironment = 'live' | 'test';

function paymentEnvironmentFrom(value: unknown): PaymentEnvironment | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const environment = (value as Record<string, unknown>).paymentEnvironment;
  return environment === 'live' || environment === 'test' ? environment : undefined;
}

function isOptionalOrderTableMissing(error: unknown): boolean {
  const databaseError = error as { code?: string; message?: string };
  const message = databaseError.message || '';
  return (
    databaseError.code === 'P2021' ||
    databaseError.code === 'P2022' ||
    /PaymentOrder(Environment|Idempotency).*(does not exist|relation|table)/i.test(message)
  );
}

export function withPaymentDatabaseForUser(
  handler: RequestHandler,
  resolveUserId: (req: Request) => string | undefined,
): RequestHandler {
  return (req, res, next) => {
    const userId = resolveUserId(req)?.trim();
    if (!userId) {
      next(new BadRequestError('User ID is required to select the payment database'));
      return;
    }

    void resolvePaymentEnvironment(userId)
      .then((paymentEnvironment) =>
        runWithPaymentEnvironment(paymentEnvironment, userId, () => handler(req, res, next)),
      )
      .catch(next);
  };
}

export function withPaymentDatabaseForExistingPayment(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const identifiers = {
        escrowId: req.params.escrowId || body.escrowId,
        taskId: req.params.taskId || body.taskId,
        bookingOrderId: req.params.bookingOrderId || body.bookingOrderId,
        razorpayOrderId: req.params.orderId || body.razorpayOrderId || body.orderId,
        razorpayPaymentId: body.razorpayPaymentId || body.paymentId,
        payoutId: req.params.payoutId || body.payoutId,
        refundId: req.params.refundId || body.refundId,
      };
      const taskIds = Array.isArray(body.taskIds)
        ? body.taskIds.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const payoutIds = Array.isArray(body.payoutIds)
        ? body.payoutIds.filter((value: unknown): value is string => typeof value === 'string')
        : [];
      const where: Record<string, unknown>[] = [];
      if (identifiers.escrowId) {
        where.push({ id: identifiers.escrowId }, { escrowId: identifiers.escrowId });
      }
      if (identifiers.taskId) where.push({ taskId: identifiers.taskId });
      if (identifiers.bookingOrderId) {
        where.push({ bookingOrderId: identifiers.bookingOrderId });
      }
      if (identifiers.razorpayOrderId) {
        where.push({ razorpayOrderId: identifiers.razorpayOrderId });
      }
      if (identifiers.razorpayPaymentId) {
        where.push({ razorpayPaymentId: identifiers.razorpayPaymentId });
      }

      const matches: Array<{
        databaseEnvironment: PaymentDatabaseEnvironment;
        paymentEnvironment: PaymentEnvironment;
      }> = [];
      if (
        where.length > 0 ||
        identifiers.payoutId ||
        payoutIds.length > 0 ||
        taskIds.length > 0 ||
        identifiers.refundId
      ) {
        for (const environment of ['development', 'production'] as const) {
          const client = await getPrismaClientForEnvironment(environment);
          let found = false;
          let paymentEnvironment: PaymentEnvironment | undefined;
          if (where.length > 0) {
            const escrow = await client.escrow.findFirst({
              where: { OR: where },
              select: { id: true, metadata: true },
            });
            if (escrow) {
              found = true;
              paymentEnvironment = paymentEnvironmentFrom(escrow.metadata);
            }
          }
          if (!found && identifiers.razorpayOrderId) {
            try {
              const paymentOrder = await client.paymentOrderEnvironment.findUnique({
                where: { razorpayOrderId: identifiers.razorpayOrderId },
                select: { id: true, paymentEnvironment: true },
              });
              if (paymentOrder) {
                found = true;
                paymentEnvironment = paymentEnvironmentFrom(paymentOrder);
              }
            } catch (error) {
              if (!isOptionalOrderTableMissing(error)) throw error;
            }
          }
          if (!found && identifiers.razorpayOrderId) {
            try {
              const idempotentOrder = await client.paymentOrderIdempotency.findFirst({
                where: { razorpayOrderId: identifiers.razorpayOrderId },
                select: { id: true, paymentEnvironment: true, orderPayload: true },
              });
              if (idempotentOrder) {
                found = true;
                paymentEnvironment =
                  paymentEnvironmentFrom(idempotentOrder) ||
                  paymentEnvironmentFrom(idempotentOrder.orderPayload);
              }
            } catch (error) {
              if (!isOptionalOrderTableMissing(error)) throw error;
            }
          }
          if (
            !found &&
            (identifiers.payoutId || payoutIds.length > 0 || taskIds.length > 0)
          ) {
            const payout = await client.payout.findFirst({
              where: {
                OR: [
                  ...(identifiers.payoutId ? [{ payoutId: identifiers.payoutId }] : []),
                  ...(payoutIds.length > 0 ? [{ payoutId: { in: payoutIds } }] : []),
                  ...(taskIds.length > 0 ? [{ taskId: { in: taskIds } }] : []),
                ],
              },
              select: { id: true, escrowId: true, metadata: true },
            });
            if (payout) {
              found = true;
              paymentEnvironment = paymentEnvironmentFrom(payout.metadata);
              if (!paymentEnvironment && payout.escrowId) {
                const escrow = await client.escrow.findUnique({
                  where: { id: payout.escrowId },
                  select: { metadata: true },
                });
                paymentEnvironment = paymentEnvironmentFrom(escrow?.metadata);
              }
            }
          }
          if (!found && identifiers.refundId) {
            const refund = await client.refund.findFirst({
              where: { refundId: identifiers.refundId },
              select: { id: true, escrow: { select: { metadata: true } } },
            });
            if (refund) {
              found = true;
              paymentEnvironment = paymentEnvironmentFrom(refund.escrow?.metadata);
            }
          }
          if (found) {
            matches.push({
              databaseEnvironment: environment,
              paymentEnvironment:
                paymentEnvironment || (environment === 'development' ? 'test' : 'live'),
            });
          }
        }
      }

      if (matches.length > 1) {
        throw new ConflictError('Payment records matching this request exist in both databases');
      }

      const userId = requestUserId(req);
      if (matches.length === 1) {
        const match = matches[0];
        await runWithPaymentDatabase(
          match.databaseEnvironment,
          match.paymentEnvironment,
          userId,
          () => handler(req, res, next),
        );
        return;
      }

      if (userId) {
        const paymentEnvironment = await resolvePaymentEnvironment(userId);
        await runWithPaymentEnvironment(paymentEnvironment, userId, () =>
          handler(req, res, next),
        );
        return;
      }

      await runWithPaymentEnvironment('live', undefined, () => handler(req, res, next));
    })().catch(next);
  };
}

export function requestUserId(req: Request): string | undefined {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const metadata =
    body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  const headerUserId = req.headers['x-user-id'];
  const headerValue = Array.isArray(headerUserId) ? headerUserId[0] : headerUserId;
  const value =
    headerValue ||
    body.posterUid ||
    body.userId ||
    metadata.posterUid ||
    body.performerUid;

  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
