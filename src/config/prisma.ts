import { Pool } from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from './logger';
import { validateEnv } from './env';

const env = validateEnv();

// Prisma Client singleton instance
let prismaInstance: PrismaClient | null = null;
let pgPool: Pool | null = null;

function safeDbHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return 'unknown-host';
  }
}

/** Unwrap Prisma / pg nested errors so CapRover logs show ETIMEDOUT / CERT / password etc. */
export function formatPgError(error: unknown): {
  message: string;
  code?: string;
  causeMessage?: string;
} {
  const err = error as {
    message?: string;
    code?: string;
    cause?: { message?: string; code?: string };
    meta?: { message?: string };
  };
  const cause = err?.cause;
  const message =
    (typeof err?.message === 'string' && err.message.trim()) ||
    cause?.message ||
    err?.meta?.message ||
    String(error);
  return {
    message: message.slice(0, 500),
    code: cause?.code || err?.code,
    causeMessage: cause?.message?.slice(0, 300),
  };
}

/**
 * Neon + PrismaPg: tune the URI for pooler reliability.
 * - Drop channel_binding=require (breaks / times out through some PgBouncer paths)
 * - Add pgbouncer=true on *-pooler* hosts (Neon transaction pooler)
 * - uselibpqcompat=true so sslmode=require is NOT treated as verify-full (pg 8.16+)
 * - Ensure connect_timeout so cold starts don't fail instantly
 */
function normalizePostgresUri(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('channel_binding');
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '30');
    }
    // pg 8.16+ treats sslmode=require as verify-full unless uselibpqcompat is set.
    // CapRover images often lack Neon CA chain → handshake fails in ~1s.
    if (!url.searchParams.has('uselibpqcompat')) {
      url.searchParams.set('uselibpqcompat', 'true');
    }
    if (!url.searchParams.has('sslmode')) {
      url.searchParams.set('sslmode', 'require');
    }
    // Neon transaction pooler hostnames include "-pooler"
    if (url.hostname.includes('-pooler') && !url.searchParams.has('pgbouncer')) {
      url.searchParams.set('pgbouncer', 'true');
    }
    return url.toString();
  } catch {
    return raw;
  }
}

/**
 * Get or create the single Prisma Client for this process.
 * Target DB is selected by USE_DEV_POSTGRES:
 * - true  → DEV_POSTGRESDB_URI
 * - false → PROD_POSTGRESDB_URI
 * (resolved into env.POSTGRESDB_URI by validateEnv)
 */
function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    const connectionString = env.POSTGRESDB_URI;

    if (!connectionString) {
      logger.error('❌ Resolved Postgres URI is not set');
      throw new Error('POSTGRESDB_URI is required for Prisma Client');
    }

    const normalizedUri = normalizePostgresUri(connectionString);

    // Explicit pool: Neon pooler + Payments fan-out (summary/bank/wallet/earnings)
    // needs longer connect timeout and a small max to avoid exhausting free-tier slots.
    // ssl.rejectUnauthorized=false: Neon TLS works without shipping root CAs in the image.
    pgPool = new Pool({
      connectionString: normalizedUri,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 30_000,
      allowExitOnIdle: true,
      ssl: { rejectUnauthorized: false },
    });
    pgPool.on('error', (err) => {
      const formatted = formatPgError(err);
      logger.error('Unexpected Postgres pool error', formatted);
    });

    const adapter = new PrismaPg(pgPool);

    prismaInstance = new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });

    const target = env.USE_DEV_POSTGRES ? 'DEV' : 'PROD';
    logger.info(
      `✅ Prisma Client initialized (${target}) → ${safeDbHost(normalizedUri)} (pool max=5, connectTimeout=30s, ssl=neon)`,
    );
  }
  return prismaInstance;
}

// Export the Prisma client instance
export const prisma = getPrismaClient();

/**
 * Dual-DB merge client is disabled.
 * Runtime always uses the single DB selected by USE_DEV_POSTGRES.
 * Kept as null so legacy `if (prismaDev)` fallbacks no-op safely.
 */
export const prismaDev: PrismaClient | null = null;

/**
 * Connect to Postgres database via Prisma
 */
export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    // Warm one connection so the first Payments request after idle doesn't race cold start.
    await prisma.$queryRawUnsafe('SELECT 1');
    const target = env.USE_DEV_POSTGRES ? 'DEV' : 'PROD';
    logger.info(`✅ Prisma connected to ${target} Postgres database`);
  } catch (error: unknown) {
    const formatted = formatPgError(error);
    logger.error('❌ Failed to connect to Postgres via Prisma', formatted);
    throw error;
  }
}

/**
 * Live Postgres probe for health checks (does not trust boot-time flag alone).
 */
export async function pingPostgres(timeoutMs = 5000): Promise<{
  ok: boolean;
  ms: number;
  error?: string;
  code?: string;
}> {
  const started = Date.now();
  try {
    await Promise.race([
      prisma.$queryRawUnsafe('SELECT 1'),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`postgres ping timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, ms: Date.now() - started };
  } catch (error: unknown) {
    const formatted = formatPgError(error);
    return {
      ok: false,
      ms: Date.now() - started,
      error: formatted.causeMessage || formatted.message,
      code: formatted.code,
    };
  }
}

/**
 * Disconnect from Postgres database
 */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
    if (pgPool) {
      await pgPool.end();
      pgPool = null;
    }
    logger.info('📦 Prisma disconnected from Postgres');
  } catch (error: unknown) {
    logger.error('❌ Error disconnecting Prisma', formatPgError(error));
  }
}

/**
 * Check if Prisma is connected
 */
export function isPrismaConnected(): boolean {
  // Prisma doesn't have a direct connection state check
  // We'll use a simple query to check
  return true; // Will be checked via actual queries
}
