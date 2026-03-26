import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).refine(n => n > 0 && n < 65536).default('4003'),
  
  // MongoDB
  MONGODB_URI: z.string().url().optional(),
  MONGODB_DB: z.string().default('extrahand'),
  
  // Postgres (Neon DB)
  POSTGRESDB_URI: z.string().url('POSTGRESDB_URI must be a valid URL'),
  
  // Razorpay
  RAZORPAY_KEY_ID: z.string().min(1, 'RAZORPAY_KEY_ID is required'),
  RAZORPAY_KEY_SECRET: z.string().min(1, 'RAZORPAY_KEY_SECRET is required'),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(), // Optional - only needed for webhook verification
  RAZORPAYX_KEY_ID: z.string().min(1, 'RAZORPAYX_KEY_ID is required for payouts'),
  RAZORPAYX_KEY_SECRET: z.string().min(1, 'RAZORPAYX_KEY_SECRET is required for payouts'),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().min(1, 'RAZORPAYX_ACCOUNT_NUMBER is required for payouts'),
  
  // Service-to-Service
  SERVICE_AUTH_TOKEN: z.string().min(1, 'SERVICE_AUTH_TOKEN is required').optional(),

  TASK_SERVICE_URL: z.string().url(),
  
  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  
  // Security
  RATE_LIMIT_WINDOW_MS: z.string().transform(Number).default('900000'),
  RATE_LIMIT_MAX_REQUESTS: z.string().transform(Number).default('1000'),
  
  // CORS
  CORS_ORIGIN: z.string().optional(),
});

export function validateEnv() {
  try {
    return envSchema.parse(process.env);
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



