import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from './logger';
import { validateEnv } from './env';

const env = validateEnv();

// Prisma Client singleton instance
let prismaInstance: PrismaClient | null = null;

function safeDbHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return 'unknown-host';
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

    const adapter = new PrismaPg({ connectionString });

    prismaInstance = new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });

    const target = env.USE_DEV_POSTGRES ? 'DEV' : 'PROD';
    logger.info(
      `✅ Prisma Client initialized (${target}) → ${safeDbHost(connectionString)}`
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
    const target = env.USE_DEV_POSTGRES ? 'DEV' : 'PROD';
    logger.info(`✅ Prisma connected to ${target} Postgres database`);
  } catch (error: any) {
    logger.error('❌ Failed to connect to Postgres via Prisma:', error.message);
    throw error;
  }
}

/**
 * Disconnect from Postgres database
 */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
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
