import crypto from 'crypto';
import { prisma } from '../config/prisma';

const HASH_ALGO = 'sha512';
const ITERATIONS = 100_000;
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, HASH_ALGO).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;

  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const hash = parts[3];

  if (!iterations || !salt || !hash) return false;

  const computed = crypto.pbkdf2Sync(password, salt, iterations, KEYLEN, HASH_ALGO).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(computed, 'hex'));
}

export async function getAdminUser(username: string) {
  return await prisma.adminUser.findUnique({ where: { username } });
}

export async function upsertAdminUser(username: string, password: string) {
  const passwordHash = hashPassword(password);
  const fallbackEmail = `${username}@internal.local`;
  return await prisma.adminUser.upsert({
    where: { username },
    create: { username, email: fallbackEmail, passwordHash, status: 'active' },
    update: { passwordHash },
  });
}
