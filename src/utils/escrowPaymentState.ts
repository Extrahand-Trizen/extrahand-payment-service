/**
 * Escrow payment state rules shared by capture webhooks, recurring visit payments and payouts.
 * Escrow `status`: pending | held | released | refunded | cancelled.
 * Escrow `paymentStatus`: pending | authorized | captured | failed (refunds keep `captured`).
 */

type EscrowStateLike = {
  status?: unknown;
  paymentStatus?: unknown;
  razorpayPaymentId?: unknown;
} | null | undefined;

const REVERSED_ESCROW_STATUSES = new Set(['refunded', 'cancelled', 'failed']);
const REVERSED_PAYMENT_STATUSES = new Set(['refunded', 'failed']);

function lower(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** Money was taken for this escrow and has not been refunded, cancelled or failed. */
export function isEscrowPaidRecord(escrow: EscrowStateLike): boolean {
  if (!escrow) return false;
  const status = lower(escrow.status);
  const paymentStatus = lower(escrow.paymentStatus);
  if (REVERSED_ESCROW_STATUSES.has(status) || REVERSED_PAYMENT_STATUSES.has(paymentStatus)) {
    return false;
  }
  if (status === 'held' || status === 'released') return true;
  return paymentStatus === 'captured' || paymentStatus === 'authorized';
}

/** Paid and still held by the platform: can be moved between visits, refunded or paid out. */
export function isEscrowActiveHeldRecord(escrow: EscrowStateLike): boolean {
  return isEscrowPaidRecord(escrow) && lower(escrow?.status) !== 'released';
}

export type EscrowPaymentEvent = 'authorized' | 'captured' | 'failed';

/**
 * Whether a payment event may change the escrow. Captured/held/released/refunded escrows never
 * move back to authorized or failed, and refunded/released escrows are never re-held. A failed
 * attempt on an order that is still awaiting payment applies, and a later capture on the same
 * order (customer retried) still applies.
 */
export function resolveEscrowPaymentTransition(
  current: EscrowStateLike,
  event: EscrowPaymentEvent,
  razorpayPaymentId: string,
): { apply: true } | { apply: false; reason: string } {
  const status = lower(current?.status);
  const paymentStatus = lower(current?.paymentStatus);
  const settled =
    paymentStatus === 'captured' || ['held', 'released', 'refunded'].includes(status);

  if (event === 'captured') {
    if (status === 'released' || status === 'refunded') {
      return { apply: false, reason: `escrow already ${status}` };
    }
    if (paymentStatus === 'captured' && status === 'held') {
      const currentPaymentId = String(current?.razorpayPaymentId ?? '').trim();
      return currentPaymentId && currentPaymentId !== razorpayPaymentId
        ? { apply: false, reason: 'escrow already captured by another payment' }
        : { apply: false, reason: 'escrow already captured' };
    }
    return { apply: true };
  }

  if (settled) {
    return { apply: false, reason: `stale ${event} event after capture (status ${status || 'unknown'})` };
  }

  if (event === 'failed' && paymentStatus === 'failed') {
    const currentPaymentId = String(current?.razorpayPaymentId ?? '').trim();
    if (!currentPaymentId || currentPaymentId === razorpayPaymentId) {
      return { apply: false, reason: 'payment failure already recorded' };
    }
  }

  return { apply: true };
}
