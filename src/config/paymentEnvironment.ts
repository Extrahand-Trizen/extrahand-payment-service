import Razorpay from 'razorpay';
import { validateEnv } from './env';
import { UserServiceClient } from '../clients/UserServiceClient';

export type PaymentEnvironment = 'live' | 'test';

const env = validateEnv();

const legacyKeyId = env.RAZORPAY_KEY_ID || '';
const legacyKeySecret = env.RAZORPAY_KEY_SECRET || '';
const legacyIsTest = legacyKeyId.startsWith('rzp_test_');
const liveKeyId = env.RAZORPAY_LIVE_KEY_ID || (!legacyIsTest ? legacyKeyId : '');
const liveKeySecret = env.RAZORPAY_LIVE_KEY_SECRET || (!legacyIsTest ? legacyKeySecret : '');
const testKeyId = env.RAZORPAY_TEST_KEY_ID || (legacyIsTest ? legacyKeyId : '');
const testKeySecret = env.RAZORPAY_TEST_KEY_SECRET || (legacyIsTest ? legacyKeySecret : '');

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
  if (!uid?.trim()) return 'live';
  if (!testKeyId || !testKeySecret) return 'live';
  return (await UserServiceClient.isPaymentTester(uid)) ? 'test' : 'live';
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