-- Add JSONB fields to Escrow table for flexible data storage (migrated from MongoDB)
-- This migration adds fields to store sanitized Razorpay data and metadata

-- Add razorpayOrderData JSONB column
ALTER TABLE "Escrow" 
ADD COLUMN IF NOT EXISTS "razorpayOrderData" JSONB;

-- Add razorpayPaymentData JSONB column
ALTER TABLE "Escrow" 
ADD COLUMN IF NOT EXISTS "razorpayPaymentData" JSONB;

-- Add metadata JSONB column
ALTER TABLE "Escrow" 
ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- Add comments for documentation
COMMENT ON COLUMN "Escrow"."razorpayOrderData" IS 'Sanitized Razorpay order response (no sensitive card data)';
COMMENT ON COLUMN "Escrow"."razorpayPaymentData" IS 'Sanitized Razorpay payment response (no sensitive card data)';
COMMENT ON COLUMN "Escrow"."metadata" IS 'Additional flexible metadata';








