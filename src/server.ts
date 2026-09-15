import { createApp } from './app';
import { validateEnv } from './config/env';
import logger from './config/logger';
import {
  connectDatabase,
  disconnectDatabase,
  ensurePostgresReady,
  isPostgresConnected,
} from './config/database';
import { validatePaymentRewardsConfiguration } from './config/rewardsFlags';
// Payouts/escrow release/auto-release disabled - handled elsewhere
// import { startAutoReleaseScheduler, stopAutoReleaseScheduler } from './services/autoReleaseScheduler';

const env = validateEnv();

async function startServer() {
  logger.info('Starting payment service...');
  try {
    validatePaymentRewardsConfiguration();

    // Connect Postgres before accepting escrow/payment traffic (avoids orphan Razorpay orders)
    await connectDatabase().catch((err) => {
      logger.error('Database connection failed on startup:', err);
    });

    if (!isPostgresConnected()) {
      const ready = await ensurePostgresReady();
      if (!ready) {
        logger.error(
          'CRITICAL: Postgres (Neon) is not connected — Book Now / escrow rows will NOT be saved. Check POSTGRESDB_URI and run prisma migrate deploy.',
        );
      }
    }

    const app = createApp();
    logger.info('Express app created, binding to 0.0.0.0');

    const port = env.PORT;
    app.listen(port, '0.0.0.0', () => {
      logger.info(`🚀 Payment Service running on 0.0.0.0:${port}`);
      logger.info(`📝 Environment: ${env.NODE_ENV}`);
      logger.info(`🔗 Health: http://localhost:${port}/api/v1/health`);
      logger.info(
        '[REFERRAL_COINS] payment-service ready — issue-grants logs use tag [REFERRAL_COINS]'
      );
      logger.info(`💳 Razorpay Key ID: ${env.RAZORPAY_KEY_ID.substring(0, 10)}...`);
      if (env.PAYOUT_MANUAL_OPS_MODE) {
        logger.info('PAYOUT_MANUAL_OPS_MODE enabled — task payouts queued for operations (RazorpayX skipped)');
      }
      if (env.NODE_ENV === 'production') {
        logger.info(`⚠️ CapRover: set "Container HTTP Port" to ${port} to avoid 502`);
      }
    });

    // Graceful shutdown — only when CapRover/Docker actually stops the container
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} signal received: starting graceful shutdown`, {
        hint: 'If this happens during a payment, CapRover likely restarted the app (deploy, OOM, or old health 503).',
      });
      try {
        await disconnectDatabase();
      } catch (err) {
        logger.error('Error during graceful shutdown disconnect', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => {
      void gracefulShutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      void gracefulShutdown('SIGINT');
    });

  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

