import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRazorpayPayoutStatusToInternal } from './payoutStatusMapping.ts';

test('maps Razorpay-created payouts to completed internal status', () => {
  assert.equal(mapRazorpayPayoutStatusToInternal('created'), 'completed');
});

test('maps processed payouts to completed internal status', () => {
  assert.equal(mapRazorpayPayoutStatusToInternal('processed'), 'completed');
});
