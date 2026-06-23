-- Add per-mode category fee configs (Book Now vs Bidding)
CREATE TYPE "CategoryFeeMode" AS ENUM ('BOOK_NOW', 'BIDDING');

ALTER TABLE "CategoryFeeConfig" ADD COLUMN "mode" "CategoryFeeMode" NOT NULL DEFAULT 'BIDDING';

-- Drop legacy single-key uniqueness (constraint + index variants)
ALTER TABLE "CategoryFeeConfig" DROP CONSTRAINT IF EXISTS "CategoryFeeConfig_categoryKey_key";
DROP INDEX IF EXISTS "CategoryFeeConfig_categoryKey_key";

-- One config per (categoryKey, mode)
CREATE UNIQUE INDEX "CategoryFeeConfig_categoryKey_mode_key" ON "CategoryFeeConfig"("categoryKey", "mode");

CREATE INDEX "CategoryFeeConfig_mode_idx" ON "CategoryFeeConfig"("mode");
