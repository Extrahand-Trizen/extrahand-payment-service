CREATE TABLE IF NOT EXISTS "PaymentOrderIdempotency" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "razorpayOrderId" TEXT NOT NULL,
  "orderPayload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentOrderIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentOrderIdempotency_idempotencyKey_key"
  ON "PaymentOrderIdempotency"("idempotencyKey");
