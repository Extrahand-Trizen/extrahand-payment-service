/**
 * Escrow create-order bypass: no Razorpay API when poster Firebase UID is listed.
 * verify-payment accepts synthetic ids for those orders (see PaymentController).
 *
 * Configure (payment-service env):
 *   PLAY_REVIEW_BYPASS_UIDS=comma,separated,firebase_uids
 *
 * Must match the paying user's Firebase uid (poster). Phone alone is not used here.
 */

function parseList(raw: string | undefined): string[] {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isReviewBypassUid(uid: string | undefined | null): boolean {
  if (uid == null || String(uid).trim() === '') return false;
  const allow = new Set(parseList(process.env.PLAY_REVIEW_BYPASS_UIDS));
  return allow.has(String(uid).trim());
}

/** Prefix for mock Razorpay order ids (never sent to Razorpay). */
export const REVIEW_ORDER_ID_PREFIX = 'eh_review_';

export function isReviewBypassOrderId(orderId: string | undefined | null): boolean {
  return typeof orderId === 'string' && orderId.startsWith(REVIEW_ORDER_ID_PREFIX);
}
