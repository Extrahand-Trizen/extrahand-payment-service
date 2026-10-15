import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPaidEscrowRecord,
  readEscrowVisitAmountRupees,
  readRecurringVisitOrderScope,
  validateRecurringVisitOrderAmounts,
} from './recurringVisitOrderValidation';

describe('readRecurringVisitOrderScope', () => {
  it('ignores non-recurring orders', () => {
    assert.equal(readRecurringVisitOrderScope('task-1', { taskTitle: 'x' }), null);
    assert.equal(readRecurringVisitOrderScope('task-1', undefined), null);
  });

  it('scopes the order to the exact visit on the plan task', () => {
    assert.deepEqual(readRecurringVisitOrderScope('task-1', { visitId: ' v-uuid-1 ' }), {
      visitId: 'v-uuid-1',
      parentTaskId: 'task-1',
    });
  });

  it('rejects a parentTaskId that differs from the order task', () => {
    const scope = readRecurringVisitOrderScope('task-1', { visitId: 'v1', parentTaskId: 'task-2' });
    assert.ok(scope && 'error' in scope);
  });
});

describe('validateRecurringVisitOrderAmounts', () => {
  const base = { quotedVisitAmount: 500, quotedPlatformFeeTotal: 59 };

  it('accepts the quoted visit amount and server-computed gross', () => {
    assert.deepEqual(
      validateRecurringVisitOrderAmounts({ ...base, requestedTaskAmount: 500, requestedGrossAmount: 559 }),
      { ok: true },
    );
  });

  it('tolerates ₹1 rounding drift', () => {
    assert.equal(
      validateRecurringVisitOrderAmounts({ ...base, requestedTaskAmount: 500.4, requestedGrossAmount: 559.9 }).ok,
      true,
    );
  });

  it('rejects a manipulated visit amount', () => {
    const result = validateRecurringVisitOrderAmounts({
      ...base,
      requestedTaskAmount: 1,
      requestedGrossAmount: 559,
    });
    assert.equal(result.ok, false);
  });

  it('rejects a manipulated gross amount', () => {
    const result = validateRecurringVisitOrderAmounts({
      ...base,
      requestedTaskAmount: 500,
      requestedGrossAmount: 10,
    });
    assert.equal(result.ok, false);
  });

  it('rejects a multi-date multiplied amount for a single visit', () => {
    const result = validateRecurringVisitOrderAmounts({
      ...base,
      requestedTaskAmount: 1500,
      requestedGrossAmount: 1677,
    });
    assert.equal(result.ok, false);
  });

  it('rejects missing amounts', () => {
    assert.equal(
      validateRecurringVisitOrderAmounts({ ...base, requestedTaskAmount: undefined, requestedGrossAmount: 559 }).ok,
      false,
    );
  });
});

describe('paid escrow helpers', () => {
  it('treats held/released or captured (not refunded) escrows as paid', () => {
    assert.equal(isPaidEscrowRecord({ status: 'held' }), true);
    assert.equal(isPaidEscrowRecord({ status: 'released' }), true);
    assert.equal(isPaidEscrowRecord({ status: 'pending', paymentStatus: 'captured' }), true);
    assert.equal(isPaidEscrowRecord({ status: 'refunded', paymentStatus: 'captured' }), false);
    assert.equal(isPaidEscrowRecord({ status: 'pending', paymentStatus: 'pending' }), false);
    assert.equal(isPaidEscrowRecord(null), false);
  });

  it('reads the visit base amount from metadata before taskAmount', () => {
    assert.equal(readEscrowVisitAmountRupees({ taskAmount: '450', metadata: { visitBudgetRupees: 500 } }), 500);
    assert.equal(readEscrowVisitAmountRupees({ taskAmount: '450', metadata: {} }), 450);
    assert.equal(readEscrowVisitAmountRupees({ metadata: null }), null);
  });
});
