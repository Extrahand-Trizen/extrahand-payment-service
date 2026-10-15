import express from 'express';
import paymentRoutes from './payment';
import escrowRoutes from './escrow';
import webhookRoutes from './webhooks';
import refundRoutes from './refunds';
import payoutRoutes from './payouts';
import earningsRoutes from './earnings';
import transactionRoutes from './transactions';
import feesRoutes from './fees';
import adminRoutes from './admin';
import cascadeDeleteRoutes from './cascadeDelete';
import bankAccountRoutes from './bankAccounts';
import dashboardRoutes from './dashboard';
import internalRoutes from './internal';
import { validateEnv } from '../config/env';
import { isDatabaseConnected, isPostgresConnected } from '../config/database';
import { pingPostgres } from '../config/prisma';
import logger from '../config/logger';

const router = express.Router();
const env = validateEnv();

/**
 * Liveness for CapRover / Docker — MUST stay 200 while the process is up.
 * Returning 503 on a Neon/Mongo blip caused Swarm to SIGTERM the container
 * mid-payment (Mongo/Prisma “disconnected” logs).
 *
 * Use GET /api/v1/health/ready for deeper dependency checks (ops / alerts).
 */
router.get('/health', async (req, res) => {
  let pg: Awaited<ReturnType<typeof pingPostgres>> = {
    ok: false,
    ms: 0,
    error: 'not_probed',
  };
  try {
    pg = await pingPostgres(2500);
  } catch (error) {
    pg = {
      ok: false,
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const mongoOk = isDatabaseConnected();
  const degraded = !pg.ok || !mongoOk;

  if (degraded) {
    logger.warn('Health liveness OK but dependencies degraded', {
      mongodb: mongoOk ? 'connected' : 'disconnected',
      postgres: pg.ok ? 'connected' : 'unreachable',
      postgresError: pg.error,
      postgresErrorCode: pg.code,
    });
  }

  res.status(200).json({
    success: true,
    service: 'extrahand-payment-service',
    status: degraded ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    razorpay: 'configured',
    mongodb: mongoOk ? 'connected' : 'disconnected',
    postgres: pg.ok ? 'connected' : 'unreachable',
    postgresPingMs: pg.ms,
    postgresError: pg.error,
    postgresErrorCode: pg.code,
    postgresBootFlag: isPostgresConnected() ? 'connected' : 'disconnected',
  });
});

/** Readiness — 503 when Postgres is down (do NOT point CapRover HTTP health here). */
router.get('/health/ready', async (req, res) => {
  const pg = await pingPostgres(5000);
  const ready = pg.ok;
  res.status(ready ? 200 : 503).json({
    success: ready,
    service: 'extrahand-payment-service',
    status: ready ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    mongodb: isDatabaseConnected() ? 'connected' : 'disconnected',
    postgres: pg.ok ? 'connected' : 'unreachable',
    postgresPingMs: pg.ms,
    postgresError: pg.error,
    postgresErrorCode: pg.code,
  });
});

// Payment routes
router.use('/payment', paymentRoutes);

// Escrow routes
router.use('/escrow', escrowRoutes);

// Webhook routes (no service auth required - Razorpay calls these directly)
router.use('/webhooks', webhookRoutes);

// Refund routes
router.use('/refunds', refundRoutes);

// Payout routes
router.use('/payouts', payoutRoutes);

// Bank account routes
router.use('/bank-accounts', bankAccountRoutes);

// Earnings routes
router.use('/earnings', earningsRoutes);

// Transaction history routes
router.use('/transactions', transactionRoutes);

// Fee structure routes (public - returns percentages only)
router.use('/fees', feesRoutes);

// Admin auth routes
router.use('/admin', adminRoutes);

// Cascade delete routes (service auth)
router.use('/cascade-delete', cascadeDeleteRoutes);

// Internal dashboard routes (service auth)
router.use('/dashboard', dashboardRoutes);

// Internal APIs for coupon-service (first-booking check)
router.use('/internal', internalRoutes);

export default router;

