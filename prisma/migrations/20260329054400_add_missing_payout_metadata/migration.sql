-- Add missing metadata column to Payout table
ALTER TABLE "Payout" ADD COLUMN "metadata" JSONB;

-- The refunds table should already have metadata, but let's ensure it exists
ALTER TABLE "Refund" ADD COLUMN "metadata" JSONB;

-- Create indices for better query performance on new JSON columns
CREATE INDEX IF NOT EXISTS "idx_payout_metadata" ON "Payout" USING GIN ("metadata");
CREATE INDEX IF NOT EXISTS "idx_refund_metadata" ON "Refund" USING GIN ("metadata");
