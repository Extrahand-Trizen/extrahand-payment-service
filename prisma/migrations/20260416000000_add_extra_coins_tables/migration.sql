CREATE TABLE IF NOT EXISTS "ExtraCoinWallet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "balanceCoins" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "balanceRupees" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "lifetimeEarnedCoins" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "lifetimeUsedCoins" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExtraCoinWallet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtraCoinWallet_userId_key" ON "ExtraCoinWallet"("userId");
CREATE INDEX IF NOT EXISTS "ExtraCoinWallet_userId_idx" ON "ExtraCoinWallet"("userId");

CREATE TABLE IF NOT EXISTS "ExtraCoinTransaction" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "coins" DECIMAL(12,2) NOT NULL,
  "rupeeValue" DECIMAL(12,2) NOT NULL,
  "remainingCoins" DECIMAL(12,2),
  "remainingRupees" DECIMAL(12,2),
  "sourcePayoutId" TEXT,
  "taskId" TEXT,
  "expiresAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ExtraCoinTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ExtraCoinTransaction_transactionId_key" ON "ExtraCoinTransaction"("transactionId");
CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_userId_type_idx" ON "ExtraCoinTransaction"("userId", "type");
CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_userId_expiresAt_idx" ON "ExtraCoinTransaction"("userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_sourcePayoutId_idx" ON "ExtraCoinTransaction"("sourcePayoutId");
CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_taskId_idx" ON "ExtraCoinTransaction"("taskId");
CREATE INDEX IF NOT EXISTS "ExtraCoinTransaction_createdAt_idx" ON "ExtraCoinTransaction"("createdAt");
