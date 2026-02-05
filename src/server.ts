import { createApp } from './app';
import { validateEnv } from './config/env';
import logger from './config/logger';
import { connectDatabase, disconnectDatabase } from './config/database';
import { startAutoReleaseScheduler, stopAutoReleaseScheduler } from './services/autoReleaseScheduler';

const env = validateEnv();

async function startServer() {
  try {
    // Connect to MongoDB (graceful fallback if not available)
    await connectDatabase();

    // Create Express app
    const app = createApp();

    // Start server
    const port = env.PORT;
    app.listen(port, () => {
      logger.info(`🚀 Payment Service running on port ${port}`);
      logger.info(`📝 Environment: ${env.NODE_ENV}`);
      logger.info(`🔗 Health check: http://localhost:${port}/api/v1/health`);
      logger.info(`💳 Razorpay Key ID: ${env.RAZORPAY_KEY_ID.substring(0, 10)}...`);
    });

    // Start auto-release scheduler
    startAutoReleaseScheduler();

    // Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} signal received: starting graceful shutdown`);
      stopAutoReleaseScheduler();
      await disconnectDatabase();
      process.exit(0);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server:', error);
    await disconnectDatabase();
    process.exit(1);
  }
}

startServer();

