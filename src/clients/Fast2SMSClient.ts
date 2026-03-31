import axios, { AxiosError } from 'axios';
import logger from '../config/logger';
import { validateEnv } from '../config/env';

/**
 * Fast2SMSClient – HTTP client for Fast2SMS API.
 * Used for sending OTP SMS messages before task start.
 */
export class Fast2SMSClient {
  private static apiKey: string = '';
  private static baseURL: string = 'https://www.fast2sms.com/dev/bulkV2';
  private static isInitialized: boolean = false;

  static initialize(apiKey?: string): void {
    const env = validateEnv();
    this.apiKey = apiKey || env.FAST2SMS_API_KEY || process.env.FAST2SMS_API_KEY || '';
    this.isInitialized = true;
    logger.info('Fast2SMSClient initialized', {
      hasApiKey: !!this.apiKey,
    });
    if (!this.apiKey) {
      logger.warn('Fast2SMSClient: FAST2SMS_API_KEY not set – SMS requests will be skipped');
    }
  }

  private static ensureInitialized(): void {
    if (!this.isInitialized) {
      this.initialize();
    }
  }

  /**
   * Validate phone number format.
   * Accepts Indian phone numbers with or without country code.
   * @param phone - Phone number to validate
   * @returns Normalized 10-digit phone number or null if invalid
   */
  private static validateAndNormalizePhone(phone: string): string | null {
    if (!phone || typeof phone !== 'string') return null;

    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');

    // Handle different formats:
    // 10 digits: 9876543210
    // 11 digits with country code: 91 9876543210 -> remove leading 91
    // 12 digits with +: +91 9876543210 -> already removed by regex
    if (digits.length === 10 && digits[0] >= '6' && digits[0] <= '9') {
      return digits;
    }

    if (digits.length === 12 && digits.startsWith('91')) {
      const normalized = digits.slice(2);
      if (normalized[0] >= '6' && normalized[0] <= '9') {
        return normalized;
      }
    }

    if (digits.length === 11 && digits.startsWith('91')) {
      const normalized = digits.slice(2);
      if (normalized.length === 9) {
        return null; // Invalid: only 9 digits after removing 91
      }
      if (normalized[0] >= '6' && normalized[0] <= '9') {
        return normalized;
      }
    }

    logger.warn('Fast2SMSClient: Invalid phone number format', { phone, digits });
    return null;
  }

  /**
   * Send SMS via Fast2SMS API.
   * @param phone - Recipient phone number (10 digits or with +91)
   * @param message - SMS message content
   * @param options - Additional options like sender_id, route, etc.
   * @returns Promise<boolean> - true if sent successfully, false otherwise
   */
  static async sendSMS(
    phone: string,
    message: string,
    options?: {
      route?: 'q' | 'dlt' | 'v3'; // q = quick transactional (default), dlt = DLT template, v3 = promotional
      sender_id?: string;
    }
  ): Promise<boolean> {
    this.ensureInitialized();

    if (!this.apiKey) {
      logger.warn('Fast2SMSClient: Cannot send SMS - API key not configured');
      return false;
    }

    const normalizedPhone = this.validateAndNormalizePhone(phone);
    if (!normalizedPhone) {
      logger.warn('Fast2SMSClient: Invalid phone number', { phone });
      return false;
    }

    if (!message || message.trim().length === 0) {
      logger.warn('Fast2SMSClient: Empty message', { phone: normalizedPhone });
      return false;
    }

    try {
      logger.info('Fast2SMSClient: Sending SMS', {
        phone: normalizedPhone,
        messageLength: message.length,
        route: options?.route || 'q',
      });

      const payload = {
        route: options?.route || 'q',
        sender_id: options?.sender_id || 'FSTSMS',
        message: message.trim(),
        language: 'english',
        flash: 0,
        numbers: normalizedPhone,
      };

      const response = await axios.post(this.baseURL, payload, {
        headers: {
          authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.data?.return === true || response.data?.status_code === 200) {
        logger.info('Fast2SMSClient: SMS sent successfully', {
          phone: normalizedPhone,
          messageId: response.data?.request_id,
        });
        return true;
      } else {
        logger.error('Fast2SMSClient: SMS send failed - API returned error', {
          phone: normalizedPhone,
          response: response.data,
        });
        return false;
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('Fast2SMSClient: SMS send failed - network or API error', {
        phone: normalizedPhone,
        status: axiosError.response?.status,
        message: axiosError.message,
        responseData: axiosError.response?.data,
      });
      return false;
    }
  }

  /**
   * Send task start OTP via SMS.
   * @param phone - Recipient phone number
   * @param otp - 6-digit OTP code
   * @param taskTitle - Task title for context
   * @returns Promise<boolean> - true if sent successfully
   */
  static async sendTaskStartOTP(
    phone: string,
    otp: string,
    taskTitle: string
  ): Promise<boolean> {
    const message = `Task start OTP for "${taskTitle}": ${otp}. Valid for 10 minutes. - ExtraHand`;
    return this.sendSMS(phone, message, { route: 'q' });
  }
}
