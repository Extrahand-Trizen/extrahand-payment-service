-- AlterTable
ALTER TABLE "CategoryFeeConfig" ADD COLUMN IF NOT EXISTS "sacCode" TEXT;
ALTER TABLE "CategoryFeeConfig" ADD COLUMN IF NOT EXISTS "sacHeading" TEXT;
