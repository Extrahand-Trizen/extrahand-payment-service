-- Role-based ExtraCoin wallets (poster | tasker)
ALTER TABLE "public"."ExtraCoinWallet"
  ADD COLUMN IF NOT EXISTS "walletRole" TEXT;

ALTER TABLE "public"."ExtraCoinTransaction"
  ADD COLUMN IF NOT EXISTS "walletRole" TEXT;

UPDATE "public"."ExtraCoinWallet"
SET "walletRole" = 'tasker'
WHERE "walletRole" IS NULL OR "walletRole" = '';

UPDATE "public"."ExtraCoinTransaction"
SET "walletRole" = 'tasker'
WHERE "walletRole" IS NULL OR "walletRole" = '';

ALTER TABLE "public"."ExtraCoinWallet"
  ALTER COLUMN "walletRole" SET DEFAULT 'tasker';

ALTER TABLE "public"."ExtraCoinWallet"
  ALTER COLUMN "walletRole" SET NOT NULL;

ALTER TABLE "public"."ExtraCoinTransaction"
  ALTER COLUMN "walletRole" SET DEFAULT 'tasker';

ALTER TABLE "public"."ExtraCoinTransaction"
  ALTER COLUMN "walletRole" SET NOT NULL;

DROP INDEX IF EXISTS "ExtraCoinWallet_userId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "ExtraCoinWallet_userId_walletRole_key"
  ON "public"."ExtraCoinWallet"("userId", "walletRole");

CREATE INDEX IF NOT EXISTS "ExtraCoinWallet_userId_walletRole_idx"
  ON "public"."ExtraCoinWallet"("userId", "walletRole");

CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_userId_walletRole_type_idx"
  ON "public"."ExtraCoinTransaction"("userId", "walletRole", "type");

CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_userId_walletRole_expiresAt_idx"
  ON "public"."ExtraCoinTransaction"("userId", "walletRole", "expiresAt");
