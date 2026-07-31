-- Book Now partner payout delayed visibility (aligns with customer raise-issue window).
ALTER TABLE "Payout"
  ADD COLUMN IF NOT EXISTS "partnerVisibleAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Payout_performerUid_partnerVisibleAt_idx"
  ON "Payout"("performerUid", "partnerVisibleAt");
