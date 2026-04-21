import axios from 'axios';
import crypto from 'crypto';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

/** Razorpay Contacts API expects E.164; Indian numbers often arrive as 10 digits without +91 */
export function normalizeIndianPhoneForRazorpay(input?: string): string | undefined {
  if (!input?.trim()) return undefined;
  const raw = input.trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return raw;
}

export type RazorpayApiErrorInfo = {
  message: string;
  /** True when Razorpay returned 4xx (user-fixable / validation) */
  isClientError: boolean;
  httpStatus?: number;
};

/** Turn axios + Razorpay JSON body into a message; avoid generic "Request failed with status code 400". */
export function parseRazorpayApiError(error: unknown): RazorpayApiErrorInfo {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data as Record<string, unknown> | undefined;
    let message = '';

    if (data && typeof data === 'object') {
      const errObj = data.error;
      if (typeof errObj === 'string') {
        message = errObj;
      } else if (errObj && typeof errObj === 'object') {
        const e = errObj as Record<string, unknown>;
        const desc = e.description;
        const reason = e.reason;
        const code = e.code;
        if (typeof desc === 'string') message = desc;
        else if (typeof reason === 'string') message = reason;
        else if (typeof code === 'string') message = code;
      }
      if (!message && typeof data.message === 'string') message = data.message;
    }

    if (!message) {
      message = error.message;
    }

    const isClientError = typeof status === 'number' && status >= 400 && status < 500;
    return { message, isClientError, httpStatus: status };
  }

  if (error instanceof Error) {
    return { message: error.message, isClientError: false };
  }

  return { message: 'Failed to communicate with Razorpay', isClientError: false };
}

type RazorpayXAuth = {
  username: string;
  password: string;
  accountNumber: string;
};

function getRazorpayXAuth(): RazorpayXAuth {
  const env = validateEnv();

  const username = env.RAZORPAYX_KEY_ID || env.RAZORPAY_KEY_ID;
  const password = env.RAZORPAYX_KEY_SECRET || env.RAZORPAY_KEY_SECRET;
  const accountNumber = env.RAZORPAYX_ACCOUNT_NUMBER || env.RAZORPAY_ACCOUNT_NUMBER;

  if (!username || !password || !accountNumber) {
    throw new Error('RazorpayX credentials are not configured correctly');
  }

  return { username, password, accountNumber };
}

export async function createRazorpayXContact(params: {
  name: string;
  email?: string;
  phone?: string;
  referenceId: string;
}): Promise<{ id: string }> {
  const auth = getRazorpayXAuth();

  const payload: Record<string, unknown> = {
    name: params.name,
    type: 'employee',
    reference_id: params.referenceId,
    notes: {
      source: 'extrahand',
    },
  };

  if (params.email) payload.email = params.email;
  const phoneNorm = normalizeIndianPhoneForRazorpay(params.phone);
  if (phoneNorm) payload.contact = phoneNorm;

  const response = await axios.post('https://api.razorpay.com/v1/contacts', payload, {
    auth: {
      username: auth.username,
      password: auth.password,
    },
    timeout: 20000,
  });

  return { id: response.data.id };
}

export async function createRazorpayXFundAccount(params: {
  contactId: string;
  accountHolderName: string;
  ifscCode: string;
  accountNumber: string;
}): Promise<{ id: string }> {
  const auth = getRazorpayXAuth();

  const response = await axios.post(
    'https://api.razorpay.com/v1/fund_accounts',
    {
      contact_id: params.contactId,
      account_type: 'bank_account',
      bank_account: {
        name: params.accountHolderName,
        ifsc: params.ifscCode,
        account_number: params.accountNumber,
      },
    },
    {
      auth: {
        username: auth.username,
        password: auth.password,
      },
      timeout: 20000,
    }
  );

  return { id: response.data.id };
}

export async function createRazorpayXPayout(params: {
  fundAccountId: string;
  amountInPaise: number;
  referenceId: string;
  narration: string;
  mode?: 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
}): Promise<{
  id: string;
  status: string;
  amount: number;
  referenceId?: string;
  failureReason?: string;
}> {
  const auth = getRazorpayXAuth();

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        fundAccountId: params.fundAccountId,
        amountInPaise: params.amountInPaise,
        referenceId: params.referenceId,
        narration: params.narration,
        mode: params.mode || 'IMPS',
      })
    )
    .digest('hex')
    .slice(0, 32); // 4-36 chars, hex is allowed

  const response = await axios.post(
    'https://api.razorpay.com/v1/payouts',
    {
      account_number: auth.accountNumber,
      fund_account_id: params.fundAccountId,
      amount: params.amountInPaise,
      currency: 'INR',
      mode: params.mode || 'IMPS',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: params.referenceId,
      narration: params.narration,
    },
    {
      auth: {
        username: auth.username,
        password: auth.password,
      },
      headers: {
        // RazorpayX requires idempotency key for payout creation (avoids rejects on retries).
        'X-Payout-Idempotency': idempotencyKey,
      },
      timeout: 20000,
    }
  );

  logger.info('RazorpayX payout created', {
    payoutId: response.data.id,
    status: response.data.status,
    referenceId: response.data.reference_id,
    mode: response.data.mode || params.mode || 'IMPS',
  });

  return {
    id: response.data.id,
    status: response.data.status,
    amount: response.data.amount,
    referenceId: response.data.reference_id,
    failureReason:
      response.data.failure_reason ||
      response.data.error_description ||
      response.data.error_reason ||
      response.data.rejection_reason,
  };
}

export async function getRazorpayXPayoutStatus(payoutId: string): Promise<{
  id: string;
  status: string;
  amount?: number;
  referenceId?: string;
  failureReason?: string;
  processedAt?: string;
}> {
  const auth = getRazorpayXAuth();

  const response = await axios.get(`https://api.razorpay.com/v1/payouts/${payoutId}`, {
    auth: {
      username: auth.username,
      password: auth.password,
    },
    timeout: 20000,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  return {
    id: response.data.id || payoutId,
    status: response.data.status,
    amount: response.data.amount,
    referenceId: response.data.reference_id,
    failureReason:
      response.data.failure_reason ||
      response.data.error_description ||
      response.data.error_reason ||
      response.data.rejection_reason,
    processedAt: response.data.processed_at || response.data.completed_at,
  };
}
