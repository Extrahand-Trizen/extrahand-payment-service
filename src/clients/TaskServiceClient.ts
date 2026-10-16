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
  }): Promise<{ success: boolean; tasks?: any[]; order?: any; error?: string }> {
    try {
      const response = await axios.post(
        `${this.baseURL()}/api/v1/bookings/internal/payment-captured`,
        params,
        { headers: this.headers(), timeout: 4000 }
      );

      if (response.data?.success) {
        return {
          success: true,
          tasks: response.data?.data?.tasks,
          order: response.data?.data?.order,
        };
      }

      return {
        success: false,
        error: response.data?.error || 'Failed to notify task service payment captured',
      };
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

  /** Authoritative base amount for one recurring visit; task-service rejects foreign/paid visits. */
  static async quoteRecurringVisitPayment(params: {
    parentTaskId: string;
    visitId: string;
    posterUid: string;
    applicationId?: string;
  }): Promise<
    | {
        ok: true;
        quote: {
          visitId: string;
          amount: number;
          assignment: boolean;
          category?: string;
          categorySlug?: string;
        };
      }
    | { ok: false; status: number; error: string }
  > {
    try {
      const response = await axios.post(
        `${this.baseURL()}/api/v1/recurring/internal/visit-payment-quote`,
        params,
        { headers: this.headers(), timeout: 10000 },
      );
      const data = response.data?.data;
      if (!response.data?.success || !data || !(Number(data.amount) > 0)) {
        return { ok: false, status: 502, error: 'Could not verify the visit amount' };
      }
      return {
        ok: true,
        quote: {
          visitId: String(data.visitId || params.visitId),
          amount: Number(data.amount),
          assignment: data.assignment === true,
          ...(typeof data.category === 'string' ? { category: data.category } : {}),
          ...(typeof data.categorySlug === 'string' ? { categorySlug: data.categorySlug } : {}),
        },
      };
    } catch (err) {
      const axiosErr = err as AxiosError<{ error?: string; message?: string }>;
      const status = axiosErr.response?.status ?? 502;
      logger.warn('[TaskServiceClient] quoteRecurringVisitPayment failed', {
        parentTaskId: params.parentTaskId,
        visitId: params.visitId,
        status,
        message: axiosErr.message,
      });
      const body = axiosErr.response?.data;
      return {
        ok: false,
        status,
        error:
          (status < 500 && (body?.error || body?.message)) ||
          'Could not verify the visit amount. Please try again.',
      };
    }
  }

  static async notifyRecurringVisitPaymentCaptured(params: {
    parentTaskId: string;
    visitId: string;
    escrowId: string;
  }): Promise<void> {
    // The task-service endpoint is idempotent (already-confirmed visits are a no-op), so
    // transient failures are retried instead of leaving the visit payment_pending.
    const backoffMs = [0, 1000, 4000];
    for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
      if (backoffMs[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
      }
      try {
        await axios.post(
          `${this.baseURL()}/api/v1/recurring/internal/visit-payment-captured`,
          {
            parentTaskId: params.parentTaskId,
            visitId: params.visitId,
            escrowId: params.escrowId,
          },
          { headers: this.headers(), timeout: 15000 },
        );
        return;
      } catch (err) {
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        const retryable = !status || status >= 500 || status === 409 || status === 429;
        logger.warn('[TaskServiceClient] notifyRecurringVisitPaymentCaptured failed', {
          parentTaskId: params.parentTaskId,
          visitId: params.visitId,
          attempt: attempt + 1,
          status,
          message: axiosErr.message,
        });
        if (!retryable || attempt === backoffMs.length - 1) throw err;
      }
    }
  }

  /**
   * One delivery attempt; the caller's JobQueue row holds retries. Task-service only changes the
   * visit when this escrow is the one bound to it, so repeated deliveries are no-ops.
   */
  static async notifyRecurringVisitPaymentRefunded(params: {
    parentTaskId: string;
    visitId: string;
    escrowId: string;
    razorpayPaymentId?: string;
    eventId: string;
  }): Promise<void> {
    await axios.post(
      `${this.baseURL()}/api/v1/recurring/internal/visit-payment-refunded`,
      { ...params, refundStatus: 'refunded' },
      { headers: this.headers(), timeout: 10000 },
    );
  }
}
