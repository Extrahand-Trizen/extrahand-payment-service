-- NON-DESTRUCTIVE: adds nullable columns + index only (no DROP DELETE TRUNCATE).
-- Existing masked rows stay as-is. Full encryption applies on new bank saves only.
ALTER TABLE "BankAccount"
ADD COLUMN IF NOT EXISTS "accountNumberEncrypted" TEXT,
ADD COLUMN IF NOT EXISTS "accountHolderNameEncrypted" TEXT,
ADD COLUMN IF NOT EXISTS "accountNumberLast4" TEXT,
ADD COLUMN IF NOT EXISTS "encryptionKeyVersion" TEXT DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS "BankAccount_userId_accountNumberLast4_idx"
ON "BankAccount"("userId", "accountNumberLast4");
