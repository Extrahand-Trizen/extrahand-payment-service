ALTER TABLE "PaymentOrderIdempotency"
ADD COLUMN "paymentEnvironment" TEXT NOT NULL DEFAULT 'live';