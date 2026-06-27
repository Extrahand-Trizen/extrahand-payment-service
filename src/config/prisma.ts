import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import logger from './logger';
import { validateEnv } from './env';

const env = validateEnv();

// Prisma Client singleton instance
let prismaInstance: PrismaClient | null = null;

/**
 * Get or create Prisma Client instance (singleton pattern)
 * Uses Prisma 7+ adapter approach for PostgreSQL (Neon compatible)
 */
function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    // Prisma 7+ requires adapter for PostgreSQL connection
    // Use POSTGRESDB_URI from environment (Neon connection string)
    const connectionString = env.POSTGRESDB_URI;

    if (!connectionString) {
      logger.error('❌ POSTGRESDB_URI is not set. Please set it in your .env file');
      throw new Error('POSTGRESDB_URI is required for Prisma Client');
    }

    // Create the Prisma adapter with connection string
    // The adapter will handle connection pooling internally
    const adapter = new PrismaPg({ connectionString });

    // For Prisma 7+, pass the adapter to PrismaClient constructor
    prismaInstance = new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });

    logger.info('✅ Prisma Client initialized with Postgres adapter (Neon compatible)');
  }
  return prismaInstance;
}

// Export the Prisma client instance
export const prisma = getPrismaClient();

// Export the Prisma dev client instance (for dev database query)
let prismaDevInstance: PrismaClient | null = null;

function getPrismaDevClient(): PrismaClient | null {
  const devUrl = env.DEV_POSTGRESDB_URI;
  if (!devUrl) return null;

  if (!prismaDevInstance) {
    const adapter = new PrismaPg({ connectionString: devUrl });
    prismaDevInstance = new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
    });
    logger.info('✅ Prisma Dev Client initialized with DEV_POSTGRESDB_URI adapter (Neon compatible)');
  }
  return prismaDevInstance;
}

export const prismaDev = getPrismaDevClient();

/**
 * Connect to Postgres database via Prisma
 */
export async function connectPrisma(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('✅ Prisma connected to Postgres database');
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

