import axios, { AxiosError } from 'axios';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

export type CouponValidateResult = {
  success: boolean;
  valid?: boolean;
  couponId?: string;
  couponCode?: string;
  discountType?: string;
  discountAmount?: number;
  originalAmount?: number;
  amountAfterCoupon?: number;
  eligibleAmount?: number;
  eligibleServiceIds?: string[];
  code?: string;
  message?: string;
  error?: string;
};

export type CouponReserveResult = {
  success: boolean;
  redemption?: {
    id: string;
    couponId: string;
    couponCode: string;
    discountAmount: number;
    amountAfterCoupon: number;
    originalAmount: number;
    eligibleServiceIds?: string[];
    status: string;
    expiresAt?: string | null;
  };
  code?: string;
  message?: string;
  error?: string;
};

export class CouponClient {
  private static baseURL(): string {
    const env = validateEnv() as ReturnType<typeof validateEnv> & {
      COUPON_SERVICE_URL?: string;
    };
    return (
      process.env.COUPON_SERVICE_URL ||
      env.COUPON_SERVICE_URL ||
      'http://localhost:4015'
    );
  }

  private static headers(userId?: string) {
    const env = validateEnv();
    return {
      'Content-Type': 'application/json',
      'X-Service-Auth': env.SERVICE_AUTH_TOKEN || '',
      'X-Service-Name': 'payment-service',
      ...(userId ? { 'X-User-Id': userId } : {}),
    };
  }

  static async validate(params: {
    couponCode: string;
    userId: string;
    flowType: 'BOOK_NOW' | 'POST_COMPARE';
    amount: number;
    serviceIds?: string[];
    lineItems?: Array<{ serviceId: string; amount: number }>;
  }): Promise<CouponValidateResult> {
    try {
      const response = await axios.post(
        `${this.baseURL()}/api/v1/coupons/validate`,
        {
          couponCode: params.couponCode,
          flowType: params.flowType,
          amount: params.amount,
          serviceIds: params.serviceIds || [],
          lineItems: params.lineItems || [],
        },
        { headers: this.headers(params.userId), timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      const ax = err as AxiosError<any>;
      const data = ax.response?.data;
      logger.warn('[CouponClient] validate failed', {
        status: ax.response?.status,
        message: ax.message,
        code: data?.code,
      });
      return {
        success: false,
        valid: false,
        code: data?.code,
        message: data?.message || data?.error || ax.message,
        error: data?.message || data?.error || ax.message,
      };
    }
  }

  static async listEligible(params: {
    userId: string;
    flowType: 'BOOK_NOW' | 'POST_COMPARE';
    amount: number;
    serviceIds?: string[];
    lineItems?: Array<{ serviceId: string; amount: number }>;
  }): Promise<{
    success: boolean;
    coupons?: Array<{
      couponId: string;
      couponCode: string;
      discountType: string;
      discountValue: number;
      minOrderAmount: number;
      status: 'AVAILABLE' | 'ALREADY_USED' | 'NOT_AVAILABLE';
      message: string;
      discountAmount?: number;
      originalAmount?: number;
      amountAfterCoupon?: number;
      eligibleAmount?: number;
      eligibleServiceIds?: string[];
      code?: string;
    }>;
    message?: string;
    error?: string;
  }> {
    try {
      const response = await axios.post(
        `${this.baseURL()}/api/v1/coupons/eligible`,
        {
          flowType: params.flowType,
          amount: params.amount,
          serviceIds: params.serviceIds || [],
          lineItems: params.lineItems || [],
        },
        { headers: this.headers(params.userId), timeout: 15000 }
      );
      return response.data;
    } catch (err) {
      const ax = err as AxiosError<any>;
      const data = ax.response?.data;
      logger.warn('[CouponClient] listEligible failed', {
        status: ax.response?.status,
        message: ax.message,
      });
      return {
        success: false,
        coupons: [],
        message: data?.message || data?.error || ax.message,
        error: data?.message || data?.error || ax.message,
      };
    }
  }

  static async reserve(params: {
    couponCode: string;
    userId: string;
    flowType: 'BOOK_NOW' | 'POST_COMPARE';
    amount: number;
    serviceIds?: string[];
    lineItems?: Array<{ serviceId: string; amount: number }>;
    bookingOrderId?: string | null;
    taskId?: string | null;
  }): Promise<CouponReserveResult> {
    try {
      const response = await axios.post(
        `${this.baseURL()}/api/v1/coupons/redemptions/reserve`,
        {
          couponCode: params.couponCode,
          flowType: params.flowType,
          amount: params.amount,
          serviceIds: params.serviceIds || [],
          lineItems: params.lineItems || [],
          bookingOrderId: params.bookingOrderId || null,
          taskId: params.taskId || null,
        },
        { headers: this.headers(params.userId), timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      const ax = err as AxiosError<any>;
      const data = ax.response?.data;
      logger.warn('[CouponClient] reserve failed', {
        status: ax.response?.status,
        message: ax.message,
        code: data?.code,
      });
      return {
        success: false,
        code: data?.code,
        message: data?.message || data?.error || ax.message,
        error: data?.message || data?.error || ax.message,
      };
    }
  }

  static async confirm(redemptionId: string): Promise<void> {
    const id = String(redemptionId || '').trim();
    if (!id) return;
    try {
      await axios.post(
        `${this.baseURL()}/api/v1/coupons/redemptions/${encodeURIComponent(id)}/confirm`,
        {},
        { headers: this.headers(), timeout: 10000 }
      );
    } catch (err) {
      const ax = err as AxiosError;
      logger.error('[CouponClient] confirm failed', {
        redemptionId: id,
        status: ax.response?.status,
        message: ax.message,
      });
    }
  }

  static async cancel(redemptionId: string): Promise<void> {
    const id = String(redemptionId || '').trim();
    if (!id) return;
    try {
      await axios.post(
        `${this.baseURL()}/api/v1/coupons/redemptions/${encodeURIComponent(id)}/cancel`,
        {},
        { headers: this.headers(), timeout: 10000 }
      );
    } catch (err) {
      const ax = err as AxiosError;
      logger.warn('[CouponClient] cancel failed', {
        redemptionId: id,
        status: ax.response?.status,
        message: ax.message,
      });
    }
  }
}
