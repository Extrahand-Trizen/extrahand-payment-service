import Razorpay from 'razorpay';
import { validateEnv } from './env';
import { getPaymentClient, paymentKeys } from './paymentEnvironment';

const env = validateEnv();

export const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

export const RAZORPAY_CONFIG = {
  keyId: env.RAZORPAY_KEY_ID,
  keySecret: env.RAZORPAY_KEY_SECRET,
};

export { getPaymentClient, paymentKeys };



