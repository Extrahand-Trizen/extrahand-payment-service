/**
 * Book Now cancellation — unassigned partner full-refund gate.
 * Run: npx ts-node src/services/bookNowCancellationPolicy.assignment.test.ts
 */
import assert from 'assert';
import { Prisma } from '@prisma/client';

// Mock fee structure dependency used by calculateBookNowCancellationFee for assigned path.
jestMockFeeConfig();

import {
  calculateBookNowCancellationFee,
  resolveBookNowCancellationTier,
} from './bookNowCancellationPolicy';

function jestMockFeeConfig(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Module = require('module');
  const originalLoad = Module._load;
  Module._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === './feeConfigService' || request.endsWith('/feeConfigService')) {
      return {
        getFeeStructure: async () => ({
          cancellationFees: {
            distribution: { toOtherParty: 1, toPlatform: 0 },
          },
        }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

async function testUnassignedFullRefundWithin24h(): Promise<void> {
  const start = new Date('2026-08-10T12:00:00.000Z');
  const cancelledAt = new Date('2026-08-09T18:00:00.000Z'); // ~18h before
  const amount = new Prisma.Decimal('499.00'); // includes GST portion in capturable total
  const result = await calculateBookNowCancellationFee({
    catalogId: 'full-house',
    amount,
    taskStartDate: start,
    cancelledAt,
    partnerAssigned: false,
  });
  assert.strictEqual(result.tier, 'free');
  assert.strictEqual(result.policyKey, 'book_now_no_partner_assigned');
  assert.strictEqual(result.cancellationFee.toString(), '0');
  assert.strictEqual(result.refundAmount.toString(), '499');
}

async function testUnassignedFullRefundWithin4h(): Promise<void> {
  const start = new Date('2026-08-10T12:00:00.000Z');
  const cancelledAt = new Date('2026-08-10T10:00:00.000Z'); // 2h before
  const result = await calculateBookNowCancellationFee({
    catalogId: 'full-house',
    amount: 999,
    taskStartDate: start,
    cancelledAt,
    partnerReachedLocation: false,
    partnerAssigned: false,
  });
  assert.strictEqual(Number(result.cancellationFee.toString()), 0);
  assert.strictEqual(Number(result.refundAmount.toString()), 999);
}

async function testAssignedStillChargesWithin24h(): Promise<void> {
  const start = new Date('2026-08-10T12:00:00.000Z');
  const cancelledAt = new Date('2026-08-09T18:00:00.000Z');
  const result = await calculateBookNowCancellationFee({
    catalogId: 'full-house',
    amount: 999,
    taskStartDate: start,
    cancelledAt,
    partnerAssigned: true,
  });
  assert.strictEqual(result.tier, 'within_24h');
  assert.strictEqual(Number(result.cancellationFee.toString()), 99);
  assert.strictEqual(Number(result.refundAmount.toString()), 900);
}

async function testAssignedPartnerReachedUnchanged(): Promise<void> {
  const start = new Date('2026-08-10T12:00:00.000Z');
  const cancelledAt = new Date('2026-08-10T11:00:00.000Z');
  const tier = resolveBookNowCancellationTier({
    taskStartDate: start,
    cancelledAt,
    partnerReachedLocation: true,
  });
  assert.strictEqual(tier, 'partner_reached');
  const result = await calculateBookNowCancellationFee({
    catalogId: 'full-house',
    amount: 999,
    taskStartDate: start,
    cancelledAt,
    partnerReachedLocation: true,
    partnerAssigned: true,
  });
  assert.strictEqual(result.tier, 'partner_reached');
  assert.strictEqual(Number(result.cancellationFee.toString()), 299);
}

async function main(): Promise<void> {
  await testUnassignedFullRefundWithin24h();
  await testUnassignedFullRefundWithin4h();
  await testAssignedStillChargesWithin24h();
  await testAssignedPartnerReachedUnchanged();
  console.log('bookNowCancellationPolicy.assignment.test.ts: all tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
