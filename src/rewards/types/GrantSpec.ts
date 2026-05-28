/**
 * Grant execution contract (payment-service-clean).
 * Keep metadata small — no full program snapshots.
 */
export type GrantMetadataSource =
  | 'referral_signup'
  | 'referral_welcome'
  | 'referral_task_bonus'
  | 'task_completion'
  | 'migration_credit'
  | string;

export interface GrantMetadata {
  source: GrantMetadataSource;
  enrollmentId?: string;
  referralCode?: string;
  taskId?: string;
  programVersion?: number;
  description?: string;
  refereeUid?: string;
  referrerUid?: string;
  taskAmount?: string;
  platformFee?: string;
  baseRewardPercent?: string;
  rating?: string;
  ratingMultiplier?: string;
  onboardingBonusPct?: string;
  skillCertificateBonusPct?: string;
  totalBonusMultiplier?: string;
  coinValueInr?: string;
  formula?: string;
}

export interface GrantSpec {
  idempotencyKey: string;
  recipientUid: string;
  walletRole?: 'poster' | 'tasker';
  coins: string;
  rupeeValue: string;
  expiresAt?: string;
  taskId?: string;
  sourcePayoutId?: string;
  metadata: GrantMetadata;
}

export interface IssueGrantResult {
  success: boolean;
  idempotencyKey: string;
  transactionId?: string;
  coins: string;
  rupeeValue: string;
  duplicate?: boolean;
  error?: string;
}

export interface IssueGrantsResult {
  success: boolean;
  partial: boolean;
  results: IssueGrantResult[];
  error?: string;
}
