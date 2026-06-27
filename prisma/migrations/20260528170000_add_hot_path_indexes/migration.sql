-- P2 hot-path indexes (payment service)
-- Safe to re-run due to IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_escrow_poster_status_created
ON "Escrow" ("posterUid", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_escrow_performer_status_created
ON "Escrow" ("performerUid", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_payout_performer_created
ON "Payout" ("performerUid", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_payout_performer_status_created
ON "Payout" ("performerUid", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS idx_refund_status_created
ON "Refund" ("status", "createdAt" DESC);
