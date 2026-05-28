import { UserServiceClient } from '../../clients/UserServiceClient';
import { paymentRewardsFlags } from '../../config/rewardsFlags';
import logger from '../../config/logger';

const DEFAULT_POSTER_BOOKING_CAP = 0.1;
const DEFAULT_TASKER_PLATFORM_FEE_CAP = 0.15;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached: { posterBooking: number; taskerPlatformFee: number } | null = null;
let cacheAt = 0;

/**
 * Poster/tasker coin redemption caps — loaded from user-service RewardProgram (Mongo).
 */
export class CoinUsageConfigProvider {
  static async getCapPercents(): Promise<{ posterBooking: number; taskerPlatformFee: number }> {
    const now = Date.now();
    if (cached && now - cacheAt < CACHE_TTL_MS) {
      return cached;
    }

    const defaults = {
      posterBooking: DEFAULT_POSTER_BOOKING_CAP,
      taskerPlatformFee: DEFAULT_TASKER_PLATFORM_FEE_CAP,
    };

    if (paymentRewardsFlags.USE_USER_SERVICE_REWARD_CONTEXT) {
      const remote = await UserServiceClient.getCoinUsageConfig();
      if (remote) {
        cached = remote;
        cacheAt = now;
        return remote;
      }
      logger.warn('[CoinUsageConfigProvider] user-service coin-usage unavailable, using defaults');
    }

    cached = defaults;
    cacheAt = now;
    return defaults;
  }

  static invalidateCache(): void {
    cached = null;
    cacheAt = 0;
  }
}
