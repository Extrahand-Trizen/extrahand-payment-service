#!/usr/bin/env node

/**
 * Payment Transaction Data Cleanup Script
 * 
 * This script safely removes ONLY payment transaction data from the database.
 * User-related data (bank accounts, profiles, ExtraCoin wallets) are PRESERVED.
 * 
 * Usage: node cleanup_payment_data.js
 * 
 * Data that WILL be deleted:
 *   • Transactions (pay-in records)
 *   • Escrow (payment holds)
 *   • Refunds
 *   • Payouts
 *   • Disputes
 *   • Cancellation Penalties
 *   • Ledger (payment transaction history)
 *   • Reconciliation records
 *   • Payment-related audit logs and job queues
 *
 * Data that will be PRESERVED (user real data):
 *   • BankAccount (user's bank account details)
 *   • UserPaymentProfile (balances reset to 0, user record preserved)
 *   • ExtraCoinWallet (user's coin balance preserved)
 *   • ExtraCoinTransaction (coin earning history preserved)
 *   • AdminUser (admin records)
 *   • SystemConfig (system settings)
 *   • CategoryFeeConfig (category fee settings)
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.POSTGRESDB_URI;

if (!connectionString) {
  console.error('❌ POSTGRESDB_URI is not set. Please set it in your .env file');
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function cleanupPaymentData() {
  try {
    console.log('🔍 Starting payment transaction data cleanup (user data preserved)...\n');

    // Track counts for reporting
    const stats = {};

    // 1. Delete payment transaction records
    console.log('1️⃣  Clearing Ledger (payment transaction history)...');
    stats.ledger = await prisma.ledger.deleteMany({});
    console.log(`   ✓ Deleted ${stats.ledger.count} ledger records\n`);

    console.log('2️⃣  Clearing Disputes...');
    stats.dispute = await prisma.dispute.deleteMany({});
    console.log(`   ✓ Deleted ${stats.dispute.count} dispute records\n`);

    console.log('3️⃣  Clearing Refunds...');
    stats.refund = await prisma.refund.deleteMany({});
    console.log(`   ✓ Deleted ${stats.refund.count} refund records\n`);

    console.log('4️⃣  Clearing Payouts...');
    stats.payout = await prisma.payout.deleteMany({});
    console.log(`   ✓ Deleted ${stats.payout.count} payout records\n`);

    console.log('5️⃣  Clearing Performer Cancellation Penalties...');
    stats.penalty = await prisma.performerCancellationPenalty.deleteMany({});
    console.log(`   ✓ Deleted ${stats.penalty.count} penalty records\n`);

    console.log('6️⃣  Clearing Escrow (payment holds)...');
    stats.escrow = await prisma.escrow.deleteMany({});
    console.log(`   ✓ Deleted ${stats.escrow.count} escrow records\n`);

    console.log('7️⃣  Clearing Transactions (pay-in records)...');
    stats.transaction = await prisma.transaction.deleteMany({});
    console.log(`   ✓ Deleted ${stats.transaction.count} transaction records\n`);

    console.log('8️⃣  Clearing Reconciliation Records...');
    stats.reconciliation = await prisma.reconciliation.deleteMany({});
    console.log(`   ✓ Deleted ${stats.reconciliation.count} reconciliation records\n`);

    console.log('9️⃣  Clearing Payment Order Idempotency Keys...');
    stats.paymentOrderIdempotency = await prisma.paymentOrderIdempotency.deleteMany({});
    console.log(`   ✓ Deleted ${stats.paymentOrderIdempotency.count} idempotency key records\n`);

    // 2. Clear payment-related job queue and audit logs (but preserve other records)
    console.log('🔟 Clearing Payment-Related Job Queue Entries...');
    stats.jobQueuePayment = await prisma.jobQueue.deleteMany({
      where: {
        jobType: {
          in: ['payment_retry', 'payout_retry', 'refund_retry', 'reconciliation', 'auto_release', 'webhook_retry']
        }
      }
    });
    console.log(`   ✓ Deleted ${stats.jobQueuePayment.count} payment-related job queue records\n`);

    console.log('1️⃣1️⃣  Clearing Payment-Related Audit Logs...');
    stats.auditLogPayment = await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: { in: ['escrow', 'refund', 'payout', 'dispute', 'webhook'] } },
          { eventType: { not: null } }
        ]
      }
    });
    console.log(`   ✓ Deleted ${stats.auditLogPayment.count} payment-related audit log records\n`);

    // 3. Reset UserPaymentProfile balances to 0 (but keep user records)
    console.log('1️⃣2️⃣  Resetting User Payment Profile Balances...');
    stats.profileReset = await prisma.userPaymentProfile.updateMany({
      data: {
        totalEarnings: 0,
        fromPayouts: 0,
        fromCompensation: 0,
        payoutCount: 0,
        compensationCount: 0,
        totalPayments: 0,
        paymentCount: 0,
        totalRefunds: 0,
        refundCount: 0,
        totalFees: 0,
        averagePayout: null,
        largestPayout: null,
        smallestPayout: null,
        lastPayoutDate: null,
        lastPaymentDate: null,
        lastUpdatedAt: new Date(),
        updatedAt: new Date()
      }
    });
    console.log(`   ✓ Reset payment balances for ${stats.profileReset.count} user profile records\n`);

    // Summary
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ CLEANUP COMPLETE - Summary of Changes:');
    console.log('═══════════════════════════════════════════════════════════\n');

    const totalDeleted = Object.values(stats).filter(stat => stat.count).reduce((sum, stat) => sum + (stat.count || 0), 0);

    console.log('🗑️  Deleted records by table:');
    console.log(`  • Ledger (Payment History):      ${stats.ledger.count}`);
    console.log(`  • Disputes:                       ${stats.dispute.count}`);
    console.log(`  • Refunds:                        ${stats.refund.count}`);
    console.log(`  • Payouts:                        ${stats.payout.count}`);
    console.log(`  • Cancellation Penalties:         ${stats.penalty.count}`);
    console.log(`  • Escrow (Payment Holds):         ${stats.escrow.count}`);
    console.log(`  • Transactions (Pay-ins):         ${stats.transaction.count}`);
    console.log(`  • Reconciliation Records:         ${stats.reconciliation.count}`);
    console.log(`  • Payment Order Idempotency:      ${stats.paymentOrderIdempotency.count}`);
    console.log(`  • Payment Job Queue Entries:      ${stats.jobQueuePayment.count}`);
    console.log(`  • Payment Audit Logs:             ${stats.auditLogPayment.count}`);
    console.log(`\n🔄 Updated records:`)
    console.log(`  • User Payment Profiles Reset:    ${stats.profileReset.count}`);
    console.log(`\n  📊 TOTAL DELETED:                 ${totalDeleted}\n`);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✨ Data Preserved (User Real Data):');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ✅ BankAccount records (user bank details)');
    console.log('  ✅ ExtraCoinWallet (user coin balances)');
    console.log('  ✅ ExtraCoinTransaction (user coin history)');
    console.log('  ✅ AdminUser records');
    console.log('  ✅ SystemConfig records');
    console.log('  ✅ CategoryFeeConfig records');
    console.log('  ✅ UserPaymentProfile records (balances reset to 0)\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✨ Payment transaction dummy data has been successfully removed!');
    console.log('   All user-related data has been preserved.');
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ERROR during cleanup:');
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the cleanup
cleanupPaymentData();

async function cleanupPaymentData() {
  try {
    console.log('🔍 Starting payment transaction data cleanup (user data preserved)...\n');

    // Track counts for reporting
    const stats = {};

    // 1. Delete payment transaction records
    console.log('1️⃣  Clearing Ledger (payment transaction history)...');
    stats.ledger = await prisma.ledger.deleteMany({});
    console.log(`   ✓ Deleted ${stats.ledger.count} ledger records\n`);

    console.log('2️⃣  Clearing Disputes...');
    stats.dispute = await prisma.dispute.deleteMany({});
    console.log(`   ✓ Deleted ${stats.dispute.count} dispute records\n`);

    console.log('3️⃣  Clearing Refunds...');
    stats.refund = await prisma.refund.deleteMany({});
    console.log(`   ✓ Deleted ${stats.refund.count} refund records\n`);

    console.log('4️⃣  Clearing Payouts...');
    stats.payout = await prisma.payout.deleteMany({});
    console.log(`   ✓ Deleted ${stats.payout.count} payout records\n`);

    console.log('5️⃣  Clearing Performer Cancellation Penalties...');
    stats.penalty = await prisma.performerCancellationPenalty.deleteMany({});
    console.log(`   ✓ Deleted ${stats.penalty.count} penalty records\n`);

    console.log('6️⃣  Clearing Escrow (payment holds)...');
    stats.escrow = await prisma.escrow.deleteMany({});
    console.log(`   ✓ Deleted ${stats.escrow.count} escrow records\n`);

    console.log('7️⃣  Clearing Transactions (pay-in records)...');
    stats.transaction = await prisma.transaction.deleteMany({});
    console.log(`   ✓ Deleted ${stats.transaction.count} transaction records\n`);

    console.log('8️⃣  Clearing Reconciliation Records...');
    stats.reconciliation = await prisma.reconciliation.deleteMany({});
    console.log(`   ✓ Deleted ${stats.reconciliation.count} reconciliation records\n`);

    console.log('9️⃣  Clearing Payment Order Idempotency Keys...');
    stats.paymentOrderIdempotency = await prisma.paymentOrderIdempotency.deleteMany({});
    console.log(`   ✓ Deleted ${stats.paymentOrderIdempotency.count} idempotency key records\n`);

    // 2. Clear payment-related job queue and audit logs (but preserve other records)
    console.log('🔟 Clearing Payment-Related Job Queue Entries...');
    stats.jobQueuePayment = await prisma.jobQueue.deleteMany({
      where: {
        jobType: {
          in: ['payment_retry', 'payout_retry', 'refund_retry', 'reconciliation', 'auto_release', 'webhook_retry']
        }
      }
    });
    console.log(`   ✓ Deleted ${stats.jobQueuePayment.count} payment-related job queue records\n`);

    console.log('1️⃣1️⃣  Clearing Payment-Related Audit Logs...');
    stats.auditLogPayment = await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: { in: ['escrow', 'refund', 'payout', 'dispute', 'webhook'] } },
          { eventType: { not: null } }
        ]
      }
    });
    console.log(`   ✓ Deleted ${stats.auditLogPayment.count} payment-related audit log records\n`);

    // 3. Reset UserPaymentProfile balances to 0 (but keep user records)
    console.log('1️⃣2️⃣  Resetting User Payment Profile Balances...');
    stats.profileReset = await prisma.userPaymentProfile.updateMany({
      data: {
        totalEarnings: 0,
        fromPayouts: 0,
        fromCompensation: 0,
        payoutCount: 0,
        compensationCount: 0,
        totalPayments: 0,
        paymentCount: 0,
        totalRefunds: 0,
        refundCount: 0,
        totalFees: 0,
        averagePayout: null,
        largestPayout: null,
        smallestPayout: null,
        lastPayoutDate: null,
        lastPaymentDate: null,
        lastUpdatedAt: new Date(),
        updatedAt: new Date()
      }
    });
    console.log(`   ✓ Reset payment balances for ${stats.profileReset.count} user profile records\n`);

    // Summary
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ CLEANUP COMPLETE - Summary of Changes:');
    console.log('═══════════════════════════════════════════════════════════\n');

    const totalDeleted = Object.values(stats).filter(stat => stat.count).reduce((sum, stat) => sum + (stat.count || 0), 0);

    console.log('🗑️  Deleted records by table:');
    console.log(`  • Ledger (Payment History):      ${stats.ledger.count}`);
    console.log(`  • Disputes:                       ${stats.dispute.count}`);
    console.log(`  • Refunds:                        ${stats.refund.count}`);
    console.log(`  • Payouts:                        ${stats.payout.count}`);
    console.log(`  • Cancellation Penalties:         ${stats.penalty.count}`);
    console.log(`  • Escrow (Payment Holds):         ${stats.escrow.count}`);
    console.log(`  • Transactions (Pay-ins):         ${stats.transaction.count}`);
    console.log(`  • Reconciliation Records:         ${stats.reconciliation.count}`);
    console.log(`  • Payment Order Idempotency:      ${stats.paymentOrderIdempotency.count}`);
    console.log(`  • Payment Job Queue Entries:      ${stats.jobQueuePayment.count}`);
    console.log(`  • Payment Audit Logs:             ${stats.auditLogPayment.count}`);
    console.log(`\n🔄 Updated records:`)
    console.log(`  • User Payment Profiles Reset:    ${stats.profileReset.count}`);
    console.log(`\n  📊 TOTAL DELETED:                 ${totalDeleted}\n`);

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✨ Data Preserved (User Real Data):');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  ✅ BankAccount records (user bank details)');
    console.log('  ✅ ExtraCoinWallet (user coin balances)');
    console.log('  ✅ ExtraCoinTransaction (user coin history)');
    console.log('  ✅ AdminUser records');
    console.log('  ✅ SystemConfig records');
    console.log('  ✅ CategoryFeeConfig records');
    console.log('  ✅ UserPaymentProfile records (balances reset to 0)\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✨ Payment transaction dummy data has been successfully removed!');
    console.log('   All user-related data has been preserved.');
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ ERROR during cleanup:');
    console.error(error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the cleanup
cleanupPaymentData();
