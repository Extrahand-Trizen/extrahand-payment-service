import axios, { AxiosError } from 'axios';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

export class UserServiceClient {
  private static baseURL(): string {
    return process.env.USER_SERVICE_URL || 'http://localhost:4001';
  }

  private static headers() {
    const env = validateEnv();
    return {
      'x-service-auth': env.SERVICE_AUTH_TOKEN || '',
      'Content-Type': 'application/json',
      'x-service-name': 'payment-service',
    };
  }

  static async getRewardContext(uid: string): Promise<{
    rating: number;
    ratingMultiplier: number;
    skillCertificateBonusPct: number;
  } | null> {
    try {
      const res = await axios.get(
        `${this.baseURL()}/api/v1/profiles/internal/${encodeURIComponent(uid)}/reward-context`,
        { headers: this.headers(), timeout: 5000 }
      );
      return res.data?.data ?? null;
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.warn('[UserServiceClient] getRewardContext failed', {
        uid,
        status: axiosErr.response?.status,
        message: axiosErr.message,
      });
      return null;
    }
  }

  static async getCoinUsageConfig(): Promise<{
    posterBooking: number;
    taskerPlatformFee: number;
  } | null> {
    try {
      const res = await axios.get(`${this.baseURL()}/api/v1/user/internal/rewards/coin-usage`, {
        headers: this.headers(),
        timeout: 5000,
      });
      const data = res.data?.data;
      const posterBooking = Number(data?.posterBookingCapPercent);
      const taskerPlatformFee = Number(data?.taskerPlatformFeeCapPercent);
      if (!Number.isFinite(posterBooking) || !Number.isFinite(taskerPlatformFee)) {
        return null;
      }
      return {
        posterBooking: Math.min(Math.max(posterBooking, 0), 1),
        taskerPlatformFee: Math.min(Math.max(taskerPlatformFee, 0), 1),
      };
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.warn('[UserServiceClient] getCoinUsageConfig failed', {
        status: axiosErr.response?.status,
        message: axiosErr.message,
      });
      return null;
    }
  }

  static async processRewardEvent(params: {
    eventType: string;
    payload: Record<string, unknown>;
    correlationId?: string;
  }): Promise<void> {
    try {
      await axios.post(
        `${this.baseURL()}/api/v1/user/internal/rewards/process-event`,
        params,
        { headers: this.headers(), timeout: 10_000 }
      );
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.warn('[UserServiceClient] processRewardEvent failed', {
        eventType: params.eventType,
        status: axiosErr.response?.status,
        message: axiosErr.message,
      });
    }
  }
}
