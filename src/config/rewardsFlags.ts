import logger from './logger';

function envBool(key: string, defaultValue: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw === 'true' || raw === '1';
}

function isExplicitlyFalse(key: string): boolean {
  const raw = process.env[key];
  return raw === 'false' || raw === '0';
}

export const paymentRewardsFlags = {
  /** Canonical grants path is issue-grants (Phase 1; env false rejected at startup) */
  REWARDS_V2_ENABLED: true as const,
  USE_USER_SERVICE_REWARD_CONTEXT: envBool('USE_USER_SERVICE_REWARD_CONTEXT', true),
  /** Emit PAYMENT_COMPLETED to user-service for referral/task qualification */
  EMIT_PAYMENT_COMPLETED_EVENTS: envBool('EMIT_PAYMENT_COMPLETED_EVENTS', true),
  /** Role-aware wallets (customer/tasker) */
  ROLE_BASED_WALLET_ENABLED: envBool('ROLE_BASED_WALLET_ENABLED', true),
  /** Customer checkout coin cap (10% of booking amount) */
  CUSTOMER_BOOKING_COIN_CAP_ENABLED: envBool('CUSTOMER_BOOKING_COIN_CAP_ENABLED', true),
  /** Tasker payout coin cap (15% of platform fee; GST unchanged) */
  TASKER_PLATFORM_FEE_COIN_CAP_ENABLED: envBool('TASKER_PLATFORM_FEE_COIN_CAP_ENABLED', true),
};

export function validatePaymentRewardsConfiguration(): void {
  if (isExplicitlyFalse('REWARDS_V2_ENABLED')) {
    throw new Error(
      'REWARDS_V2_ENABLED=false is not supported on payment-service (rewards Phase 1). Use issue-grants only.'
    );
  }

  if (!paymentRewardsFlags.EMIT_PAYMENT_COMPLETED_EVENTS) {
    logger.warn(
      '[rewards] EMIT_PAYMENT_COMPLETED_EVENTS=false — referral qualification on payment capture is disabled.'
    );
  }

  logger.info('[rewards] Payment rewards configuration (Phase 1)', {
    rewardsV2: true,
    emitPaymentCompletedEvents: paymentRewardsFlags.EMIT_PAYMENT_COMPLETED_EVENTS,
    useUserServiceRewardContext: paymentRewardsFlags.USE_USER_SERVICE_REWARD_CONTEXT,
    roleBasedWalletEnabled: paymentRewardsFlags.ROLE_BASED_WALLET_ENABLED,
    customerBookingCapEnabled: paymentRewardsFlags.CUSTOMER_BOOKING_COIN_CAP_ENABLED,
    taskerPlatformFeeCapEnabled: paymentRewardsFlags.TASKER_PLATFORM_FEE_COIN_CAP_ENABLED,
  });
}
