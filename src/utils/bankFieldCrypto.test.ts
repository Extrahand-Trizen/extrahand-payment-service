import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  decryptBankField,
  encryptBankField,
  maskAccountNumberForDisplay,
} from './bankFieldCrypto';

describe('bankFieldCrypto', () => {
  it('encrypts and decrypts account numbers', () => {
    process.env.BANK_ACCOUNT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    const plain = '123456789012';
    const cipher = encryptBankField(plain);
    assert.notEqual(cipher, plain);
    assert.equal(decryptBankField(cipher), plain);
  });

  it('masks account numbers for display', () => {
    assert.equal(maskAccountNumberForDisplay('123456789012'), 'XXXX9012');
  });
});
