import { validateEnv } from './env';
import { getPaymentClient, paymentKeys } from './paymentEnvironment';

const env = validateEnv();
const liveClient = getPaymentClient('live');

export const razorpay = liveClient;

export const RAZORPAY_CONFIG = {
  keyId: env.RAZORPAY_LIVE_KEY_ID || '',
  keySecret: env.RAZORPAY_LIVE_KEY_SECRET || '',
};

export { getPaymentClient, paymentKeys };



