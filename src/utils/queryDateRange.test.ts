import { parseQueryEndDateInclusive, parseQueryStartDate } from './queryDateRange';

describe('queryDateRange', () => {
  it('parses YYYY-MM-DD as full inclusive UTC day', () => {
    const start = parseQueryStartDate('2026-06-25');
    const end = parseQueryEndDateInclusive('2026-06-25');

    expect(start.toISOString()).toBe('2026-06-25T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-06-25T23:59:59.999Z');

    const afternoonPayment = new Date('2026-06-25T10:50:00.000Z');
    expect(afternoonPayment.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(afternoonPayment.getTime()).toBeLessThanOrEqual(end.getTime());
  });
});
