import { isEscrowPaidRecord } from './escrowPaymentState';

/** Rupee tolerance for rounding drift between client-displayed and server-computed amounts. */
export const RECURRING_VISIT_AMOUNT_TOLERANCE_RUPEES = 1;

export type RecurringVisitOrderScope = {
  visitId: string;
  parentTaskId: string;
};

/** Visit scope of an escrow order request, or null when it is not a recurring visit payment. */
export function readRecurringVisitOrderScope(
  taskId: string,
  metadata: Record<string, unknown> | null | undefined,
): RecurringVisitOrderScope | { error: string } | null {
  const visitId = typeof metadata?.visitId === 'string' ? metadata.visitId.trim() : '';
  if (!visitId) return null;
  const parentTaskId =
    typeof metadata?.parentTaskId === 'string' ? metadata.parentTaskId.trim() : '';
  if (parentTaskId && parentTaskId !== String(taskId || '').trim()) {
    return { error: 'Visit payment must be created on the recurring plan' };
  }
  return { visitId, parentTaskId: String(taskId || '').trim() };
}

function amountsMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= RECURRING_VISIT_AMOUNT_TOLERANCE_RUPEES;
}

export function isPaidEscrowRecord(
  escrow: { status?: unknown; paymentStatus?: unknown } | null | undefined,
): boolean {
  return isEscrowPaidRecord(escrow);
}

/** Base visit amount (excluding fees) an existing escrow was created for. */
export function readEscrowVisitAmountRupees(escrow: {
  taskAmount?: unknown;
  metadata?: unknown;
} | null | undefined): number | null {
  if (!escrow) return null;
  const metadata =
    escrow.metadata && typeof escrow.metadata === 'object'
      ? (escrow.metadata as Record<string, unknown>)
      : {};
  for (const raw of [metadata.visitBudgetRupees, escrow.taskAmount]) {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function visitAmountsMatch(a: number, b: number): boolean {
  return amountsMatch(a, b);
}

/**
 * The client-sent visit amount and gross must equal the server quote (visit amount from
 * task-service) plus server-computed poster fees.
 */
export function validateRecurringVisitOrderAmounts(params: {
  quotedVisitAmount: number;
  quotedPlatformFeeTotal: number;
  requestedTaskAmount: unknown;
  requestedGrossAmount: unknown;
}): { ok: true } | { ok: false; message: string } {
  const quoted = Number(params.quotedVisitAmount);
  if (!Number.isFinite(quoted) || quoted <= 0) {
    return { ok: false, message: 'Visit amount is not available' };
  }
  const taskAmount = Number(params.requestedTaskAmount);
  if (!Number.isFinite(taskAmount) || !amountsMatch(taskAmount, quoted)) {
    return {
      ok: false,
      message: `Visit amount has changed to ₹${quoted}. Please refresh and try again.`,
    };
  }
  const expectedGross = quoted + Number(params.quotedPlatformFeeTotal || 0);
  const gross = Number(params.requestedGrossAmount);
  if (!Number.isFinite(gross) || !amountsMatch(gross, expectedGross)) {
    return {
      ok: false,
      message: 'Payment total does not match the visit amount. Please refresh and try again.',
    };
  }
  return { ok: true };
}
