/**
 * Unit smoke for minutes-based partnerVisibleAt delay.
 * Run: npx ts-node src/utils/bookNowPartnerPayoutVisibility.minutes.test.ts
 */
import assert from 'assert';
import {
  getBookNowPayoutPartnerVisibleAfterMinutes,
  resolvePartnerVisibleAt,
} from './bookNowPartnerPayoutVisibility';

const prevMins = process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES;
const prevHours = process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS;

try {
  delete process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES;
  delete process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS;
  assert.strictEqual(getBookNowPayoutPartnerVisibleAfterMinutes(), 60);

  process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES = '15';
  assert.strictEqual(getBookNowPayoutPartnerVisibleAfterMinutes(), 15);

  const from = new Date('2026-07-31T12:00:00.000Z');
  const at = resolvePartnerVisibleAt({ isBookNow: true, from });
  assert.ok(at);
  assert.strictEqual(at!.toISOString(), '2026-07-31T12:15:00.000Z');

  delete process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES;
  process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS = '2';
  assert.strictEqual(getBookNowPayoutPartnerVisibleAfterMinutes(), 120);

  process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES = '0';
  assert.strictEqual(getBookNowPayoutPartnerVisibleAfterMinutes(), 0);
  const immediate = resolvePartnerVisibleAt({ isBookNow: true, from });
  assert.strictEqual(immediate!.toISOString(), from.toISOString());

  console.log('bookNowPartnerPayoutVisibility.minutes.test.ts: all tests passed');
} finally {
  if (prevMins === undefined) delete process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES;
  else process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_MINUTES = prevMins;
  if (prevHours === undefined) delete process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS;
  else process.env.BOOK_NOW_PAYOUT_PARTNER_VISIBLE_AFTER_HOURS = prevHours;
}
