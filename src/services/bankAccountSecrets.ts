import logger from '../config/logger';
import {
  decryptBankField,
  encryptBankField,
  isBankFieldEncryptionConfigured,
  last4OfAccountNumber,
  maskAccountHolderNameForDisplay,
  maskAccountNumberForDisplay,
} from '../utils/bankFieldCrypto';

export type BankAccountRow = {
  id: string;
  userId: string;
  accountNumber: string;
  ifscCode: string;
  bankName: string;
  accountHolderName: string;
  accountNumberEncrypted?: string | null;
  accountHolderNameEncrypted?: string | null;
  accountNumberLast4?: string | null;
  encryptionKeyVersion?: string | null;
  isVerified?: boolean;
  verifiedAt?: Date | null;
  verificationRef?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export function buildEncryptedBankAccountPersistFields(args: {
  accountNumber: string;
  accountHolderName: string;
}): {
  accountNumber: string;
  accountHolderName: string;
  accountNumberEncrypted: string;
  accountHolderNameEncrypted: string;
  accountNumberLast4: string;
  encryptionKeyVersion: string;
} {
  const accountNumber = args.accountNumber.trim();
  const accountHolderName = args.accountHolderName.trim();

  if (!isBankFieldEncryptionConfigured()) {
    throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY is not configured');
  }

  return {
    accountNumber: maskAccountNumberForDisplay(accountNumber),
    accountHolderName: maskAccountHolderNameForDisplay(accountHolderName),
    accountNumberEncrypted: encryptBankField(accountNumber),
    accountHolderNameEncrypted: encryptBankField(accountHolderName),
    accountNumberLast4: last4OfAccountNumber(accountNumber),
    encryptionKeyVersion: 'v1',
  };
}

/** Full account number for payouts/admin; null if only legacy masked row exists. */
export function resolveFullAccountNumber(row: BankAccountRow): string | null {
  const decrypted = decryptBankField(row.accountNumberEncrypted);
  if (decrypted) return decrypted;

  const stored = row.accountNumber?.trim() || '';
  if (stored.startsWith('XXXX') && stored.length <= 8) {
    return null;
  }
  if (/^\d{6,18}$/.test(stored.replace(/\s/g, ''))) {
    return stored.replace(/\s/g, '');
  }
  return null;
}

export function resolveFullAccountHolderName(row: BankAccountRow): string | null {
  const decrypted = decryptBankField(row.accountHolderNameEncrypted);
  if (decrypted) return decrypted;

  const stored = row.accountHolderName?.trim() || '';
  if (!stored || stored.includes('*')) {
    return null;
  }
  return stored;
}

export function resolveDisplayLast4(row: BankAccountRow): string | null {
  if (row.accountNumberLast4) return row.accountNumberLast4;
  const full = resolveFullAccountNumber(row);
  if (full) return last4OfAccountNumber(full);
  const masked = row.accountNumber || '';
  if (masked.startsWith('XXXX') && masked.length >= 8) {
    return masked.slice(-4);
  }
  return null;
}

/** Tasker/mobile API — never includes decrypted values. */
export function toTaskerFacingBankAccount(row: BankAccountRow) {
  const last4 = resolveDisplayLast4(row);
  return {
    id: row.id,
    bankName: row.bankName,
    accountHolderName: row.accountHolderName,
    accountNumber: last4 ? `XXXX${last4}` : maskAccountNumberForDisplay(row.accountNumber),
    ifscCode: row.ifscCode,
    isVerified: row.isVerified,
    createdAt: row.createdAt,
  };
}

/** Admin/service-auth API — includes full details when ciphertext is present. */
/** Resolve plaintext bank fields for legacy payout / mock transfer paths. */
export function resolvePayoutBankDetails(row: BankAccountRow): {
  accountNumber: string;
  ifscCode: string;
  accountHolderName: string;
  bankName: string;
} | null {
  const accountNumber = resolveFullAccountNumber(row);
  if (!accountNumber) return null;
  return {
    accountNumber,
    ifscCode: row.ifscCode,
    accountHolderName: resolveFullAccountHolderName(row) ?? row.accountHolderName,
    bankName: row.bankName,
  };
}

export function toAdminBankAccount(row: BankAccountRow) {
  const fullAccountNumber = resolveFullAccountNumber(row);
  const fullAccountHolderName = resolveFullAccountHolderName(row);
  const maskedAccountNumber = toTaskerFacingBankAccount(row).accountNumber;

  if (fullAccountNumber) {
    logger.info('Admin bank account fields decrypted for ops', {
      bankAccountId: row.id,
      userId: row.userId,
      accountNumberLast4: resolveDisplayLast4(row),
    });
  } else if (row.accountNumberEncrypted) {
    logger.warn('Admin bank account: encryption key not configured, falling back to masked value', {
      bankAccountId: row.id,
      userId: row.userId,
    });
  }

  // accountNumber: use full decrypted value if available, otherwise fall back to masked (e.g. XXXX8910)
  // accountHolderName: use full decrypted value if available, otherwise use stored value (may be masked)
  return {
    id: row.id,
    userId: row.userId,
    bankName: row.bankName,
    ifscCode: row.ifscCode,
    isVerified: row.isVerified,
    verifiedAt: row.verifiedAt,
    verificationRef: row.verificationRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    accountNumberLast4: resolveDisplayLast4(row),
    accountNumberMasked: maskedAccountNumber,
    accountNumber: fullAccountNumber ?? maskedAccountNumber,
    accountHolderName: fullAccountHolderName ?? row.accountHolderName,
    hasEncryptedAccountNumber: Boolean(row.accountNumberEncrypted),
    isDecrypted: Boolean(fullAccountNumber),
  };
}
