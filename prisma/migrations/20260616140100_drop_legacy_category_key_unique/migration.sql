-- Remove legacy single-column unique index left from pre-mode schema
ALTER TABLE "CategoryFeeConfig" DROP CONSTRAINT IF EXISTS "CategoryFeeConfig_categoryKey_key";

DROP INDEX IF EXISTS "CategoryFeeConfig_categoryKey_key";
