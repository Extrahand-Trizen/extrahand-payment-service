import logger from '../config/logger';

export const REFERRAL_COINS_LOG_TAG = '[REFERRAL_COINS]';

export type PaymentReferralCoinsStep =
  | 'issue_grants_request'
  | 'issue_grants_response'
  | 'issue_grant_item'
  | 'issue_grant_item_error'
  | 'wallet_credit_ok';

export function logPaymentReferralCoins(
  step: PaymentReferralCoinsStep,
  payload: Record<string, unknown>,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  const line = `${REFERRAL_COINS_LOG_TAG} step=${step} ${JSON.stringify({
    service: 'payment-service',
    at: new Date().toISOString(),
    ...payload,
  })}`;

  if (level === 'error') {
    logger.error(line);
    return;
  }
  if (level === 'warn') {
    logger.warn(line);
    return;
  }
  logger.info(line);
}
