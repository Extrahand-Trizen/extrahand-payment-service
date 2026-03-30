-- Add taskAmount field to Escrow table to store base task amount separately from platform fee and GST
-- This is used for accurate refund calculation - only task amount is refunded, not platform fees or GST
ALTER TABLE "Escrow" ADD COLUMN "taskAmount" DECIMAL(12, 2);

-- Create index for taskAmount for faster lookups
CREATE INDEX IF NOT EXISTS "idx_escrow_taskAmount" ON "Escrow"("taskAmount");
