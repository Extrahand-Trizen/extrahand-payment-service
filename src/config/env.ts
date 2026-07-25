import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).refine(n => n > 0 && n < 65536).default('4003'),
  
  // MongoDB
  MONGODB_URI: z.string().url().optional(),
  MONGODB_DB: z.string().default('extrahand'),

  /**
   * When true, connect Prisma to DEV_POSTGRESDB_URI.
   * When false, connect Prisma to PROD_POSTGRESDB_URI.
   * Only one Postgres client is created — never both.
   */
  USE_DEV_POSTGRES: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Postgres (Neon). Prefer DEV_/PROD_ + USE_DEV_POSTGRES.
  // POSTGRESDB_URI remains as a legacy fallback if the selected URI is unset.
  POSTGRESDB_URI: z.string().url('POSTGRESDB_URI must be a valid URL').optional(),
  DEV_POSTGRESDB_URI: z.string().url('DEV_POSTGRESDB_URI must be a valid URL').optional(),
  PROD_POSTGRESDB_URI: z.string().url('PROD_POSTGRESDB_URI must be a valid URL').optional(),
  
  // Razorpay
  RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required'),
  RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required'),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(), // Optional - only needed for webhook verification
  RAZORPAYX_KEY_ID: z.string().optional(),
  RAZORPAYX_KEY_SECRET: z.string().optional(),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
  RAZORPAY_ACCOUNT_NUMBER: z.string().optional(),
  
  // Service-to-Service
  SERVICE_AUTH_TOKEN: z.string().min(1, 'SERVICE_AUTH_TOKEN is required').optional(),

  TASK_SERVICE_URL: z.string().url(),
  USER_SERVICE_URL: z.string().url().default('http://localhost:4001'),
  MESSAGING_SERVICE_URL: z.string().url().default('http://localhost:4010'),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // Security
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('1000'),
  
  // CORS
  CORS_ORIGIN: z.string().optional(),

  // Fast2SMS
  FAST2SMS_API_KEY: z.string().optional(),

  /** Poster phones (10-digit or +91…) that skip Razorpay on escrow create when `metadata.posterPhone` matches. */
  PLAY_REVIEW_BYPASS_PHONES: z.string().optional(),
  /** Optional: poster Firebase UIDs that skip Razorpay on escrow create (Play review / demo). */
  PLAY_REVIEW_BYPASS_UIDS: z.string().optional(),

  /**
   * When true, task-completion payouts are recorded as processing in DB without calling RazorpayX.
   * Operations team completes transfers manually until live payout API is enabled.
   * Defaults to true in production when unset.
   */
  PAYOUT_MANUAL_OPS_MODE: z
    .string()
    .optional()
    .transform((v) => {
      if (v === 'false' || v === '0') return false;
      if (v === 'true' || v === '1') return true;
      return process.env.NODE_ENV === 'production';
    }),
});

export function validateEnv() {
  try {
    const env = envSchema.parse(process.env);

    const payoutKeyId = env.RAZORPAYX_KEY_ID || env.RAZORPAY_KEY_ID;
    const payoutKeySecret = env.RAZORPAYX_KEY_SECRET || env.RAZORPAY_KEY_SECRET;
    const payoutAccountNumber = env.RAZORPAYX_ACCOUNT_NUMBER || env.RAZORPAY_ACCOUNT_NUMBER;

    if (!payoutKeyId || !payoutKeySecret || !payoutAccountNumber) {
      console.error('❌ Environment validation failed: Razorpay payout credentials missing');
      console.error('  - Provide either RAZORPAYX_* values or RAZORPAY_* + RAZORPAY_ACCOUNT_NUMBER');
      process.exit(1);
    }

    const useDevPostgres = env.USE_DEV_POSTGRES === true;
    const selectedPostgresUri = useDevPostgres
      ? env.DEV_POSTGRESDB_URI || env.POSTGRESDB_URI
      : env.PROD_POSTGRESDB_URI || env.POSTGRESDB_URI;

    if (!selectedPostgresUri) {
      console.error('❌ Environment validation failed: Postgres URI missing');
      console.error(
        useDevPostgres
          ? '  - USE_DEV_POSTGRES=true requires DEV_POSTGRESDB_URI (or legacy POSTGRESDB_URI)'
          : '  - USE_DEV_POSTGRES=false requires PROD_POSTGRESDB_URI (or legacy POSTGRESDB_URI)'
      );
      process.exit(1);
    }

    return {
      ...env,
      USE_DEV_POSTGRES: useDevPostgres,
      /** Resolved active Postgres URI used by the single Prisma client */
      POSTGRESDB_URI: selectedPostgresUri,
      RAZORPAYX_KEY_ID: payoutKeyId,
      RAZORPAYX_KEY_SECRET: payoutKeySecret,
      RAZORPAYX_ACCOUNT_NUMBER: payoutAccountNumber,
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('❌ Environment validation failed:');
      error.errors.forEach(err => {
        console.error(`  - ${err.path.join('.')}: ${err.message}`);
      });
      process.exit(1);
    }
    throw error;
  }
}

export function getCorsConfig(env: z.infer<typeof envSchema>) {
  const allowedOrigins = [
    'https://extrahand.in',
    'https://www.extrahand.in',
    'https://extrahand-gst-admin-portal.apps.extrahand.in',
    'http://localhost:3000',
    'http://localhost:4000',
    'http://localhost:4001',
    'http://localhost:4002',
    'http://localhost:4003',
    'http://localhost:4004',
    'http://localhost:5000',
  ];
  
  if (env.CORS_ORIGIN) {
    const customOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
    allowedOrigins.push(...customOrigins);
  }
  
  return {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS policy`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Service-Auth',
      'X-User-Id',
      'X-Service-Name'
    ],
  };
}



