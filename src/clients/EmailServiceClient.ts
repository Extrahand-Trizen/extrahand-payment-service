import axios, { AxiosError } from 'axios';
import logger from '../config/logger';
import { validateEnv } from '../config/env';

/**
 * EmailServiceClient
 * 
 * HTTP-based client for calling email-service APIs
 * Handles all payment-related email notifications
 */
export class EmailServiceClient {
  private static baseURL: string = 'http://localhost:4007';
  private static serviceAuthToken: string = '';
  private static isInitialized: boolean = false;
  private static serviceName: string = 'payment-service';

  /**
   * Initialize EmailServiceClient with required config
   */
  static initialize(baseURL?: string): void {
    const env = validateEnv();
    this.baseURL = baseURL || process.env.EMAIL_SERVICE_URL || 'http://localhost:4007';
    this.serviceAuthToken = env.SERVICE_AUTH_TOKEN || '';
    this.isInitialized = true;

    logger.info('EmailServiceClient initialized', {
      baseURL: this.baseURL,
      hasAuthToken: !!this.serviceAuthToken
    });
  }

  private static ensureInitialized(): void {
    if (!this.isInitialized) {
      this.initialize();
    }
  }

  /**
   * Validate email address before sending
   * Prevents sending to placeholder/reserved addresses (RFC 2606)
   */
  private static isValidEmail(email: string): boolean {
    if (!email || typeof email !== 'string') return false;
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) return false;
    
    const reservedDomains = ['example.com', 'example.net', 'example.org', 'test', 'localhost', 'invalid'];
    const domain = email.split('@')[1]?.toLowerCase();
    if (reservedDomains.some(reserved => domain === reserved || domain?.endsWith(`.${reserved}`))) {
      logger.warn('EmailServiceClient: Skipping email to reserved domain', { email, domain });
      return false;
    }
    
    return true;
  }

  private static async sendRequest(endpoint: string, data: any): Promise<boolean> {
    this.ensureInitialized();

    const email = data.to || data.email;
    if (!this.isValidEmail(email)) {
      logger.warn('EmailServiceClient: Skipping invalid email', { email, endpoint });
      return false;
    }

    try {
      logger.info('EmailServiceClient: Sending email request', { 
        endpoint, 
        to: email 
      });

      await axios.post(
        `${this.baseURL}/api/v1/email${endpoint}`,
        data,
        {
          headers: {
            'X-Service-Auth': this.serviceAuthToken,
            'X-Service-Name': this.serviceName,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      logger.info('EmailServiceClient: Email request successful', { endpoint });
      return true;
    } catch (error) {
      const axiosError = error as AxiosError;
      logger.error('EmailServiceClient: Failed to send email', {
        endpoint,
        status: axiosError.response?.status,
        message: axiosError.message
      });
      return false;
    }
  }

  // ============ Payment Emails ============

  /**
   * Send payment received confirmation
   */
  static async sendPaymentReceived(
    email: string,
    userName: string,
    paymentDetails: {
      amount: number;
      taskTitle?: string;
      transactionId?: string;
      paymentDate?: string;
      paymentMethod?: string;
      isEscrow?: boolean;
      receiptUrl?: string;
      taskUrl?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: email,
      subject: '💰 Payment Received - ExtraHand',
      template: 'payment_received',
      data: {
        userName,
        ...paymentDetails
      }
    });
  }

  /**
   * Send payment failed notification
   */
  static async sendPaymentFailed(
    email: string,
    userName: string,
    paymentDetails: {
      amount: number;
      taskTitle?: string;
      failureReason?: string;
      retryUrl?: string;
      taskUrl?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: email,
      subject: '⚠️ Payment Failed - Action Required - ExtraHand',
      template: 'payment_failed',
      data: {
        userName,
        ...paymentDetails
      }
    });
  }

  /**
   * Send escrow released notification (to tasker)
   */
  static async sendEscrowReleased(
    taskerEmail: string,
    taskerName: string,
    paymentDetails: {
      amount: number;
      taskTitle?: string;
      requesterName?: string;
      transactionId?: string;
      estimatedArrival?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: taskerEmail,
      subject: '💸 Payment Released to Your Account - ExtraHand',
      template: 'escrow_released',
      data: {
        taskerName,
        ...paymentDetails
      }
    });
  }

  /**
   * Send refund processed notification
   */
  static async sendRefundProcessed(
    email: string,
    userName: string,
    refundDetails: {
      amount: number;
      taskTitle?: string;
      refundReason?: string;
      transactionId?: string;
      originalTransactionId?: string;
      processingTime?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: email,
      subject: '↩️ Refund Processed - ExtraHand',
      template: 'refund_processed',
      data: {
        userName,
        ...refundDetails
      }
    });
  }

  /**
   * Send invoice
   */
  static async sendInvoice(
    email: string,
    userName: string,
    invoiceDetails: {
      invoiceNumber: string;
      invoiceDate?: string;
      invoiceType?: 'monthly' | 'transaction';
      lineItems?: Array<{ description: string; amount: number }>;
      description?: string;
      subtotal?: number;
      platformFee?: number;
      gst?: number;
      total: number;
      billingPeriod?: string;
      invoiceUrl?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: email,
      subject: `🧾 Invoice #${invoiceDetails.invoiceNumber} - ExtraHand`,
      template: 'invoice',
      data: {
        userName,
        ...invoiceDetails
      }
    });
  }

  /**
   * Send payment reminder
   */
  static async sendPaymentReminder(
    email: string,
    userName: string,
    paymentDetails: {
      amount: number;
      taskTitle?: string;
      dueDate?: string;
      taskerName?: string;
      paymentUrl?: string;
      taskUrl?: string;
    }
  ): Promise<boolean> {
    return this.sendRequest('/send', {
      to: email,
      subject: '⏰ Payment Reminder - ExtraHand',
      template: 'payment_reminder',
      data: {
        userName,
        ...paymentDetails
      }
    });
  }
}
