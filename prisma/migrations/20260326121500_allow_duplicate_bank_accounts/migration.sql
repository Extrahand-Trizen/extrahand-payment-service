-- Drop unique constraint to allow multiple bank account rows with same user/account/ifsc.
DROP INDEX IF EXISTS "BankAccount_userId_accountNumber_ifscCode_key";

-- Keep a non-unique index for lookup performance.
CREATE INDEX IF NOT EXISTS "BankAccount_userId_accountNumber_ifscCode_idx"
ON "BankAccount"("userId", "accountNumber", "ifscCode");
