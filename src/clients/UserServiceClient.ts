import axios, { AxiosError, AxiosResponse } from 'axios';
import { validateEnv } from '../config/env';
import logger from '../config/logger';

export class UserServiceClient {
  private static baseURL(): string {
    return validateEnv().USER_SERVICE_URL.replace(/\/+$/, '');
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

  static async getPaymentTesterStatus(uid: string): Promise<boolean> {
    if (!uid?.trim()) {
      throw new Error('User ID is required to verify payment testing status');
    }

    let response: AxiosResponse<{
      success?: boolean;
      profile?: { isPaymentTester?: boolean };
    }>;
    try {
      response = await axios.get(
        `${this.baseURL()}/api/v1/profiles/internal/${encodeURIComponent(uid)}`,
        { headers: this.headers(), timeout: 5000 },
      );
    } catch (err) {
      const axiosErr = err as AxiosError;
      logger.error('[UserServiceClient] payment tester lookup failed', {
        uid,
        userServiceUrl: this.baseURL(),
        status: axiosErr.response?.status,
        code: axiosErr.code,
        message: axiosErr.message,
      });
      const status = axiosErr.response?.status;
      const reason = status
        ? `User service returned HTTP ${status}`
        : `Could not connect to user service (${axiosErr.code || axiosErr.message})`;
      throw new Error(`Unable to verify payment testing status: ${reason}. Payment was not started.`);
    }

    if (response.data?.success !== true || !response.data?.profile) {
      throw new Error('User service returned an invalid payment testing status. Payment was not started.');
    }
    return response.data.profile.isPaymentTester === true;
  }

  static async isPaymentTester(uid: string): Promise<boolean> {
    if (!uid?.trim()) return false;
    try {
      return await this.getPaymentTesterStatus(uid);
    } catch (err) {
      logger.warn('[UserServiceClient] payment tester lookup failed; treating as non-tester for payout lookup', {
        uid,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
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
