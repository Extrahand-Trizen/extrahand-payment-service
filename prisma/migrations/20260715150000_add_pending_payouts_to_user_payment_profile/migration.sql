-- Denormalized pending payout totals on UserPaymentProfile (added to schema.prisma
-- in 7bdd3c1 without a migration). Required by Prisma upsert/RETURNING on every
-- UserPaymentProfile write (bank default, earnings cache, payout status sync).

ALTER TABLE "UserPaymentProfile"
  ADD COLUMN IF NOT EXISTS "pendingPayouts" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "pendingPayoutCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill from live Payout rows so earnings cache matches reality.
-- Matches PENDING_STATUSES in userPaymentProfileService.ts: pending | processing.
UPDATE "UserPaymentProfile" upp
SET
  "pendingPayouts" = COALESCE(agg.total, 0),
  "pendingPayoutCount" = COALESCE(agg.cnt, 0),
  "lastUpdatedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM (
  SELECT
    p."performerUid" AS "userId",
    SUM(p."netAmount") AS total,
    COUNT(*)::int AS cnt
  FROM "Payout" p
  WHERE LOWER(p."status") IN ('pending', 'processing')
  GROUP BY p."performerUid"
) agg
WHERE upp."userId" = agg."userId";
