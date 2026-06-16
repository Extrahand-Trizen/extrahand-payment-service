import axios, { AxiosError } from 'axios';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

export class TaskServiceClient {
  private static baseURL(): string {
    return process.env.TASK_SERVICE_URL || 'http://localhost:4002';
  }

  private static headers() {
    const env = validateEnv();
    return {
      'x-service-auth': env.SERVICE_AUTH_TOKEN || '',
      'Content-Type': 'application/json',
      'x-service-name': 'payment-service',
    };
  }

  static async notifyBookingPaymentCaptured(params: {
    bookingOrderId: string;
    escrowId: string;
    razorpayOrderId: string;
    taskId: string;
  }): Promise<void> {
    try {
      await axios.post(
        `${this.baseURL()}/api/v1/bookings/internal/payment-captured`,
        params,
        { headers: this.headers(), timeout: 10000 }
      );
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.warn('[TaskServiceClient] notifyBookingPaymentCaptured failed', {
        bookingOrderId: params.bookingOrderId,
        taskId: params.taskId,
        status: axiosErr.response?.status,
        message: axiosErr.message,
      });
      throw err;
    }
  }
}
