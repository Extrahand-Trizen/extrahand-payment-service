/**
 * Book Now partner payout visibility — delay until after the completion / raise-issue window.
 */

import { BOOK_NOW_PARTNER_PAYOUT_COPY } from '../constants/bookNowPartnerPayoutCopy';

/** Default: 60 minutes (was 1 hour). Override via BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES. */
export const BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_DEFAULT = 60;

/**
 * Minutes after Book Now payout create before partner sees it in Transactions/Payouts.
 *
 * Env (preferred): `BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES` (e.g. `30`, `0` = immediate).
 * Legacy fallback: `BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS` × 60.
 */
export function getBookNowPayoutPartnerVisibleAfterMinutes(): number {
  const minsRaw = process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES;
  if (minsRaw != null && String(minsRaw).trim() !== '') {
    const n = Number(minsRaw);
    if (Number.isFinite(n) && n >= 0) return n;
  }

  const hoursRaw = process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS;
  if (hoursRaw != null && String(hoursRaw).trim() !== '') {
    const hours = Number(hoursRaw);
    if (Number.isFinite(hours) && hours >= 0) return hours * 60;
  }

  return BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES_DEFAULT;
}

/** @deprecated Prefer getBookNowPayoutPartnerVisibleAfterMinutes() */
export function getBookNowPayoutPartnerVisibleAfterHours(): number {
  return getBookNowPayoutPartnerVisibleAfterMinutes() / 60;
}

export function isBookNowBookingMode(value: unknown): boolean {
  return String(value || '').trim() === 'book_now';
}

/** Detect Book Now from escrow / payout metadata. */
export function isBookNowFromMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const m = metadata as Record<string, unknown>;
  if (isBookNowBookingMode(m.bookingMode)) return true;
  if (String(m.bookingSource || '').trim() === 'book_now') return true;
  return !!String(m.bookingOrderId || '').trim();
}

export function resolvePartnerVisibleAt(params: {
  isBookNow: boolean;
  from?: Date;
}): Date | null {
  if (!params.isBookNow) return null;
  const minutes = getBookNowPayoutPartnerVisibleAfterMinutes();
  const from = params.from ?? new Date();
  return new Date(from.getTime() + minutes * 60 * 1000);
}

export function isPartnerVisibilityHeld(
  partnerVisibleAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!partnerVisibleAt) return false;
  const at =
    partnerVisibleAt instanceof Date ? partnerVisibleAt : new Date(String(partnerVisibleAt));
  if (!Number.isFinite(at.getTime())) return false;
  return now.getTime() < at.getTime();
}

/**
 * Prisma filter: payout is partner-visible now (marketplace / unlocked Book Now).
 * Use on partner-facing earnings aggregates and list queries.
 */
export function partnerVisibleNowWhere(now: Date = new Date()): {
  OR: Array<{ partnerVisibleAt: null } | { partnerVisibleAt: { lte: Date } }>;
} {
  return {
    OR: [{ partnerVisibleAt: null }, { partnerVisibleAt: { lte: now } }],
  };
}

/** Partner-facing presentation while visibility is held. */
export function applyPartnerVisibilityToPayoutPayload<T extends Record<string, unknown>>(
  payout: T,
  now: Date = new Date(),
): T & {
  partnerVisibleAt: string | null;
  partnerVisibilityHeld: boolean;
} {
  const rawAt = (payout as { partnerVisibleAt?: unknown }).partnerVisibleAt;
  const held = isPartnerVisibilityHeld(
    rawAt instanceof Date || typeof rawAt === 'string' ? rawAt : null,
    now,
  );
  const partnerVisibleAt =
    rawAt instanceof Date
      ? rawAt.toISOString()
      : typeof rawAt === 'string' && rawAt.trim()
        ? rawAt
        : null;

  const next: Record<string, unknown> = {
    ...payout,
    partnerVisibleAt,
    partnerVisibilityHeld: held,
  };

  if (held) {
    // Keep amount; present as processing so UI shows pending placeholder, not "Received".
    next.status = 'processing';
    const meta =
      next.metadata && typeof next.metadata === 'object' && !Array.isArray(next.metadata)
        ? { ...(next.metadata as Record<string, unknown>) }
        : {};
    meta.partnerVisibilityHeld = true;
    meta.partnerVisibleAt = partnerVisibleAt;
    meta.partnerVisibilityMessage = BOOK_NOW_PARTNER_PAYOUT_COPY.partnerVisibilityMessage;
    next.metadata = meta;
  }

  return next as T & {
    partnerVisibleAt: string | null;
    partnerVisibilityHeld: boolean;
  };
}
