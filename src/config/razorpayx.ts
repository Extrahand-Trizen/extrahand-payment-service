import axios from 'axios';
import { validateEnv } from './env';

const env = validateEnv();

export const RAZORPAYX_CONFIG = {
  keyId: env.RAZORPAYX_KEY_ID,
  keySecret: env.RAZORPAYX_KEY_SECRET,
  accountNumber: env.RAZORPAYX_ACCOUNT_NUMBER,
};

export const razorpayXClient = axios.create({
  baseURL: 'https://api.razorpay.com/v1',
  auth: {
    username: RAZORPAYX_CONFIG.keyId,
    password: RAZORPAYX_CONFIG.keySecret,
  },
  headers: {
    'Content-Type': 'application/json',
  },
});
