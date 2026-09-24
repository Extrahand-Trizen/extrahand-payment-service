CREATE TABLE "PaymentOrderEnvironment" (
  "id" TEXT NOT NULL,
  "razorpayOrderId" TEXT NOT NULL,
  "paymentEnvironment" TEXT NOT NULL DEFAULT 'live',
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentOrderEnvironment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaymentOrderEnvironment_razorpayOrderId_key"
  ON "PaymentOrderEnvironment"("razorpayOrderId");
CREATE INDEX "PaymentOrderEnvironment_userId_idx"
  ON "PaymentOrderEnvironment"("userId");
CREATE INDEX "PaymentOrderEnvironment_paymentEnvironment_idx"
  ON "PaymentOrderEnvironment"("paymentEnvironment");