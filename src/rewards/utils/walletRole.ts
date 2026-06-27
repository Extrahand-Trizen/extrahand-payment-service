/** Wallet role keys aligned with Profile roles: poster | tasker */
export type WalletRole = 'poster' | 'tasker';
export type ReferralChannel = 'poster' | 'tasker';

const POSTER_ALIASES = new Set(['poster', 'customer', 'requester']);

function normalizeRoleToken(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/** Normalize wallet role from query/body; defaults to tasker for legacy clients. */
export function parseWalletRole(raw: unknown, defaultRole: WalletRole = 'tasker'): WalletRole {
  const token = normalizeRoleToken(raw);
  if (POSTER_ALIASES.has(token)) return 'poster';
  if (token === 'tasker' || token === 'helper' || token === 'performer') return 'tasker';
  return defaultRole;
}

export function parseReferralChannel(
  raw: unknown,
  defaultChannel: ReferralChannel = 'tasker'
): ReferralChannel {
  return parseWalletRole(raw, defaultChannel);
}

/** Max poster coin discount at checkout (percent of booking amount). */
export function maxPosterBookingCoinDiscountRupees(
  bookingAmountInr: number,
  capPercent = 0.1
): number {
  const amount = Number.isFinite(bookingAmountInr) ? Math.max(bookingAmountInr, 0) : 0;
  const pct = Number.isFinite(capPercent) ? Math.min(Math.max(capPercent, 0), 1) : 0.1;
  return Math.round(amount * pct * 100) / 100;
}

/** Max tasker coin offset on platform fee only (percent of platform fee). */
export function maxTaskerPlatformFeeCoinDiscountRupees(
  platformFeeInr: number,
  capPercent = 0.15
): number {
  const fee = Number.isFinite(platformFeeInr) ? Math.max(platformFeeInr, 0) : 0;
  const pct = Number.isFinite(capPercent) ? Math.min(Math.max(capPercent, 0), 1) : 0.15;
  return Math.round(fee * pct * 100) / 100;
}

/** @deprecated Use maxPosterBookingCoinDiscountRupees */
export const maxCustomerBookingCoinDiscountRupees = maxPosterBookingCoinDiscountRupees;
