import crypto from 'crypto';
import logger from '../config/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const CURRENT_KEY_VERSION = 'v1';

function parseEncryptionKey(): Buffer | null {
  const raw = process.env.BANK_ACCOUNT_ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  try {
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
  } catch {
    // fall through
  }

  const hex = raw.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, 'hex');
  }

  logger.error('BANK_ACCOUNT_ENCRYPTION_KEY must be 32 bytes (base64 or 64-char hex)');
  return null;
}

export function isBankFieldEncryptionConfigured(): boolean {
  return parseEncryptionKey() !== null;
}

export function encryptBankField(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (!trimmed) {
    throw new Error('Cannot encrypt empty bank field');
  }

  const key = parseEncryptionKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY is required in production');
    }
    throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY is not configured');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = {
    v: CURRENT_KEY_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

export function decryptBankField(ciphertext: string | null | undefined): string | null {
  if (!ciphertext?.trim()) return null;

  const key = parseEncryptionKey();
  if (!key) {
    logger.warn('Bank field decrypt skipped — encryption key not configured');
    return null;
  }

  try {
    const envelopeJson = Buffer.from(ciphertext, 'base64').toString('utf8');
    const envelope = JSON.parse(envelopeJson) as {
      v?: string;
      iv?: string;
      tag?: string;
      data?: string;
    };

    if (!envelope.iv || !envelope.tag || !envelope.data) {
      return null;
    }

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (error: unknown) {
    logger.warn('Bank field decrypt failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function last4OfAccountNumber(accountNumber: string): string {
  const digits = String(accountNumber || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : digits;
}

export function maskAccountNumberForDisplay(accountNumber: string): string {
  const last4 = last4OfAccountNumber(accountNumber);
  if (!last4) return 'XXXX';
  return `XXXX${last4}`;
}

export function maskAccountHolderNameForDisplay(name: string): string {
  const v = (name || '').trim();
  if (!v) return v;
  const parts = v.split(/\s+/).filter(Boolean);
  const first = parts[0] || '';
  const lastInitial = parts.length > 1 ? parts[parts.length - 1]?.[0] : '';
  const firstMasked =
    first.length <= 2
      ? first[0] + '*'
      : first.slice(0, 2) + '*'.repeat(Math.min(6, first.length - 2));
  return lastInitial ? `${firstMasked} ${lastInitial}.` : firstMasked;
}
