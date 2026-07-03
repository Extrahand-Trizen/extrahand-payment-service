import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseQueryEndDateInclusive, parseQueryStartDate } from './queryDateRange';

describe('queryDateRange', () => {
  it('parses YYYY-MM-DD as full inclusive UTC day', () => {
    const start = parseQueryStartDate('2026-06-25');
    const end = parseQueryEndDateInclusive('2026-06-25');

    assert.equal(start.toISOString(), '2026-06-25T00:00:00.000Z');
    assert.equal(end.toISOString(), '2026-06-25T23:59:59.999Z');

    const afternoonPayment = new Date('2026-06-25T10:50:00.000Z');
    assert.ok(afternoonPayment.getTime() >= start.getTime());
    assert.ok(afternoonPayment.getTime() <= end.getTime());
  });
});
