# Migration Script: Remove Redundant Fields from Payment Service Tables
# PowerShell version for Windows

Write-Host "🔄 Starting migration: Remove Redundant Fields" -ForegroundColor Cyan
Write-Host ""

# Navigate to payment service directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptPath
Set-Location $projectRoot

# Check if .env file exists
if (-not (Test-Path ".env")) {
    Write-Host "❌ Error: .env file not found" -ForegroundColor Red
    Write-Host "   Please create a .env file with your database connection string"
    exit 1
}

Write-Host "📋 Migration Details:" -ForegroundColor Yellow
Write-Host "   - Escrow: Remove autoReleaseEnabled, autoReleaseAfterDays, releaseTransactionId, refundTransactionId, refundReason, expiresAt"
Write-Host "   - Refund: Remove amount, cancellationReason, hoursUntilDeadline, errorCode"
Write-Host "   - Payout: Remove errorCode"
Write-Host "   - UserPaymentProfile: Remove autoPayoutEnabled, payoutThreshold, taxId"
Write-Host ""

# Ask for confirmation
$confirm = Read-Host "⚠️  This will permanently remove columns from your database. Continue? (yes/no)"
if ($confirm -ne "yes") {
    Write-Host "❌ Migration cancelled" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "🚀 Applying migration..." -ForegroundColor Green

# Apply the migration
npx prisma migrate deploy

Write-Host ""
Write-Host "✅ Migration applied successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "🔄 Generating Prisma Client..." -ForegroundColor Cyan

# Generate Prisma client
npx prisma generate

Write-Host ""
Write-Host "✅ Prisma Client generated successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "🎉 Migration complete!" -ForegroundColor Green
Write-Host ""
Write-Host "📝 Next steps:" -ForegroundColor Yellow
Write-Host "   1. Test your application to ensure everything works correctly"
Write-Host "   2. Verify that derived fields are computed correctly"
Write-Host "   3. Check that queries to related tables work as expected"




