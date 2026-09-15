import dns from 'node:dns';
import mongoose from 'mongoose';
import { validateEnv } from './env';
import logger from './logger';
import { connectPrisma, disconnectPrisma } from './prisma';

const env = validateEnv();

// Helps MongoDB Atlas (uses dns.resolve*). Does NOT fix `pg`/getaddrinfo —
// Neon DNS bypass for Postgres lives in prisma.ts (public resolver → IP).
dns.setServers(['8.8.8.8', '8.8.4.4']);

let isMongoConnected = false;
let isPrismaConnected = false;

/**
 * Connect to both MongoDB and Postgres (Prisma)
 */
export async function connectDatabase(): Promise<void> {
  await connectMongoDB();
  await connectPostgres();
}

/**
 * Connect to MongoDB (for metadata storage)
 */
async function connectMongoDB(): Promise<void> {
  if (isMongoConnected || mongoose.connection.readyState === 1) {
    isMongoConnected = true;
    logger.info('📦 MongoDB already connected');
    return;
  }

  if (mongoose.connection.readyState === 2) {
    logger.info('📦 MongoDB connection already in progress');
    return;
  }

  if (!env.MONGODB_URI) {
    logger.warn(
      '⚠️ MONGODB_URI not set - MongoDB features will be disabled'
    );
    return;
  }

  try {
    const connectionOptions = {
      dbName: env.MONGODB_DB,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10,
      minPoolSize: 2,
      // Keep sockets alive so idle CapRover containers don't drop Mongo mid-payment.
      heartbeatFrequencyMS: 10000,
      maxIdleTimeMS: 60000,
    };

    logger.info('🔌 Attempting to connect to MongoDB...');
    logger.info(`📊 Database: ${env.MONGODB_DB}`);

    const connection = await mongoose.connect(
      env.MONGODB_URI,
      connectionOptions
    );

    isMongoConnected = true;

    logger.info(
      `✅ MongoDB connected: ${connection.connection.host}`
    );

    logger.info(
      `📊 Connected to database: ${
        mongoose.connection.db?.databaseName || env.MONGODB_DB
      }`
    );

    // Avoid stacking listeners on reconnect attempts
    mongoose.connection.removeAllListeners('error');
    mongoose.connection.removeAllListeners('disconnected');
    mongoose.connection.removeAllListeners('reconnected');

    mongoose.connection.on('error', (error) => {
      logger.error('❌ MongoDB connection error', {
        error:
          error instanceof Error
            ? error.message
            : String(error),
        stack:
          error instanceof Error
            ? error.stack
            : undefined,
      });

      isMongoConnected = false;
    });

    mongoose.connection.on('disconnected', () => {
      logger.warn('⚠️ MongoDB disconnected');
      isMongoConnected = false;
      // Mongoose auto-reconnects; ensurePostgresReady-style soft retry if still down.
      void scheduleMongoReconnect();
    });

    mongoose.connection.on('reconnected', () => {
      logger.info('✅ MongoDB reconnected');
      isMongoConnected = true;
    });
  } catch (error: any) {
    logger.error('❌ Failed to connect to MongoDB', {
      error: error?.message || String(error),
      name: error?.name,
      code: error?.code,
      stack: error?.stack,
    });

    logger.warn('⚠️ MongoDB features will be disabled');

    isMongoConnected = false;
    void scheduleMongoReconnect();
  }
}

let mongoReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let mongoReconnectAttempt = 0;

function scheduleMongoReconnect() {
  if (!env.MONGODB_URI) return;
  if (mongoReconnectTimer) return;

  const delay = Math.min(30_000, 2000 * Math.max(1, mongoReconnectAttempt + 1));
  mongoReconnectAttempt += 1;
  mongoReconnectTimer = setTimeout(async () => {
    mongoReconnectTimer = null;
    // 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    const state = mongoose.connection.readyState;
    if (state === 1) {
      isMongoConnected = true;
      mongoReconnectAttempt = 0;
      return;
    }
    if (state === 2) {
      scheduleMongoReconnect();
      return;
    }
    try {
      logger.info('🔄 Retrying MongoDB connection…', {
        attempt: mongoReconnectAttempt,
        readyState: state,
      });
      if (state !== 0) {
        try {
          await mongoose.connection.close();
        } catch {
          /* ignore */
        }
      }
      isMongoConnected = false;
      await connectMongoDB();
      if (isMongoConnected) mongoReconnectAttempt = 0;
      else scheduleMongoReconnect();
    } catch {
      scheduleMongoReconnect();
    }
  }, delay);
}

/**
 * Connect to Postgres via Prisma (for financial data)
 */
async function connectPostgres(): Promise<void> {
  if (isPrismaConnected) {
    logger.info('📦 Prisma already connected');
    return;
  }

  try {
    await connectPrisma();
    isPrismaConnected = true;
  } catch (error: any) {
    logger.error('❌ Failed to connect to Postgres via Prisma', {
      error: error?.message || String(error),
      stack: error?.stack,
    });

    logger.warn('⚠️ Postgres features will be disabled');
    isPrismaConnected = false;
  }
}

/**
 * Disconnect from both databases
 */
export async function disconnectDatabase(): Promise<void> {
  await disconnectMongoDB();
  await disconnectPostgres();
}

/**
 * Disconnect from MongoDB
 */
async function disconnectMongoDB(): Promise<void> {
  if (!isMongoConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isMongoConnected = false;

    logger.info('📦 MongoDB disconnected');
  } catch (error: any) {
    logger.error('❌ Error disconnecting from MongoDB', {
      error: error?.message || String(error),
    });
  }
}

/**
 * Disconnect from Postgres
 */
async function disconnectPostgres(): Promise<void> {
  if (!isPrismaConnected) {
    return;
  }

  try {
    await disconnectPrisma();
    isPrismaConnected = false;
  } catch (error: any) {
    logger.error('❌ Error disconnecting from Postgres', {
      error: error?.message || String(error),
    });
  }
}

/**
 * Check if MongoDB is connected
 */
export function isDatabaseConnected(): boolean {
  return (
    isMongoConnected &&
    mongoose.connection.readyState === 1
  );
}

/**
 * Check if Postgres (Prisma) is connected
 */
export function isPostgresConnected(): boolean {
  return isPrismaConnected;
}

const POSTGRES_RETRY_MS = 2000;
const POSTGRES_MAX_ATTEMPTS = 5;

/**
 * Ensure Postgres is reachable before escrow writes.
 */
export async function ensurePostgresReady(): Promise<boolean> {
  if (isPrismaConnected) {
    return true;
  }

  for (
    let attempt = 1;
    attempt <= POSTGRES_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      await connectPrisma();

      isPrismaConnected = true;

      logger.info(
        '✅ Postgres ready for escrow operations',
        { attempt }
      );

      return true;
    } catch (error: any) {
      isPrismaConnected = false;

      logger.warn(
        'Postgres connection attempt failed',
        {
          attempt,
          maxAttempts: POSTGRES_MAX_ATTEMPTS,
          error: error?.message || String(error),
        }
      );

      if (attempt < POSTGRES_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, POSTGRES_RETRY_MS)
        );
      }
    }
  }

  return false;
}