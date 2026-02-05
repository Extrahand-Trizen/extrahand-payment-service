-- Remove redundant fields from payment service tables
-- This migration removes fields that can be derived or queried from related tables

-- ============================================================================
-- ESCROW TABLE
-- ============================================================================
-- Remove: autoReleaseEnabled, autoReleaseAfterDays, releaseTransactionId, 
--         refundTransactionId, refundReason, expiresAt
-- Keep: currency (for future multi-currency support)

ALTER TABLE "Escrow" 
  DROP COLUMN IF EXISTS "autoReleaseEnabled",
  DROP COLUMN IF EXISTS "autoReleaseAfterDays",
  DROP COLUMN IF EXISTS "releaseTransactionId",
  DROP COLUMN IF EXISTS "refundTransactionId",
  DROP COLUMN IF EXISTS "refundReason",
  DROP COLUMN IF EXISTS "expiresAt";

-- ============================================================================
-- REFUND TABLE
-- ============================================================================
-- Remove: amount, cancellationReason, hoursUntilDeadline, errorCode
-- Note: amount can be derived from escrow.amountInRupees
--       cancellationReason is duplicate of reason field
--       hoursUntilDeadline can be recalculated
--       errorCode can be stored in metadata if needed

ALTER TABLE "Refund"
  DROP COLUMN IF EXISTS "amount",
  DROP COLUMN IF EXISTS "cancellationReason",
  DROP COLUMN IF EXISTS "hoursUntilDeadline",
  DROP COLUMN IF EXISTS "errorCode";

-- ============================================================================
-- PAYOUT TABLE
-- ============================================================================
-- Remove: errorCode
-- Keep: description (for error messages)
-- Note: errorCode can be stored in metadata if needed

ALTER TABLE "Payout"
  DROP COLUMN IF EXISTS "errorCode";

-- ============================================================================
-- USERPAYMENTPROFILE TABLE
-- ============================================================================
-- Remove: autoPayoutEnabled, payoutThreshold, taxId
-- Keep: currency (for future multi-currency support)
-- Note: These fields were never used. Can be added back when auto-payout feature is implemented.

ALTER TABLE "UserPaymentProfile"
  DROP COLUMN IF EXISTS "autoPayoutEnabled",
  DROP COLUMN IF EXISTS "payoutThreshold",
  DROP COLUMN IF EXISTS "taxId";




