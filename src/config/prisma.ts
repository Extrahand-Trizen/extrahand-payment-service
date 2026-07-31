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

/**
 * Neon + PrismaPg: tune the URI for pooler reliability.
 * - Drop channel_binding=require (breaks / times out through some PgBouncer paths)
 * - Add pgbouncer=true on *-pooler* hosts (Neon transaction pooler)
 * - Ensure connect_timeout so cold starts don't fail instantly
 */
function normalizePostgresUri(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.delete('channel_binding');
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', '30');
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
    pgPool = new Pool({
      connectionString: normalizedUri,
      max: 5,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    pgPool.on('error', (err) => {
      logger.error('Unexpected Postgres pool error', { message: err.message });
    });

    const adapter = new PrismaPg(pgPool);

    prismaInstance = new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });

    const target = env.USE_DEV_POSTGRES ? 'DEV' : 'PROD';
    logger.info(
      `✅ Prisma Client initialized (${target}) → ${safeDbHost(normalizedUri)} (pool max=5, connectTimeout=30s)`,
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
  } catch (error: any) {
    logger.error('❌ Failed to connect to Postgres via Prisma:', error.message);
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
  } catch (error: any) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: error?.message || String(error),
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
  } catch (error: any) {
    logger.error('❌ Error disconnecting Prisma:', error.message);
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
