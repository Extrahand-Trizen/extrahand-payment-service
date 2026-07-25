import axios, { AxiosError } from 'axios';
import logger from '../config/logger';
import { validateEnv } from '../config/env';
import { messagingServiceCircuit } from '../utils/CircuitBreaker';

export type WhatsAppTemplateKey =
  | 'wa_payment_released'
  | 'wa_earnings_credited'
  | 'wa_withdrawal_processed'
  | 'wa_withdrawal_failed'
  | 'wa_invoice_ready'
  | 'extrahand_invoice_ready'
  | 'extrahand_payment_released'
  | 'extrahand_earnings_credited'
  | 'extrahand_withdrawal_processed'
  | 'extrahand_withdrawal_failed';

export type WhatsAppNotifyPayload = {
  uid: string;
  templateKey: WhatsAppTemplateKey;
  category: 'payments' | 'taskUpdates';
  templateBody?: Record<string, string>;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

export class WhatsAppClient {
  private static baseURL = '';
  private static serviceAuthToken = '';
  private static isInitialized = false;
  private static serviceName = 'payment-service';

  static initialize(baseURL?: string, serviceName?: string): void {
    const env = validateEnv();
    this.baseURL = baseURL || env.MESSAGING_SERVICE_URL;
    this.serviceAuthToken = env.SERVICE_AUTH_TOKEN || '';
    this.serviceName = serviceName || 'payment-service';
    this.isInitialized = true;

    logger.info('WhatsAppClient initialized', {
      baseURL: this.baseURL,
      hasAuthToken: !!this.serviceAuthToken,
    });
  }

  private static ensureInitialized(): void {
    if (!this.isInitialized) {
      this.initialize();
    }
  }

  static async notify(payload: WhatsAppNotifyPayload): Promise<boolean> {
    this.ensureInitialized();

    if (!payload?.uid || !payload.templateKey) {
      return false;
    }

    const suppressLegacy = String(process.env.WHATSAPP_SUPPRESS_LEGACY || '')
      .trim()
      .toLowerCase();
    if (suppressLegacy === '1' || suppressLegacy === 'true' || suppressLegacy === 'yes') {
      logger.info('WhatsAppClient: skipped (dialog push bridge owns WhatsApp)', {
        templateKey: payload.templateKey,
        uid: payload.uid,
      });
      return true;
    }

    if (!this.serviceAuthToken) {
      logger.warn('WhatsAppClient: SERVICE_AUTH_TOKEN missing');
      return false;
    }

    if (!messagingServiceCircuit.isCallAllowed()) {
      logger.warn('WhatsAppClient: skipped (messaging-service circuit open)', {
        templateKey: payload.templateKey,
      });
      return false;
    }

    const url = `${this.baseURL.replace(/\/$/, '')}/api/v1/internal/whatsapp/send`;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Auth': this.serviceAuthToken,
          'X-Service-Name': this.serviceName,
        },
        timeout: 15000,
      });
      messagingServiceCircuit.recordSuccess();
      return Boolean(response.data?.sent) || response.status === 202 || Boolean(response.data?.accepted);
    } catch (error) {
      messagingServiceCircuit.recordFailure();
      const axiosError = error as AxiosError;
      logger.warn('WhatsAppClient: notify failed', {
        templateKey: payload.templateKey,
        status: axiosError.response?.status,
        message: axiosError.message,
      });
      return false;
    }
  }
}

export function fireWhatsAppNotify(payload: WhatsAppNotifyPayload): void {
  void WhatsAppClient.notify(payload).catch(() => undefined);
}
