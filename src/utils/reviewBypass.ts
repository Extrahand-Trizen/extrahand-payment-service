/**
 * Escrow create-order bypass: skip Razorpay when poster matches env allowlist.
 * verify-payment accepts synthetic ids for orders flagged reviewBypass (see PaymentController).
 *
 * Configure (payment-service env):
 *   PLAY_REVIEW_BYPASS_PHONES=comma,separated (+919876543210 or 9876543210) — primary for Play review
 *   PLAY_REVIEW_BYPASS_UIDS=comma,separated,firebase_uids — optional legacy
 *
 * Phone bypass: client must pass `posterPhone` in escrow `metadata` (last 10 digits are matched).
 */

function parseList(raw: string | undefined): string[] {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Last 10 digits for comparison when numbers are formatted differently */
function normalizePhoneDigits(phone: string | undefined | null): string | null {
  if (phone == null || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits.length > 0 ? digits : null;
}

export function isReviewBypassUid(uid: string | undefined | null): boolean {
  if (uid == null || String(uid).trim() === '') return false;
  const allow = new Set(parseList(process.env.PLAY_REVIEW_BYPASS_UIDS));
  return allow.has(String(uid).trim());
}

export function isReviewBypassPhone(phone: string | undefined | null): boolean {
  const n = normalizePhoneDigits(phone);
  if (!n) return false;
  for (const entry of parseList(process.env.PLAY_REVIEW_BYPASS_PHONES)) {
    const e = normalizePhoneDigits(entry);
    if (e && e === n) return true;
  }
  return false;
}

/** Prefix for mock Razorpay order ids (never sent to Razorpay). */
export const REVIEW_ORDER_ID_PREFIX = 'eh_review_';

export function isReviewBypassOrderId(orderId: string | undefined | null): boolean {
  return typeof orderId === 'string' && orderId.startsWith(REVIEW_ORDER_ID_PREFIX);
}
