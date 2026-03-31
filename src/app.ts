import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import rateLimit from 'express-rate-limit';
import { validateEnv, getCorsConfig } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import routes from './routes';
import logger from './config/logger';
import { EmailServiceClient } from './clients/EmailServiceClient';
import { InAppNotificationClient } from './clients/InAppNotificationClient';
import { Fast2SMSClient } from './clients/Fast2SMSClient';

const env = validateEnv();

// Initialize service clients
EmailServiceClient.initialize();
InAppNotificationClient.initialize();
Fast2SMSClient.initialize();

export function createApp(): Application {
  const app = express();

  // Security middleware
  app.use(helmet());
  app.use(cors(getCorsConfig(env)));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Compression
  app.use(compression());

  // Logging
  if (env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
  } else {
    app.use(morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim())
      }
    }));
  }

  // Sanitize
  app.use(mongoSanitize());

  // Rate limiting
  const limiter = rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX_REQUESTS,
    message: 'Too many requests from this IP, please try again later.',
  });
  // app.use('/api/', limiter);
  app.get('/', (req, res) => {
    res.status(200).json({
      service: 'extrahand-payment-service',
      status: 'ok',
      health: '/api/v1/health',
    });
  });
  // Routes
  app.use('/api/v1', routes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found`
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}



