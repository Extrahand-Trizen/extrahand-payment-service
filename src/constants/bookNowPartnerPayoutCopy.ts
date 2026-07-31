/**
 * Book Now partner payout delayed-visibility copy (canonical).
 *
 * Mirrored into:
 * - extrahand-task-service/src/constants/bookNowPartnerPayoutCopy.ts
 * - extrahand-helper-mobile-app/src/features/payments/constants/bookNowPartnerPayoutCopy.ts
 * - extrahand-payment-service-clean/src/constants/bookNowPartnerPayoutCopy.ts
 *
 * Edit here first, then copy into the three package paths above.
 *
 * Display default should match payment-service env default
 * BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES (60). Apps cannot read that env —
 * keep this constant in sync with ops config when changing the default.
 */

/** Default minutes shown in user-facing copy (must match payment-service env default). */
export const BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_COPY = 60;

/** @deprecated Use BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_COPY */
export const BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS_COPY =
  BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_COPY / 60;

/** Human label for completion-window duration (e.g. "60 mins", "1 hour", "90 mins"). */
export function formatCompletionWindowDuration(
  minutes: number = BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_COPY,
): string {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 'a short while';
  if (m === 1) return '1 min';
  if (m < 60) return `${Math.round(m)} mins`;
  if (m % 60 === 0) {
    const h = m / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${Math.round(m)} mins`;
}

const WINDOW_DURATION = formatCompletionWindowDuration(
  BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_COPY,
);

export const BOOK_NOW_PARTNER_PAYOUT_COPY = {
  /** In-app notification title when Book Now work completes and payout is held for the window. */
  workCompletedTitle: 'Work completed',

  /**
   * In-app notification body after Book Now auto-complete.
   * Uses duration wording aligned with the raise-issue / visibility window.
   */
  workCompletedSoftBody: `Work completed. Payout will appear in Payments after the completion window (~${WINDOW_DURATION}).`,

  /** Event key for soft Book Now payout visibility notification. */
  pendingVisibilityEventKey: 'PAYOUT_PENDING_VISIBILITY',

  /** Partner list / transaction subtitle when unlock time is known. */
  availableAfterPrefix: 'Available after',

  /** Partner list subtitle when unlock time is not yet known. */
  availableAfterWindowFallback: `Available after the completion window (~${WINDOW_DURATION})`,

  /** Shorter fallback without duration (list density). */
  availableAfterWindowShort: 'Available after the completion window',

  /** Pending completion-window status chip. */
  pendingCompletionWindow: 'Pending completion window',

  /** Fallback title for payout card while visibility is held. */
  payoutPendingTitle: 'Payout pending',

  /** Transaction description while partner visibility is held. */
  payoutPendingDescription: 'Payout pending — available after the completion window',

  /** Metadata / API partnerVisibilityMessage. */
  partnerVisibilityMessage:
    'Payout will appear after the completion window. No action needed.',

  // ── Work Progress (partner TaskTracking completed state) ─────────────────

  workProgressCompletionWindowTitle: 'Work Completed',
  workProgressCompletionWindowBody: `Payout is pending the completion window (~${WINDOW_DURATION}). If the customer reports an issue, payout may be held. You'll see it under Payments as pending until then.`,
  workProgressCompletionWindowHint: 'No action needed unless support contacts you.',

  workProgressProcessingTitle: 'Work Completed',
  workProgressProcessingBody: 'Payout is processing — on the way to your bank.',

  workProgressHeldTitle: 'Payout on hold',
  workProgressHeldBody:
    'The customer reported an issue. Payout is paused until this is resolved.',

  workProgressCompletedTitle: 'Work Completed',
  workProgressCompletedBody: 'Amount credited to your account.',

  workProgressFailedTitle: 'Payout issue',
  workProgressFailedBody:
    'There was a problem with this payout. Please check Payments or contact support.',

  workProgressCtaViewEarnings: 'View Earnings',
  workProgressCtaContactSupport: 'Contact Support',
} as const;

export function formatAvailableAfter(unlockLabel: string): string {
  const label = String(unlockLabel || '').trim();
  if (!label) return BOOK_NOW_PARTNER_PAYOUT_COPY.availableAfterWindowShort;
  return `${BOOK_NOW_PARTNER_PAYOUT_COPY.availableAfterPrefix} ${label}`;
}
