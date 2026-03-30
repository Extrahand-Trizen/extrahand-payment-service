-- Ensure Ledger.razorpayPaymentId exists in environments where schema drift happened
ALTER TABLE "Ledger"
ADD COLUMN IF NOT EXISTS "razorpayPaymentId" TEXT;

-- Keep schema behavior aligned with Prisma model @@unique([razorpayPaymentId, type])
CREATE UNIQUE INDEX IF NOT EXISTS "Ledger_razorpayPaymentId_type_key"
ON "Ledger"("razorpayPaymentId", "type");

-- Supporting index for lookup performance
CREATE INDEX IF NOT EXISTS "Ledger_razorpayPaymentId_idx"
ON "Ledger"("razorpayPaymentId");
