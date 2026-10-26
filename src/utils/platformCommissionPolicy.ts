const PLATFORM_COMMISSION_POLICY_EFFECTIVE_AT = new Date('2026-10-26T15:15:00+05:30');

export function usesCurrentPlatformCommissionPolicy(escrow: {
  createdAt?: Date | string | null;
  metadata?: unknown;
}): boolean {
  const metadata =
    escrow.metadata &&
    typeof escrow.metadata === 'object' &&
    !Array.isArray(escrow.metadata)
      ? (escrow.metadata as Record<string, unknown>)
      : {};

  if (metadata.platformCommissionRateVersion === 2) {
    return true;
  }

  if (!escrow.createdAt) {
    return false;
  }

  const createdAt = new Date(escrow.createdAt);
  return (
    Number.isFinite(createdAt.getTime()) &&
    createdAt >= PLATFORM_COMMISSION_POLICY_EFFECTIVE_AT
  );
}
