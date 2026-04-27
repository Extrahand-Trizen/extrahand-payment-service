CREATE TABLE IF NOT EXISTS "Transaction" (
  "id" TEXT NOT NULL,
  "transactionId" TEXT NOT NULL,
  "escrowId" TEXT,
  "razorpayOrderId" TEXT NOT NULL,
  "razorpayPaymentId" TEXT,
  "amount" DECIMAL(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'INR',
  "status" TEXT NOT NULL,
  "paymentMethod" TEXT,
  "authorizedAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "metadata" JSONB,
  "ledgerEntryId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_transactionId_key" ON "Transaction"("transactionId");
CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_razorpayPaymentId_key" ON "Transaction"("razorpayPaymentId");
CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_ledgerEntryId_key" ON "Transaction"("ledgerEntryId");
CREATE INDEX IF NOT EXISTS "Transaction_escrowId_idx" ON "Transaction"("escrowId");
CREATE INDEX IF NOT EXISTS "Transaction_razorpayOrderId_idx" ON "Transaction"("razorpayOrderId");
CREATE INDEX IF NOT EXISTS "Transaction_status_idx" ON "Transaction"("status");
CREATE INDEX IF NOT EXISTS "Transaction_createdAt_idx" ON "Transaction"("createdAt");

ALTER TABLE "Ledger" ADD COLUMN IF NOT EXISTS "payoutId" TEXT;
ALTER TABLE "Ledger" ADD COLUMN IF NOT EXISTS "refundId" TEXT;
ALTER TABLE "Ledger" ADD COLUMN IF NOT EXISTS "paymentTransactionId" TEXT;

CREATE INDEX IF NOT EXISTS "Ledger_payoutId_idx" ON "Ledger"("payoutId");
CREATE INDEX IF NOT EXISTS "Ledger_refundId_idx" ON "Ledger"("refundId");
CREATE INDEX IF NOT EXISTS "Ledger_paymentTransactionId_idx" ON "Ledger"("paymentTransactionId");
