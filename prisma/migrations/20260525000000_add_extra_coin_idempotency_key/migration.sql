-- AlterTable
ALTER TABLE "ExtraCoinTransaction" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ExtraCoinTransaction_idempotencyKey_key" ON "ExtraCoinTransaction"("idempotencyKey");
