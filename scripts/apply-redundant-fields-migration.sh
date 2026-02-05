#!/bin/bash

# Migration Script: Remove Redundant Fields from Payment Service Tables
# This script applies the migration to remove redundant fields that can be derived or queried

set -e  # Exit on error

echo "🔄 Starting migration: Remove Redundant Fields"
echo ""

# Navigate to payment service directory
cd "$(dirname "$0")/.."

# Check if .env file exists
if [ ! -f .env ]; then
  echo "❌ Error: .env file not found"
  echo "   Please create a .env file with your database connection string"
  exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "⚠️  Warning: DATABASE_URL not set in environment"
  echo "   Make sure your .env file contains DATABASE_URL"
  echo ""
fi

echo "📋 Migration Details:"
echo "   - Escrow: Remove autoReleaseEnabled, autoReleaseAfterDays, releaseTransactionId, refundTransactionId, refundReason, expiresAt"
echo "   - Refund: Remove amount, cancellationReason, hoursUntilDeadline, errorCode"
echo "   - Payout: Remove errorCode"
echo "   - UserPaymentProfile: Remove autoPayoutEnabled, payoutThreshold, taxId"
echo ""

# Ask for confirmation
read -p "⚠️  This will permanently remove columns from your database. Continue? (yes/no): " confirm
if [ "$confirm" != "yes" ]; then
  echo "❌ Migration cancelled"
  exit 1
fi

echo ""
echo "🚀 Applying migration..."

# Apply the migration
npx prisma migrate deploy

echo ""
echo "✅ Migration applied successfully!"
echo ""
echo "🔄 Generating Prisma Client..."

# Generate Prisma client
npx prisma generate

echo ""
echo "✅ Prisma Client generated successfully!"
echo ""
echo "🎉 Migration complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Test your application to ensure everything works correctly"
echo "   2. Verify that derived fields are computed correctly"
echo "   3. Check that queries to related tables work as expected"




