-- Performance indexes for escrow lookups and payout queries
CREATE INDEX IF NOT EXISTS "Escrow_razorpayPaymentId_idx" ON "Escrow"("razorpayPaymentId");
CREATE INDEX IF NOT EXISTS "Escrow_paymentStatus_createdAt_idx" ON "Escrow"("paymentStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "Escrow_status_heldAt_idx" ON "Escrow"("status", "heldAt");
CREATE INDEX IF NOT EXISTS "Escrow_paymentStatus_updatedAt_idx" ON "Escrow"("paymentStatus", "updatedAt");
CREATE INDEX IF NOT EXISTS "Payout_performerUid_type_status_idx" ON "Payout"("performerUid", "type", "status");
CREATE INDEX IF NOT EXISTS "Payout_escrowId_createdAt_idx" ON "Payout"("escrowId", "createdAt" DESC);
