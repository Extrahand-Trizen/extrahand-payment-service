import axios from 'axios';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

type RazorpayXAuth = {
  username: string;
  password: string;
  accountNumber: string;
};

function getRazorpayXAuth(): RazorpayXAuth {
  const env = validateEnv();

  const username = env.RAZORPAYX_KEY_ID || env.RAZORPAY_KEY_ID;
  const password = env.RAZORPAYX_KEY_SECRET || env.RAZORPAY_KEY_SECRET;
  const accountNumber = env.RAZORPAYX_ACCOUNT_NUMBER;

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
  if (params.phone) payload.contact = params.phone;

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
}> {
  const auth = getRazorpayXAuth();

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
      timeout: 20000,
    }
  );

  logger.info('RazorpayX payout created', {
    payoutId: response.data.id,
    status: response.data.status,
    referenceId: response.data.reference_id,
  });

  return {
    id: response.data.id,
    status: response.data.status,
    amount: response.data.amount,
    referenceId: response.data.reference_id,
  };
}
