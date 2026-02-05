import { Request, Response, NextFunction } from 'express';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

export function serviceAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const env = validateEnv();
    const serviceAuthToken = env.SERVICE_AUTH_TOKEN;

    if (!serviceAuthToken) {
      res.status(500).json({
        success: false,
        error: 'Service authentication not configured'
      });
      return;
    }

    const providedToken = req.headers['x-service-auth'] as string;

    if (!providedToken) {
      logger.warn('⚠️ Service auth failed: Missing X-Service-Auth header', {
        headers: Object.keys(req.headers),
        url: req.url,
        method: req.method,
      });
      res.status(401).json({
        success: false,
        error: 'Service authentication required',
        message: 'Missing X-Service-Auth header'
      });
      return;
    }

    if (providedToken !== serviceAuthToken) {
      logger.warn('⚠️ Service auth failed: Token mismatch', {
        providedTokenLength: providedToken.length,
        expectedTokenLength: serviceAuthToken.length,
        providedPrefix: providedToken.substring(0, 10),
        expectedPrefix: serviceAuthToken.substring(0, 10),
        url: req.url,
        method: req.method,
      });
      res.status(403).json({
        success: false,
        error: 'Invalid service authentication token'
      });
      return;
    }

    next();
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: 'Service authentication error',
      message: error.message
    });
  }
}



