-- Book Now: optional performer until ops assigns helper; link escrow to booking order
ALTER TABLE "Escrow" ALTER COLUMN "performerUid" DROP NOT NULL;

ALTER TABLE "Escrow" ADD COLUMN IF NOT EXISTS "bookingOrderId" TEXT;

CREATE INDEX IF NOT EXISTS "Escrow_bookingOrderId_idx" ON "Escrow"("bookingOrderId");
