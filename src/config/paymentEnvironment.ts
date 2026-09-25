import Razorpay from 'razorpay';
import { validateEnv } from './env';
import { UserServiceClient } from '../clients/UserServiceClient';

export type PaymentEnvironment = 'live' | 'test';

const env = validateEnv();

const liveKeyId = env.RAZORPAY_LIVE_KEY_ID || '';
const liveKeySecret = env.RAZORPAY_LIVE_KEY_SECRET || '';
const testKeyId = env.RAZORPAY_TEST_KEY_ID || '';
const testKeySecret = env.RAZORPAY_TEST_KEY_SECRET || '';

export const paymentSecrets: Record<PaymentEnvironment, string> = {
  live: liveKeySecret,
  test: testKeySecret,
};

export const paymentClients: Record<PaymentEnvironment, Razorpay | null> = {
  live: liveKeyId && liveKeySecret
    ? new Razorpay({ key_id: liveKeyId, key_secret: liveKeySecret })
    : null,
  test: testKeyId && testKeySecret
    ? new Razorpay({ key_id: testKeyId, key_secret: testKeySecret })
    : null,
};

export const paymentKeys: Record<PaymentEnvironment, string> = {
  live: liveKeyId,
  test: testKeyId,
};

export async function resolvePaymentEnvironment(uid?: string | null): Promise<PaymentEnvironment> {
  const normalizedUid = uid?.trim();
  if (!normalizedUid) {
    return 'live';
  }
  if (!testKeyId || !testKeySecret) {
    console.warn('[PAYMENT DEBUG] Test credentials are not configured; using live environment');
    return 'live';
  }

  const isTester = await UserServiceClient.isPaymentTester(normalizedUid);
  const environment: PaymentEnvironment = isTester ? 'test' : 'live';
  console.log('[PAYMENT DEBUG] Environment selected', {
    uidPresent: true,
    isPaymentTester: isTester,
    paymentEnvironment: environment,
  });
  return environment;
}

export function getPaymentClient(environment: PaymentEnvironment): Razorpay {
  const client = paymentClients[environment];
  if (!client) throw new Error(`Razorpay ${environment} credentials are not configured`);
  return client;
}

export function normalizePaymentEnvironment(value: unknown): PaymentEnvironment {
  return String(value || '').toLowerCase() === 'test' ? 'test' : 'live';
}

export function getWebhookSecret(environment: PaymentEnvironment): string {
  if (environment === 'test') return env.RAZORPAY_TEST_WEBHOOK_SECRET || '';
  return env.RAZORPAY_LIVE_WEBHOOK_SECRET || env.RAZORPAY_WEBHOOK_SECRET || '';
}