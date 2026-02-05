-- Migration: Add Optimized Tables
-- This migration adds new optimized tables and removes unused payment_transactions table

-- ============================================================================
-- Step 1: Drop unused payment_transactions table (if exists)
-- This table was from old MongoDB migration and is not used in current schema
-- Note: If there's data, it will be lost. Check data first if needed.
-- ============================================================================

-- Check if table exists and drop it (safe - not used in code)
-- If you need to preserve data, migrate it first before running this migration
DROP TABLE IF EXISTS "payment_transactions" CASCADE;

-- ============================================================================
-- Step 2: Create BankAccount table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "BankAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verificationRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for preventing duplicate accounts
CREATE UNIQUE INDEX IF NOT EXISTS "BankAccount_userId_accountNumber_ifscCode_key" ON "BankAccount"("userId", "accountNumber", "ifscCode");

-- Create indexes
CREATE INDEX IF NOT EXISTS "BankAccount_userId_idx" ON "BankAccount"("userId");
CREATE INDEX IF NOT EXISTS "BankAccount_userId_isDefault_idx" ON "BankAccount"("userId", "isDefault");

-- ============================================================================
-- Step 3: Create UserPaymentProfile table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "UserPaymentProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totalEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fromPayouts" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "fromCompensation" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "payoutCount" INTEGER NOT NULL DEFAULT 0,
    "compensationCount" INTEGER NOT NULL DEFAULT 0,
    "totalPayments" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "totalRefunds" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refundCount" INTEGER NOT NULL DEFAULT 0,
    "totalFees" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "averagePayout" DECIMAL(12,2),
    "largestPayout" DECIMAL(12,2),
    "smallestPayout" DECIMAL(12,2),
    "lastPayoutDate" TIMESTAMP(3),
    "lastPaymentDate" TIMESTAMP(3),
    "defaultBankAccountId" TEXT,
    "autoPayoutEnabled" BOOLEAN NOT NULL DEFAULT false,
    "payoutThreshold" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "taxId" TEXT,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPaymentProfile_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for userId
CREATE UNIQUE INDEX IF NOT EXISTS "UserPaymentProfile_userId_key" ON "UserPaymentProfile"("userId");

-- Create index
CREATE INDEX IF NOT EXISTS "UserPaymentProfile_userId_idx" ON "UserPaymentProfile"("userId");

-- ============================================================================
-- Step 4: Enhance AuditLog table with webhook fields
-- ============================================================================

-- Add webhook-specific fields to AuditLog (if not already present)
ALTER TABLE "AuditLog" 
ADD COLUMN IF NOT EXISTS "eventId" TEXT,
ADD COLUMN IF NOT EXISTS "eventType" TEXT,
ADD COLUMN IF NOT EXISTS "source" TEXT,
ADD COLUMN IF NOT EXISTS "payload" JSONB,
ADD COLUMN IF NOT EXISTS "processed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- Update entityType to allow 'webhook'
-- Note: This is a comment - actual enum/check constraint would need to be handled in application code

-- Create unique constraint for eventId (for webhooks)
CREATE UNIQUE INDEX IF NOT EXISTS "AuditLog_eventId_key" ON "AuditLog"("eventId") WHERE "eventId" IS NOT NULL;

-- Create indexes for webhook queries
CREATE INDEX IF NOT EXISTS "AuditLog_eventType_processed_idx" ON "AuditLog"("eventType", "processed") WHERE "eventType" IS NOT NULL;

-- ============================================================================
-- Step 5: Create JobQueue table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "JobQueue" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "status" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "JobQueue_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for jobId
CREATE UNIQUE INDEX IF NOT EXISTS "JobQueue_jobId_key" ON "JobQueue"("jobId");

-- Create indexes
CREATE INDEX IF NOT EXISTS "JobQueue_status_nextRetryAt_idx" ON "JobQueue"("status", "nextRetryAt");
CREATE INDEX IF NOT EXISTS "JobQueue_jobType_status_idx" ON "JobQueue"("jobType", "status");
CREATE INDEX IF NOT EXISTS "JobQueue_entityType_entityId_idx" ON "JobQueue"("entityType", "entityId") WHERE "entityType" IS NOT NULL AND "entityId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "JobQueue_priority_status_idx" ON "JobQueue"("priority", "status");

-- ============================================================================
-- Step 6: Create SystemConfig table
-- ============================================================================

CREATE TABLE IF NOT EXISTS "SystemConfig" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "configValue" JSONB NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("id")
);

-- Create unique constraint for configKey
CREATE UNIQUE INDEX IF NOT EXISTS "SystemConfig_configKey_key" ON "SystemConfig"("configKey");

-- Create indexes
CREATE INDEX IF NOT EXISTS "SystemConfig_configKey_idx" ON "SystemConfig"("configKey");
CREATE INDEX IF NOT EXISTS "SystemConfig_category_idx" ON "SystemConfig"("category") WHERE "category" IS NOT NULL;

-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE "BankAccount" IS 'Personal bank accounts for payouts (NOT business accounts - those are in User Service)';
COMMENT ON TABLE "UserPaymentProfile" IS 'Combined transaction summary + payment preferences (cached for fast access)';
COMMENT ON TABLE "JobQueue" IS 'Generic queue for all async jobs (payment retries, reconciliation, etc.)';
COMMENT ON TABLE "SystemConfig" IS 'System-wide configuration (fee structures, settings, feature flags)';

