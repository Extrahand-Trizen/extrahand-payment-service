/**
 * Recurring visit payment integrity: payment state transitions, duplicate order protection,
 * visit-scoped re-tag and payout authorization. Runs the real services against an in-memory
 * Prisma stand-in; no Postgres, Mongo, Razorpay or other services are contacted.
 * Run: npm run test:recurring-visit-integrity
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Dummy config before any service module loads (dotenv never overrides values already set).
Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  TASK_SERVICE_URL: 'http://127.0.0.1:9',
  COUPON_SERVICE_URL: 'http://127.0.0.1:9',
  USER_SERVICE_URL: 'http://127.0.0.1:9',
  USE_DEV_POSTGRES: 'false',
  POSTGRESDB_URI: 'postgresql://test:test@127.0.0.1:1/test',
  PROD_POSTGRESDB_URI: 'postgresql://test:test@127.0.0.1:1/test',
  DEV_POSTGRESDB_URI: 'postgresql://test:test@127.0.0.1:1/test',
  RAZORPAY_LIVE_KEY_ID: 'rzp_live_dummy',
  RAZORPAY_LIVE_KEY_SECRET: 'dummy',
  RAZORPAY_TEST_KEY_ID: '',
  RAZORPAY_TEST_KEY_SECRET: '',
  RAZORPAYX_KEY_ID: 'rzpx_dummy',
  RAZORPAYX_KEY_SECRET: 'dummy',
  RAZORPAYX_ACCOUNT_NUMBER: '0000',
  PAYOUT_MANUAL_OPS_MODE: 'true',
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { Prisma } = require('@prisma/client');
const mongoose = require('mongoose');
const prismaConfig = require('../config/prisma');
const database = require('../config/database');
const { CouponClient } = require('../clients/CouponClient');
const { TaskServiceClient } = require('../clients/TaskServiceClient');
const feeCalculationService = require('./feeCalculationService');
const feeConfigService = require('./feeConfigService');
const { CoinUsageConfigProvider } = require('../rewards/config/CoinUsageConfigProvider');
const performerPenaltyService = require('./performerPenaltyService');
const extraCoinsService = require('./extraCoinsService');
const userPaymentProfileService = require('./userPaymentProfileService');
const paymentNotificationService = require('./paymentNotificationService');
const escrowService = require('./escrowService');
const { handlePaymentFailure } = require('./paymentFailureService');
const { processTaskCompletionPayout, processPayout } = require('./payoutService');
const mockBankTransferService = require('./mockBankTransferService');
const { EscrowController } = require('../controllers/EscrowController');
const { PayoutController } = require('../controllers/PayoutController');
const { isEscrowPaidRecord, isEscrowActiveHeldRecord } = require('../utils/escrowPaymentState');
const { RECURRING_VISIT_ORDER_LOCK_TTL_MS } = require('./recurringVisitOrderService');
/* eslint-enable @typescript-eslint/no-var-requires */

// ── In-memory Prisma ─────────────────────────────────────────────────────────
type Row = Record<string, any>;
let clock = Date.now();
const now = () => new Date((clock += 1));

const isPlainObject = (v: unknown) =>
  v !== null && typeof v === 'object' && !(v instanceof Date) && !Prisma.Decimal.isDecimal(v) && !Array.isArray(v);
const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() === new Date(b as Date).getTime();
  if (a == null && b == null) return true;
  return a === b;
};

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (key === 'AND') return ([] as Row[]).concat(cond).every((c) => matches(row, c));
    if (key === 'NOT') return !([] as Row[]).concat(cond).some((c) => matches(row, c));
    const value = row[key];
    if (!isPlainObject(cond)) return same(value, cond);
    const c = cond as Row;
    if ('path' in c) {
      const v = (c.path as string[]).reduce((acc: any, k) => (acc == null ? undefined : acc[k]), value);
      return !('equals' in c) || same(v, c.equals);
    }
    if ('in' in c && !c.in.some((x: unknown) => same(value, x))) return false;
    if ('notIn' in c && (value == null || c.notIn.some((x: unknown) => same(value, x)))) return false;
    if ('not' in c && same(value, c.not)) return false;
    if ('equals' in c && !same(value, c.equals)) return false;
    if ('lt' in c && !(value < c.lt)) return false;
    if ('lte' in c && !(value <= c.lte)) return false;
    if ('gt' in c && !(value > c.gt)) return false;
    if ('gte' in c && !(value >= c.gte)) return false;
    return true;
  });
}

const clone = (row: Row | undefined | null) =>
  row ? { ...row, metadata: row.metadata ? JSON.parse(JSON.stringify(row.metadata)) : row.metadata } : null;

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && 'increment' in (value as Row)) {
      row[key] = Number(row[key] || 0) + Number((value as Row).increment);
    } else {
      row[key] = value;
    }
  }
  row.updatedAt = now();
}

function sortRows(rows: Row[], orderBy: Row | Row[] | undefined): Row[] {
  const orders = ([] as Row[]).concat(orderBy || []);
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [key, dir] = Object.entries(order)[0];
      const av = new Date(a[key]).getTime() || a[key];
      const bv = new Date(b[key]).getTime() || b[key];
      if (av < bv) return dir === 'desc' ? 1 : -1;
      if (av > bv) return dir === 'desc' ? -1 : 1;
    }
    return 0;
  });
}

function makeModel(uniqueKeys: string[] = []) {
  const rows: Row[] = [];
  const uniqueConflict = (candidate: Row, self?: Row) =>
    uniqueKeys.some((key) =>
      candidate[key] != null && rows.some((r) => r !== self && same(r[key], candidate[key])),
    );
  const p2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
  return {
    rows,
    async findUnique({ where }: Row) {
      return clone(rows.find((r) => matches(r, where)));
    },
    async findFirst({ where, orderBy }: Row = {}) {
      return clone(sortRows(rows.filter((r) => matches(r, where)), orderBy)[0]);
    },
    async findMany({ where, orderBy, take }: Row = {}) {
      const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return found.slice(0, take ?? found.length).map(clone);
    },
    async count({ where }: Row = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async aggregate() {
      return { _sum: {}, _count: 0 };
    },
    async create({ data }: Row) {
      const row: Row = { id: randomUUID(), createdAt: now(), ...data };
      row.updatedAt = row.updatedAt ?? row.createdAt;
      if (uniqueConflict(row)) throw p2002();
      rows.push(row);
      return clone(row);
    },
    async update({ where, data }: Row) {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      applyData(row, data);
      return clone(row);
    },
    async updateMany({ where, data }: Row) {
      const found = rows.filter((r) => matches(r, where));
      found.forEach((row) => applyData(row, data));
      return { count: found.length };
    },
    async upsert({ where, create, update }: Row) {
      const row = rows.find((r) => matches(r, where));
      if (row) {
        applyData(row, update);
        return clone(row);
      }
      return this.create({ data: create });
    },
    async delete({ where }: Row) {
      const index = rows.findIndex((r) => matches(r, where));
      if (index < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
      return clone(rows.splice(index, 1)[0]);
    },
    async createMany({ data }: Row) {
      const list = ([] as Row[]).concat(data);
      for (const item of list) await this.create({ data: item });
      return { count: list.length };
    },
    async deleteMany({ where }: Row = {}) {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (matches(rows[i], where)) {
          rows.splice(i, 1);
          count += 1;
        }
      }
      return { count };
    },
  };
}

let models: Record<string, ReturnType<typeof makeModel>> = {};
const UNIQUE: Record<string, string[]> = {
  escrow: ['escrowId', 'razorpayOrderId'],
  paymentOrderIdempotency: ['idempotencyKey'],
  payout: ['payoutId'],
  jobQueue: ['jobId'],
  refund: ['refundId', 'razorpayRefundId'],
  transaction: ['razorpayPaymentId'],
  userPaymentProfile: ['userId'],
};
const fakeDb: any = new Proxy(
  {},
  {
    get(_target, prop: string) {
      if (prop === '$transaction') {
        return async (arg: any) => (typeof arg === 'function' ? arg(fakeDb) : Promise.all(arg));
      }
      if (prop === 'then') return undefined;
      if (!models[prop]) models[prop] = makeModel(UNIQUE[prop]);
      return models[prop];
    },
  },
);
prismaConfig.prisma = fakeDb;
database.isPostgresConnected = () => true;
database.ensurePostgresReady = async () => true;

// ── Network-facing collaborators ─────────────────────────────────────────────
CouponClient.cancel = async () => undefined;
CouponClient.confirm = async () => undefined;
feeConfigService.resolveBiddingPayoutFeePercents = async () => ({ platformFeePercentage: 0.1, gstPercentage: 0.18 });
CoinUsageConfigProvider.getCapPercents = async () => ({ posterBooking: 1, taskerPlatformFee: 1 });
performerPenaltyService.planPenaltyDeductionsFromGross = async (_uid: string, base: any) => ({
  netTransfer: base,
  totalDeducted: new Prisma.Decimal(0),
  lines: [],
});
extraCoinsService.awardExtraCoinsForCompletedTask = async () => ({ success: true, awardedCoins: '0' });
userPaymentProfileService.applyPayoutStatusToProfile = async () => undefined;
userPaymentProfileService.updateUserPaymentProfile = async () => undefined;
paymentNotificationService.notifyPayoutInitiated = async () => undefined;
TaskServiceClient.notifyRecurringVisitPaymentCaptured = async () => ({ success: true });

// Task documents in the shared Mongo `tasks` collection and RecurringVisit rows.
let taskDocs = new Map<string, Row>();
let visitDocs: Row[] = [];
let mongoReady = true;
Object.defineProperty(mongoose.connection, 'readyState', { get: () => (mongoReady ? 1 : 0), configurable: true });
mongoose.connection.collection = (name: string) => ({
  findOne: async (query: Row = {}) => {
    if (name === 'recurringvisits') {
      return (
        visitDocs.find(
          (v) => String(v.parentTaskId) === String(query.parentTaskId) && v.visitId === query.visitId,
        ) ?? null
      );
    }
    if (name !== 'tasks') return null;
    if (query._id !== undefined) {
      const doc = taskDocs.get(String(query._id)) ?? null;
      const scheduleVisit = query['schedule.visitId'];
      if (doc && scheduleVisit !== undefined) {
        return (doc.schedule || []).some((row: Row) => row.visitId === scheduleVisit) ? doc : null;
      }
      return doc;
    }
    return (
      [...taskDocs.values()].find(
        (doc) =>
          doc.parentTaskId != null &&
          String(doc.parentTaskId) === String(query.parentTaskId) &&
          doc.recurringVisitId === query.recurringVisitId,
      ) ?? null
    );
  },
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
const PARENT = new mongoose.Types.ObjectId().toString();
const CHILD_V1 = new mongoose.Types.ObjectId().toString();
const CHILD_V2 = new mongoose.Types.ObjectId().toString();
const V1 = 'visit-uuid-1';
const V2 = 'visit-uuid-2';
const HELPER = 'helper-uid';

function seedEscrow(overrides: Row = {}): Row {
  const id = overrides.escrowId || `esc_${randomUUID().slice(0, 8)}`;
  const visitId = overrides.visitId ?? V1;
  const row: Row = {
    id: randomUUID(),
    escrowId: id,
    razorpayOrderId: `order_${id}`,
    razorpayPaymentId: null,
    taskId: PARENT,
    applicationId: 'app-1',
    posterUid: 'poster-uid',
    performerUid: HELPER,
    amount: new Prisma.Decimal('55000'),
    amountInRupees: new Prisma.Decimal('550'),
    taskAmount: new Prisma.Decimal('500'),
    currency: 'INR',
    status: 'held',
    paymentStatus: 'captured',
    autoReleaseDate: null,
    createdAt: now(),
    metadata: { visitId, parentTaskId: PARENT, recurringPlan: true, visitBudgetRupees: 500 },
    ...overrides,
  };
  delete row.visitId;
  if (overrides.visitId === null) delete row.metadata.visitId;
  row.updatedAt = row.createdAt;
  fakeDb.escrow.rows.push(row);
  return row;
}
const escrowRow = (escrowId: string) => fakeDb.escrow.rows.find((r: Row) => r.escrowId === escrowId);
const visitOf = (row: Row) => row.metadata?.visitId;

function seedHelperBank(): void {
  fakeDb.userPaymentProfile.rows.push({ id: 'upp', userId: HELPER, defaultBankAccountId: 'bank-1' });
  fakeDb.bankAccount.rows.push({ id: 'bank-1', userId: HELPER, accountNumber: '1234567890', ifscCode: 'TEST0000001', verificationRef: null });
}
function seedChild(childId: string, visitId: string, assigneeUid = HELPER): void {
  taskDocs.set(childId, {
    _id: childId,
    parentTaskId: new mongoose.Types.ObjectId(PARENT),
    recurringVisitId: visitId,
    assigneeUid,
  });
}

beforeEach(() => {
  models = {};
  taskDocs = new Map();
  visitDocs = [];
  mongoReady = true;
});

// ── A / N: refunded payments are never active ────────────────────────────────
test('A: refunded escrow (status refunded, paymentStatus captured) is not paid or held', () => {
  const refunded = { status: 'refunded', paymentStatus: 'captured' };
  assert.equal(isEscrowPaidRecord(refunded), false);
  assert.equal(isEscrowActiveHeldRecord(refunded), false);
  assert.equal(isEscrowPaidRecord({ status: 'cancelled', paymentStatus: 'captured' }), false);
  assert.equal(isEscrowPaidRecord({ status: 'pending', paymentStatus: 'failed' }), false);
  assert.equal(isEscrowPaidRecord({ status: 'held', paymentStatus: 'captured' }), true);
  assert.equal(isEscrowPaidRecord({ status: 'released', paymentStatus: 'captured' }), true);
  assert.equal(isEscrowActiveHeldRecord({ status: 'released', paymentStatus: 'captured' }), false);
});

test('A/I: visit lookup skips refunded E1 and returns active E2 on the same visit', async () => {
  seedEscrow({ escrowId: 'E2' });
  seedEscrow({ escrowId: 'E1', status: 'refunded' }); // newer
  const found = await escrowService.getEscrowByTaskIdAndVisitId(PARENT, V1);
  assert.equal(found.escrowId, 'E2');
});

// ── C / D: payment state transitions ─────────────────────────────────────────
test('C: late payment.failed after capture is ignored and nothing is written', async () => {
  const e = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_ok' });
  const before = { ...escrowRow('E1') };
  const result = await handlePaymentFailure({
    razorpayOrderId: e.razorpayOrderId,
    razorpayPaymentId: 'pay_failed_attempt',
    errorCode: 'BAD_REQUEST_ERROR',
    failureReason: 'Payment failed',
  });
  assert.equal(result.success, true);
  const after = escrowRow('E1');
  assert.equal(after.status, 'held');
  assert.equal(after.paymentStatus, 'captured');
  assert.equal(after.razorpayPaymentId, 'pay_ok');
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
  assert.equal(fakeDb.ledger.rows.length, 0, 'no failure ledger entry for an ignored event');
});

test('C: failed / authorized events never overwrite released or refunded escrows', async () => {
  for (const status of ['released', 'refunded']) {
    models = {};
    const e = seedEscrow({ escrowId: `E_${status}`, status, razorpayPaymentId: 'pay_ok' });
    for (const event of ['failed', 'authorized', 'captured'] as const) {
      const result = await escrowService.updateEscrowOnPaymentCapture(e.razorpayOrderId, 'pay_other', event, {});
      assert.equal(result.success, true);
      assert.equal(result.ignored, true, `${event} on ${status} is ignored`);
    }
    assert.equal(escrowRow(`E_${status}`).status, status);
    assert.equal(escrowRow(`E_${status}`).paymentStatus, 'captured');
  }
});

test('C: duplicate payment.failed events are idempotent', async () => {
  const e = seedEscrow({ escrowId: 'E1', status: 'pending', paymentStatus: 'pending' });
  const failure = {
    razorpayOrderId: e.razorpayOrderId,
    razorpayPaymentId: 'pay_x',
    errorCode: 'BAD_REQUEST_ERROR',
    failureReason: 'Card declined',
  };
  assert.equal((await handlePaymentFailure(failure)).success, true);
  const firstUpdatedAt = escrowRow('E1').updatedAt.getTime();
  const ledgerAfterFirst = fakeDb.ledger.rows.length;
  assert.equal((await handlePaymentFailure(failure)).success, true);
  assert.equal(escrowRow('E1').updatedAt.getTime(), firstUpdatedAt, 'second failure writes nothing');
  assert.equal(fakeDb.ledger.rows.length, ledgerAfterFirst, 'no duplicate failure ledger entry');
});

test('D: genuine failure on an unpaid order still applies', async () => {
  const e = seedEscrow({ escrowId: 'E1', status: 'pending', paymentStatus: 'pending' });
  const result = await escrowService.updateEscrowOnPaymentCapture(e.razorpayOrderId, 'pay_x', 'failed', {
    error_description: 'Card declined',
    error_code: 'BAD_REQUEST_ERROR',
  });
  assert.equal(result.success, true);
  assert.notEqual(result.ignored, true);
  const row = escrowRow('E1');
  assert.equal(row.status, 'cancelled');
  assert.equal(row.paymentStatus, 'failed');
  assert.equal(row.errorMessage, 'Card declined');
});

test('C: failure racing a capture loses (conditional update), capture is preserved', async () => {
  const e = seedEscrow({ escrowId: 'E1', status: 'pending', paymentStatus: 'pending' });
  const realFindUnique = fakeDb.escrow.findUnique;
  let first = true;
  fakeDb.escrow.findUnique = async (args: Row) => {
    const snapshot = await realFindUnique(args);
    if (first) {
      first = false;
      // Capture lands between the failure handler's read and its write.
      Object.assign(escrowRow('E1'), { status: 'held', paymentStatus: 'captured', razorpayPaymentId: 'pay_ok', updatedAt: now() });
    }
    return snapshot;
  };
  try {
    const result = await escrowService.updateEscrowOnPaymentCapture(e.razorpayOrderId, 'pay_bad', 'failed', {});
    assert.equal(result.ignored, true);
  } finally {
    fakeDb.escrow.findUnique = realFindUnique;
  }
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(escrowRow('E1').paymentStatus, 'captured');
});

// ── E / F: duplicate order protection ────────────────────────────────────────
let orderSeq = 0;
let createEscrowCalls = 0;
TaskServiceClient.quoteRecurringVisitPayment = async () => ({
  ok: true,
  quote: { amount: 500, category: 'cleaning', categorySlug: 'home-cleaning' },
});
feeCalculationService.calculatePosterFees = async () => ({ platformFeeTotal: 50 });
escrowService.createEscrow = async (params: Row) => {
  createEscrowCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 40)); // Razorpay round-trip
  orderSeq += 1;
  const order = { id: `order_new_${orderSeq}`, amount: params.amount * 100, currency: 'INR', keyId: 'rzp_live_dummy', paymentEnvironment: 'live' };
  const row = seedEscrow({
    escrowId: `esc_new_${orderSeq}`,
    razorpayOrderId: order.id,
    razorpayOrderData: order,
    status: 'pending',
    paymentStatus: 'pending',
    posterUid: params.posterUid,
    performerUid: params.performerUid,
    applicationId: params.applicationId ?? null,
    metadata: {
      ...params.metadata,
      visitBudgetRupees: params.taskAmount,
      originalAmountRupees: params.amount,
      paymentEnvironment: 'live',
    },
  });
  return { success: true, escrow: { escrowId: row.escrowId }, order };
};

async function createVisitOrder(overrides: Row = {}) {
  const res: Row = {
    statusCode: 0,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  await EscrowController.createEscrow(
    {
      headers: { 'x-user-id': 'poster-uid' },
      body: {
        taskId: PARENT,
        applicationId: 'app-1',
        posterUid: 'poster-uid',
        performerUid: HELPER,
        amount: 550,
        taskAmount: 500,
        metadata: { visitId: V1, parentTaskId: PARENT },
        ...overrides,
      },
    },
    res,
  );
  return res;
}
const activeOrdersForV1 = () =>
  fakeDb.escrow.rows.filter((r: Row) => visitOf(r) === V1 && (r.status === 'pending' || r.status === 'held'));

test('E: concurrent duplicate order requests produce exactly one active order', async () => {
  createEscrowCalls = 0;
  const [a, b, c] = await Promise.all([createVisitOrder(), createVisitOrder(), createVisitOrder()]);
  assert.equal(createEscrowCalls, 1, 'Razorpay order created once');
  assert.equal(activeOrdersForV1().length, 1);
  const orderIds = new Set([a, b, c].map((r) => r.body.order.id));
  assert.equal(orderIds.size, 1, 'every caller gets the same checkout order');
  assert.deepEqual([a, b, c].map((r) => r.statusCode).sort(), [200, 200, 201]);
});

test('E: a changed order request supersedes the old unpaid order (still one active)', async () => {
  const first = await createVisitOrder();
  const second = await createVisitOrder({ metadata: { visitId: V1, parentTaskId: PARENT, couponCode: 'SAVE10' } });
  assert.notEqual(second.body.order.id, first.body.order.id);
  assert.equal(activeOrdersForV1().length, 1);
  const old = fakeDb.escrow.rows.find((r: Row) => r.razorpayOrderId === first.body.order.id);
  assert.equal(old.status, 'cancelled');
  assert.equal(old.errorCode, 'SUPERSEDED');
});

test('E: a paid visit returns alreadyPaid and creates no order', async () => {
  seedEscrow({ escrowId: 'E1' });
  createEscrowCalls = 0;
  const res = await createVisitOrder();
  assert.equal(res.body.alreadyPaid, true);
  assert.equal(createEscrowCalls, 0);
});

test('E: an in-flight authorized payment is not superseded and no second order is created', async () => {
  seedEscrow({ escrowId: 'E1', status: 'pending', paymentStatus: 'authorized' });
  createEscrowCalls = 0;
  const res = await createVisitOrder();
  assert.equal(res.body.alreadyPaid, true);
  assert.equal(createEscrowCalls, 0);
  assert.equal(escrowRow('E1').status, 'pending');
});

test('E: a stale lock row from a crashed instance expires', async () => {
  fakeDb.paymentOrderIdempotency.rows.push({
    id: 'stale',
    idempotencyKey: `recurring-visit-order-lock:${PARENT}:${V1}`,
    razorpayOrderId: 'recurring-visit-order-lock',
    orderPayload: {},
    createdAt: new Date(Date.now() - RECURRING_VISIT_ORDER_LOCK_TTL_MS - 1000),
  });
  const res = await createVisitOrder();
  assert.equal(res.statusCode, 201);
  assert.equal(fakeDb.paymentOrderIdempotency.rows.length, 0, 'lock released');
});

test('F: retry after a failed payment creates a new order', async () => {
  const first = await createVisitOrder();
  const firstRow = fakeDb.escrow.rows.find((r: Row) => r.razorpayOrderId === first.body.order.id);
  await escrowService.updateEscrowOnPaymentCapture(firstRow.razorpayOrderId, 'pay_x', 'failed', {});
  const retry = await createVisitOrder();
  assert.equal(retry.statusCode, 201);
  assert.notEqual(retry.body.order.id, first.body.order.id);
  assert.equal(activeOrdersForV1().length, 1);
});

test('F: retry after a refunded or cancelled payment creates a new order', async () => {
  seedEscrow({ escrowId: 'E1', status: 'refunded' });
  seedEscrow({ escrowId: 'E0', status: 'cancelled', paymentStatus: 'pending' });
  const retry = await createVisitOrder();
  assert.equal(retry.statusCode, 201);
  assert.ok(retry.body.order.id);
});

// ── M / B: re-tag safety ─────────────────────────────────────────────────────
const reassign = (escrowId: string, fromVisitId: string, toVisitId: string) =>
  escrowService.reassignRecurringVisitEscrow({ escrowId, taskId: PARENT, fromVisitId, toVisitId });

test('M: re-tag rejected when the target visit already has its own active payment', async () => {
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  seedEscrow({ escrowId: 'E2', visitId: V2 });
  const result = await reassign('E1', V1, V2);
  assert.equal(result.success, false);
  assert.match(result.error, /already has an active payment/);
  assert.equal(visitOf(escrowRow('E1')), V1);
});

test('M: re-tag allowed when the target only has a refunded payment; repeat is idempotent', async () => {
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  seedEscrow({ escrowId: 'E2', visitId: V2, status: 'refunded' });
  assert.equal((await reassign('E1', V1, V2)).success, true);
  assert.equal(visitOf(escrowRow('E1')), V2);
  assert.equal((await reassign('E1', V1, V2)).success, true, 'retry of the same move succeeds');
  assert.equal(visitOf(escrowRow('E1')), V2);
});

test('B/N: refunded, released, failed or another visit\'s payments are never moved', async () => {
  seedEscrow({ escrowId: 'R', visitId: V1, status: 'refunded' });
  seedEscrow({ escrowId: 'L', visitId: V1, status: 'released' });
  seedEscrow({ escrowId: 'F', visitId: V1, status: 'cancelled', paymentStatus: 'failed' });
  for (const id of ['R', 'L', 'F']) {
    const result = await reassign(id, V1, V2);
    assert.equal(result.success, false, `${id} must not move`);
    assert.equal(visitOf(escrowRow(id)), V1);
  }
  seedEscrow({ escrowId: 'E3', visitId: 'visit-uuid-3' });
  const other = await reassign('E3', V1, V2);
  assert.equal(other.success, false);
  assert.equal(visitOf(escrowRow('E3')), 'visit-uuid-3');
});

test('Re-tag write is conditional: a concurrent change is not overwritten', async () => {
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const realFindFirst = fakeDb.escrow.findFirst;
  fakeDb.escrow.findFirst = async (args: Row) => {
    const snapshot = await realFindFirst(args);
    if (snapshot?.escrowId === 'E1') {
      const row = escrowRow('E1');
      row.metadata = { ...row.metadata, visitId: 'visit-uuid-3' };
      row.updatedAt = now();
    }
    return snapshot;
  };
  try {
    const result = await reassign('E1', V1, V2);
    assert.equal(result.success, false);
  } finally {
    fakeDb.escrow.findFirst = realFindFirst;
  }
  assert.equal(visitOf(escrowRow('E1')), 'visit-uuid-3');
});

// ── J / K / L / N: payout authorization ──────────────────────────────────────
const payout = (params: Row) =>
  processTaskCompletionPayout({ performerUid: HELPER, amount: 500, taskTitle: 'Visit', ...params });

test('J: recurring child payout rejected without a valid visit payment (no direct payout)', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  const result = await payout({ taskId: CHILD_V1 });
  assert.equal(result.success, false);
  assert.match(result.error, /No active payment/);
  assert.equal(fakeDb.payout.rows.length, 0);

  // Same with an explicit visit id but no escrow on the Work.
  const explicit = await payout({ taskId: CHILD_V1, visitId: V1, parentTaskId: PARENT });
  assert.equal(explicit.success, false);
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('K: child belongs to V2 but the payment belongs to V1 → rejected', async () => {
  seedHelperBank();
  seedChild(CHILD_V2, V2);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const spoofed = await payout({ taskId: CHILD_V2, visitId: V1, parentTaskId: PARENT });
  assert.equal(spoofed.success, false);
  assert.match(spoofed.error, /does not match/);
  const implicit = await payout({ taskId: CHILD_V2 });
  assert.equal(implicit.success, false);
  assert.match(implicit.error, /No active payment/);
  assert.equal(escrowRow('E1').status, 'held', 'V1 payment untouched');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('L: correct visit, held escrow and assigned helper → payout succeeds and claims the escrow', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  seedEscrow({ escrowId: 'E2', visitId: V2 });
  const result = await payout({ taskId: CHILD_V1, visitId: V1, parentTaskId: PARENT });
  assert.equal(result.success, true, result.error);
  assert.equal(escrowRow('E1').status, 'released');
  assert.equal(escrowRow('E2').status, 'held', 'other visit payment untouched');
  assert.equal(fakeDb.payout.rows.length, 1);
  assert.equal(fakeDb.payout.rows[0].escrowId, escrowRow('E1').id);

  const repeat = await payout({ taskId: CHILD_V1, visitId: V1, parentTaskId: PARENT });
  assert.equal(repeat.success, true, 'retry returns the existing payout');
  assert.equal(fakeDb.payout.rows.length, 1);
});

test('L: helper not assigned to the visit is rejected', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1, 'another-helper');
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const result = await payout({ taskId: CHILD_V1 });
  assert.equal(result.success, false);
  assert.match(result.error, /not assigned/);
  assert.equal(escrowRow('E1').status, 'held');
});

test('N: refunded payment cannot be the payout source', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E1', visitId: V1, status: 'refunded' });
  const result = await payout({ taskId: CHILD_V1 });
  assert.equal(result.success, false);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Non-recurring payout still uses the task-level escrow path', async () => {
  seedHelperBank();
  const taskId = new mongoose.Types.ObjectId().toString();
  taskDocs.set(taskId, { _id: taskId, assigneeUid: HELPER });
  seedEscrow({ escrowId: 'EN', taskId, visitId: null, metadata: {} });
  const result = await payout({ taskId });
  assert.equal(result.success, true, result.error);
  assert.equal(escrowRow('EN').status, 'released');
});

// ── Recurring payout hardening A–K ───────────────────────────────────────────
const OTHER_HELPER = 'helper-2';
const ledgerService = require('./ledgerService');

function seedBank(uid: string): void {
  fakeDb.userPaymentProfile.rows.push({ id: `upp-${uid}`, userId: uid, defaultBankAccountId: `bank-${uid}` });
  fakeDb.bankAccount.rows.push({ id: `bank-${uid}`, userId: uid, accountNumber: '1234567890', ifscCode: 'TEST0000001', verificationRef: null });
}
/** Recurring Work (collection-backed plan) with RecurringVisit rows. */
function seedPlan(visits: Array<[string, string?]> = [[V1]]): void {
  taskDocs.set(PARENT, {
    _id: PARENT,
    recurringPlan: { planVersion: 2, visitStorage: 'collection', taskerUid: HELPER },
  });
  for (const [visitId, assigneeUid = HELPER] of visits) {
    visitDocs.push({ parentTaskId: new mongoose.Types.ObjectId(PARENT), visitId, assigneeUid });
  }
}
async function callPayoutEndpoint(body: Row, headers: Row): Promise<Row> {
  const res: Row = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Row) {
      this.body = payload;
      return this;
    },
  };
  await PayoutController.processTaskCompletionPayout({ body, headers } as any, res as any);
  return res;
}
const asUser = (uid: string) => ({ 'x-service-name': 'api-gateway', 'x-user-id': uid });
const asTaskService = { 'x-service-name': 'task-service' };
const visitPayoutBody = (overrides: Row = {}) => ({
  taskId: PARENT,
  visitId: V1,
  performerUid: HELPER,
  amount: 500,
  taskTitle: 'Visit',
  ...overrides,
});

test('Payout A: assigned helper, correct visit, one held payment → paid from that payment only', async () => {
  seedHelperBank();
  seedPlan([[V1], [V2]]);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  seedEscrow({ escrowId: 'E2', visitId: V2 });
  const res = await callPayoutEndpoint(visitPayoutBody(), asUser(HELPER));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.success, true);
  assert.equal(escrowRow('E1').status, 'released');
  assert.equal(escrowRow('E2').status, 'held', 'other visit payment untouched');
  assert.equal(fakeDb.payout.rows.length, 1);
  assert.equal(fakeDb.payout.rows[0].escrowId, escrowRow('E1').id);
  assert.equal(Number(fakeDb.payout.rows[0].amount), 500);

  // Trusted internal completion of the child task pays out the same way.
  seedChild(CHILD_V2, V2);
  const internal = await callPayoutEndpoint(
    { taskId: CHILD_V2, performerUid: HELPER, amount: 500, visitId: V2, parentTaskId: PARENT },
    asTaskService,
  );
  assert.equal(internal.body.success, true, JSON.stringify(internal.body));
  assert.equal(escrowRow('E2').status, 'released');
});

test('Payout B: caller who is not the performer (or has no identity) is rejected', async () => {
  seedHelperBank();
  seedPlan();
  seedEscrow({ escrowId: 'E1', visitId: V1 });

  const impersonation = await callPayoutEndpoint(visitPayoutBody(), asUser('intruder-uid'));
  assert.equal(impersonation.statusCode, 403);
  const anonymousGateway = await callPayoutEndpoint(visitPayoutBody(), { 'x-service-name': 'api-gateway' });
  assert.equal(anonymousGateway.statusCode, 401);
  const unnamedService = await callPayoutEndpoint(visitPayoutBody(), {});
  assert.equal(unnamedService.statusCode, 401, 'unknown service is not trusted as internal');

  // Lower-level service enforces the same rule.
  const direct = await payout({ taskId: PARENT, visitId: V1, callerUid: 'intruder-uid' });
  assert.equal(direct.success, false);
  assert.match(direct.error, /assigned helper/);

  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout C: recurring Work without a visit id is rejected (no newest-escrow fallback)', async () => {
  seedHelperBank();
  seedPlan();
  seedEscrow({ escrowId: 'E1', visitId: V1 });

  const user = await callPayoutEndpoint(visitPayoutBody({ visitId: undefined }), asUser(HELPER));
  assert.equal(user.statusCode, 400);
  assert.match(user.body.error, /visit is required/);
  const internal = await payout({ taskId: PARENT });
  assert.equal(internal.success, false);
  assert.match(internal.error, /visit is required/);

  // Payment ledger alone marks the Work as recurring even if the task document is missing.
  taskDocs.delete(PARENT);
  const noTaskDoc = await payout({ taskId: PARENT });
  assert.equal(noTaskDoc.success, false);

  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout D: visit that does not belong to the Work / task is rejected', async () => {
  seedHelperBank();
  seedPlan([[V1]]);
  seedEscrow({ escrowId: 'EF', visitId: 'visit-foreign' });
  const foreign = await payout({ taskId: PARENT, visitId: 'visit-foreign', callerUid: HELPER });
  assert.equal(foreign.success, false);
  assert.match(foreign.error, /does not belong/);

  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const otherPlan = await payout({ taskId: PARENT, visitId: V1, parentTaskId: CHILD_V1 });
  assert.equal(otherPlan.success, false);
  assert.match(otherPlan.error, /does not match/);

  seedChild(CHILD_V2, V2);
  const childSpoof = await payout({ taskId: CHILD_V2, visitId: V1, parentTaskId: PARENT, callerUid: HELPER });
  assert.equal(childSpoof.success, false);
  assert.match(childSpoof.error, /does not match/);

  // Visit hints on an ordinary task never select a visit payment.
  const plainTask = new mongoose.Types.ObjectId().toString();
  taskDocs.set(plainTask, { _id: plainTask, assigneeUid: HELPER });
  const hinted = await payout({ taskId: plainTask, visitId: V1, parentTaskId: PARENT });
  assert.equal(hinted.success, false);

  assert.equal(escrowRow('EF').status, 'held');
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout E: requested amount above the held payment never pays more than the held amount', async () => {
  seedHelperBank();
  seedPlan();
  seedEscrow({ escrowId: 'E1', visitId: V1 }); // taskAmount ₹500
  const realRedeem = extraCoinsService.applyExtraCoinsForPayout;
  extraCoinsService.applyExtraCoinsForPayout = async ({ maxRedeemRupees }: Row) => ({
    success: true,
    redeemedCoins: maxRedeemRupees.toString(),
    redeemedRupees: maxRedeemRupees.toString(),
    sources: [],
  });
  try {
    const res = await callPayoutEndpoint(
      visitPayoutBody({ amount: 700, useExtraCoins: true, requestedCoinRedeemRupees: 900 }),
      asUser(HELPER),
    );
    assert.equal(res.body.success, true, JSON.stringify(res.body));
    const row = fakeDb.payout.rows[0];
    assert.equal(Number(row.amount), 500, 'gross is the held amount, not the requested ₹700');
    assert.ok(Number(row.netAmount) <= 500, `net ${row.netAmount} must not exceed held ₹500`);
  } finally {
    extraCoinsService.applyExtraCoinsForPayout = realRedeem;
  }
});

test('Payout E: a coin credit that would lift net above the held payment is rejected before release', async () => {
  seedHelperBank();
  seedPlan();
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const realRedeem = extraCoinsService.applyExtraCoinsForPayout;
  extraCoinsService.applyExtraCoinsForPayout = async () => ({
    success: true,
    redeemedCoins: '1000',
    redeemedRupees: '1000',
    sources: [],
  });
  try {
    const result = await payout({ taskId: PARENT, visitId: V1, useExtraCoins: true, requestedCoinRedeemRupees: 50 });
    assert.equal(result.success, false);
    assert.match(result.error, /exceeds the held payment/);
  } finally {
    extraCoinsService.applyExtraCoinsForPayout = realRedeem;
  }
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout F: Quick Commerce flags never skip recurring visit validation', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E2', visitId: V2 });
  const internal = await payout({ taskId: CHILD_V1, source: 'quick_commerce', isQuickCommerce: true });
  assert.equal(internal.success, false);
  assert.match(internal.error, /No active payment/);
  assert.equal(escrowRow('E2').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0, 'no direct payout from client amount');

  seedPlan();
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const user = await callPayoutEndpoint(
    visitPayoutBody({ visitId: undefined, source: 'quick_commerce', isQuickCommerce: true }),
    asUser(HELPER),
  );
  assert.equal(user.statusCode, 400);
  assert.equal(escrowRow('E1').status, 'held');

  // A valid visit payout with QC flags still goes through visit validation and is not labelled QC.
  const valid = await payout({ taskId: CHILD_V1, source: 'quick_commerce', isQuickCommerce: true });
  assert.equal(valid.success, true, valid.error);
  assert.equal(escrowRow('E1').status, 'released');
  assert.notEqual(fakeDb.payout.rows[0].source, 'quick_commerce');
});

test('Payout G: multiple held payments for one visit → rejected, nothing released', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  seedEscrow({ escrowId: 'E2', visitId: V1 });
  const result = await payout({ taskId: CHILD_V1 });
  assert.equal(result.success, false);
  assert.match(result.error, /Multiple active payments/);

  seedPlan();
  const user = await callPayoutEndpoint(visitPayoutBody(), asUser(HELPER));
  assert.equal(user.statusCode, 400);

  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(escrowRow('E2').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout H: concurrent payout requests claim the visit payment exactly once', async () => {
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  let claims = 0;
  const realUpdateMany = fakeDb.escrow.updateMany;
  fakeDb.escrow.updateMany = async (args: Row) => {
    const result = await realUpdateMany.call(fakeDb.escrow, args);
    if (args?.where?.status === 'held' && args?.data?.status === 'released') claims += result.count;
    return result;
  };
  let results: Row[];
  try {
    results = await Promise.all(Array.from({ length: 5 }, () => payout({ taskId: CHILD_V1 })));
  } finally {
    fakeDb.escrow.updateMany = realUpdateMany;
  }
  assert.equal(claims, 1);
  assert.equal(fakeDb.payout.rows.length, 1);
  assert.equal(escrowRow('E1').status, 'released');
  const winners = results.filter((r) => r.success);
  assert.ok(winners.length >= 1);
  for (const r of winners) assert.equal(r.payout.payoutId, fakeDb.payout.rows[0].payoutId);
  for (const r of results.filter((x) => !x.success)) assert.match(r.error, /escrow state/);
});

test('Payout I: helper not assigned to the visit (or task) is rejected even when requesting for self', async () => {
  seedHelperBank();
  seedBank(OTHER_HELPER);
  seedPlan([[V1, HELPER]]);
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  const res = await callPayoutEndpoint(visitPayoutBody({ performerUid: OTHER_HELPER }), asUser(OTHER_HELPER));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /not assigned/);
  assert.equal(escrowRow('E1').status, 'held');

  const plainTask = new mongoose.Types.ObjectId().toString();
  taskDocs.set(plainTask, { _id: plainTask, assigneeUid: HELPER });
  seedEscrow({ escrowId: 'EN', taskId: plainTask, visitId: null, metadata: {} });
  const nonRecurring = await callPayoutEndpoint(
    { taskId: plainTask, performerUid: OTHER_HELPER, amount: 500 },
    asUser(OTHER_HELPER),
  );
  assert.equal(nonRecurring.statusCode, 400);
  assert.match(nonRecurring.body.error, /not assigned/);
  assert.equal(escrowRow('EN').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout J: no held payment → rejected, never a direct payout', async () => {
  seedHelperBank();
  seedPlan();
  const recurring = await callPayoutEndpoint(visitPayoutBody(), asUser(HELPER));
  assert.equal(recurring.statusCode, 400);
  assert.match(recurring.body.error, /No active payment/);

  const plainTask = new mongoose.Types.ObjectId().toString();
  taskDocs.set(plainTask, { _id: plainTask, assigneeUid: HELPER });
  const user = await callPayoutEndpoint({ taskId: plainTask, performerUid: HELPER, amount: 500 }, asUser(HELPER));
  assert.equal(user.statusCode, 400);
  assert.match(user.body.error, /No held payment/);

  // Task store unavailable: visit hints cannot be verified, so nothing is paid.
  seedEscrow({ escrowId: 'E1', visitId: V1 });
  mongoReady = false;
  const unverifiable = await payout({ taskId: CHILD_V1, visitId: V1, parentTaskId: PARENT });
  assert.equal(unverifiable.success, false);
  assert.match(unverifiable.error, /Unable to verify/);
  assert.equal(escrowRow('E1').status, 'held');

  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Payout K: refunded visit payment cannot be paid out by any path', async () => {
  seedHelperBank();
  seedPlan();
  const refunded = seedEscrow({ escrowId: 'E1', visitId: V1, status: 'refunded' });
  const res = await callPayoutEndpoint(visitPayoutBody(), asUser(HELPER));
  assert.equal(res.statusCode, 400);
  const legacy = await processPayout({
    razorpayOrderId: refunded.razorpayOrderId,
    performerUid: HELPER,
    accountNumber: '1234567890',
    ifscCode: 'TEST0000001',
    accountHolderName: 'Helper',
  });
  assert.equal(legacy.success, false);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.equal(fakeDb.payout.rows.length, 0);
});

// ── processPayout (legacy release by order id) ───────────────────────────────
const bankDetails = { accountNumber: '1234567890', ifscCode: 'TEST0000001', accountHolderName: 'Helper' };

test('processPayout refuses recurring visit escrows (visit validation cannot be bypassed)', async () => {
  const e = seedEscrow({ escrowId: 'E1', visitId: V1 });
  const result = await processPayout({ razorpayOrderId: e.razorpayOrderId, performerUid: HELPER, ...bankDetails });
  assert.equal(result.success, false);
  assert.match(result.error, /visit completion/);
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('processPayout claims the escrow atomically: concurrent calls transfer once; failed transfer re-holds', async () => {
  const e = seedEscrow({ escrowId: 'EP', taskId: 'task-legacy', visitId: null, metadata: {} });
  fakeDb.ledger.rows.push({
    id: 'l1',
    escrowId: e.id,
    amount: new Prisma.Decimal('550'),
    balanceAfter: new Prisma.Decimal('550'),
    createdAt: now(),
  });
  const realBalance = ledgerService.getEscrowBalance;
  const realTransfer = mockBankTransferService.transferToBank;
  let transfers = 0;
  let failNext = false;
  ledgerService.getEscrowBalance = async () => ({ success: true, balance: new Prisma.Decimal('550') });
  mockBankTransferService.transferToBank = async () => {
    transfers += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failNext) return { success: false, status: 'failed', errorMessage: 'bank down' };
    return { success: true, status: 'completed', transactionId: `txn_${transfers}`, transferredAt: new Date() };
  };
  try {
    failNext = true;
    const failed = await processPayout({ razorpayOrderId: e.razorpayOrderId, performerUid: HELPER, ...bankDetails });
    assert.equal(failed.success, false);
    assert.equal(escrowRow('EP').status, 'held', 'failed transfer hands the escrow back');

    failNext = false;
    transfers = 0;
    const results = await Promise.all([
      processPayout({ razorpayOrderId: e.razorpayOrderId, performerUid: HELPER, ...bankDetails }),
      processPayout({ razorpayOrderId: e.razorpayOrderId, performerUid: HELPER, ...bankDetails }),
    ]);
    assert.equal(results.filter((r: Row) => r.success).length, 1);
    assert.equal(transfers, 1, 'only the claim winner moves money');
    assert.equal(escrowRow('EP').status, 'released');
    assert.equal(fakeDb.payout.rows.filter((p: Row) => p.status === 'completed').length, 1);
  } finally {
    ledgerService.getEscrowBalance = realBalance;
    mockBankTransferService.transferToBank = realTransfer;
  }
});

// ── Duplicate captured-payment protection A–J ────────────────────────────────
const paymentService = require('./paymentService');
const {
  DUPLICATE_VISIT_PAYMENT_CODE,
  retryPendingDuplicateVisitPaymentRefunds,
} = require('./recurringVisitCaptureService');

/** Razorpay stand-in: captured ₹550 payments, refunds recorded per payment id. */
let razorpayRefunds: Array<{ paymentId: string; paise: number }> = [];
let refundedPaise = new Map<string, number>();
let refundApiDown = false;
let captureNotifications: Row[] = [];
paymentService.resolvePaymentEnvironmentForPayment = async () => 'live';
paymentService.getPaymentDetails = async (paymentId: string) => ({
  success: true,
  payment: { id: paymentId, amount: 55000, amount_refunded: refundedPaise.get(paymentId) ?? 0, status: 'captured' },
});
paymentService.createRefundAmountPaise = async (paymentId: string, paise: number) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (refundApiDown) return { success: false, error: 'Razorpay unavailable' };
  razorpayRefunds.push({ paymentId, paise });
  refundedPaise.set(paymentId, (refundedPaise.get(paymentId) ?? 0) + paise);
  return { success: true, refund: { id: `rfnd_${razorpayRefunds.length}`, status: 'processed', amount: paise } };
};
paymentNotificationService.notifyRefundInitiated = async () => undefined;
paymentNotificationService.notifyPaymentReceived = async () => undefined;
TaskServiceClient.notifyRecurringVisitPaymentCaptured = async (params: Row) => {
  captureNotifications.push(params);
  return { success: true };
};
function resetRazorpay(): void {
  razorpayRefunds = [];
  refundedPaise = new Map();
  refundApiDown = false;
  captureNotifications = [];
}
const seedOrder = (escrowId: string, overrides: Row = {}) =>
  seedEscrow({ escrowId, status: 'pending', paymentStatus: 'pending', razorpayPaymentId: null, ...overrides });
const capture = (row: Row, paymentId: string) =>
  escrowService.updateEscrowOnPaymentCapture(row.razorpayOrderId, paymentId, 'captured', {
    id: paymentId,
    amount: 55000,
    status: 'captured',
    method: 'upi',
  });
const heldForVisit = (visitId: string, taskId = PARENT) =>
  fakeDb.escrow.rows.filter((r: Row) => r.taskId === taskId && visitOf(r) === visitId && r.status === 'held');
const refundRowsFor = (paymentId: string) => fakeDb.refund.rows.filter((r: Row) => r.paymentId === paymentId);
const paymentLedgerFor = (row: Row) =>
  fakeDb.ledger.rows.filter((l: Row) => l.escrowId === row.id && l.type === 'payment');

test('Capture A: first capture for a visit becomes its single held payment (unchanged)', async () => {
  resetRazorpay();
  const order = seedOrder('O1');
  const result = await capture(order, 'pay_1');
  assert.equal(result.success, true, result.error);
  assert.notEqual(result.duplicate, true);
  const row = escrowRow('O1');
  assert.equal(row.status, 'held');
  assert.equal(row.paymentStatus, 'captured');
  assert.equal(row.razorpayPaymentId, 'pay_1');
  assert.equal(heldForVisit(V1).length, 1);
  assert.equal(paymentLedgerFor(row).length, 1);
  assert.equal(captureNotifications.length, 1, 'task-service told about the visit payment');
  assert.equal(razorpayRefunds.length, 0);
  assert.equal(fakeDb.paymentOrderIdempotency.rows.length, 0, 'visit lock released');
});

test('Capture B: second captured payment for an already-paid visit is refunded and never held', async () => {
  resetRazorpay();
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB');
  const result = await capture(orderB, 'pay_B');
  assert.equal(result.success, true, result.error);
  assert.equal(result.duplicate, true);
  assert.equal(result.refundStatus, 'refunded');

  const b = escrowRow('OB');
  assert.equal(b.status, 'refunded');
  assert.equal(b.paymentStatus, 'captured');
  assert.equal(b.errorCode, DUPLICATE_VISIT_PAYMENT_CODE);
  assert.deepEqual(b.metadata.duplicateVisitPayment.winnerEscrowIds, ['EA']);
  assert.deepEqual(razorpayRefunds, [{ paymentId: 'pay_B', paise: 55000 }]);
  assert.equal(refundRowsFor('pay_B').length, 1);
  assert.equal(captureNotifications.length, 0, 'duplicate is never bound to the visit');

  const a = escrowRow('EA');
  assert.equal(a.status, 'held');
  assert.equal(a.razorpayPaymentId, 'pay_A');
  assert.equal(heldForVisit(V1).length, 1);

  const paid = await payout({ taskId: CHILD_V1 });
  assert.equal(paid.success, true, paid.error);
  assert.equal(fakeDb.payout.rows[0].escrowId, a.id, 'only the winner is eligible for payout');
});

test('Capture C: a cancelled (superseded) order captured later is a duplicate and refunded', async () => {
  resetRazorpay();
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB', { status: 'cancelled', errorCode: 'SUPERSEDED' });
  const result = await capture(orderB, 'pay_B');
  assert.equal(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'refunded');
  assert.equal(escrowRow('OB').errorCode, DUPLICATE_VISIT_PAYMENT_CODE);
  assert.equal(razorpayRefunds.length, 1);
  const a = escrowRow('EA');
  assert.equal(a.status, 'held');
  assert.equal(a.razorpayPaymentId, 'pay_A');

  // With no bound payment on the visit, a late capture of a cancelled order still pays the visit.
  const orderC = seedOrder('OC', { visitId: V2, status: 'cancelled', errorCode: 'SUPERSEDED' });
  const paidV2 = await capture(orderC, 'pay_C');
  assert.notEqual(paidV2.duplicate, true);
  assert.equal(escrowRow('OC').status, 'held');
});

test('Capture D: concurrent captures of two orders for one visit produce exactly one winner', async () => {
  resetRazorpay();
  const o1 = seedOrder('O1');
  const o2 = seedOrder('O2');
  const results = await Promise.all([capture(o1, 'pay_1'), capture(o2, 'pay_2')]);
  assert.ok(results.every((r: Row) => r.success));
  assert.equal(results.filter((r: Row) => r.duplicate === true).length, 1);
  assert.equal(heldForVisit(V1).length, 1);
  const loser = [escrowRow('O1'), escrowRow('O2')].find((r) => r.status !== 'held');
  assert.equal(loser.status, 'refunded');
  assert.equal(loser.errorCode, DUPLICATE_VISIT_PAYMENT_CODE);
  assert.equal(razorpayRefunds.length, 1);
  assert.equal(razorpayRefunds[0].paymentId, loser.razorpayPaymentId);
  assert.equal(captureNotifications.length, 1);
});

test('Capture E: repeated capture callbacks change nothing (winner and duplicate)', async () => {
  resetRazorpay();
  const o1 = seedOrder('O1');
  for (let i = 0; i < 3; i += 1) assert.equal((await capture(o1, 'pay_1')).success, true);
  assert.equal(escrowRow('O1').status, 'held');
  assert.equal(paymentLedgerFor(escrowRow('O1')).length, 1, 'one payment ledger entry');
  assert.equal(fakeDb.escrow.rows.length, 1, 'no extra escrow');

  const o2 = seedOrder('O2');
  await capture(o2, 'pay_2');
  await Promise.all([capture(o2, 'pay_2'), capture(o2, 'pay_2'), capture(o2, 'pay_2')]);
  await capture(o2, 'pay_2');
  assert.equal(razorpayRefunds.length, 1, 'refund issued once');
  assert.equal(refundRowsFor('pay_2').length, 1);
  assert.equal(paymentLedgerFor(escrowRow('O2')).length, 1);
  assert.equal(escrowRow('O2').status, 'refunded');
  assert.equal(escrowRow('O1').status, 'held', 'winner unchanged');
  assert.equal(escrowRow('O1').razorpayPaymentId, 'pay_1');
  assert.equal(fakeDb.payout.rows.length, 0);
});

test('Capture F: a failed duplicate refund is retried safely and the payment never becomes payable', async () => {
  resetRazorpay();
  seedHelperBank();
  seedPlan();
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB');
  refundApiDown = true;
  const first = await capture(orderB, 'pay_B');
  assert.equal(first.duplicate, true);
  assert.equal(first.refundStatus, 'retry_scheduled');
  const b = escrowRow('OB');
  assert.equal(b.status, 'cancelled', 'duplicate is not held while its refund is pending');
  assert.equal(b.errorCode, DUPLICATE_VISIT_PAYMENT_CODE);
  const job = fakeDb.jobQueue.rows.find((j: Row) => j.entityId === b.id);
  assert.equal(job.jobType, 'refund_retry');
  assert.equal(job.status, 'pending');
  assert.match(job.lastError, /Razorpay unavailable/);

  // Not payable through any path while waiting for the refund.
  const legacy = await processPayout({ razorpayOrderId: b.razorpayOrderId, performerUid: HELPER, ...bankDetails });
  assert.equal(legacy.success, false);
  assert.equal(heldForVisit(V1).length, 1);

  // A callback retry while Razorpay is still down does not double up.
  await capture(orderB, 'pay_B');
  assert.equal(razorpayRefunds.length, 0);
  assert.equal(escrowRow('OB').status, 'cancelled');

  refundApiDown = false;
  job.nextRetryAt = new Date(0);
  const retried = await retryPendingDuplicateVisitPaymentRefunds();
  assert.deepEqual(retried, { refunded: 1, pending: 0 });
  assert.equal(escrowRow('OB').status, 'refunded');
  assert.equal(job.status, 'completed');

  await capture(orderB, 'pay_B');
  assert.equal(await retryPendingDuplicateVisitPaymentRefunds().then((r: Row) => r.refunded), 0);
  assert.equal(razorpayRefunds.length, 1, 'exactly one refund');
  assert.equal(refundRowsFor('pay_B').length, 1);

  const paid = await callPayoutEndpoint(visitPayoutBody(), asUser(HELPER));
  assert.equal(paid.body.success, true, JSON.stringify(paid.body));
  assert.equal(fakeDb.payout.rows[0].escrowId, escrowRow('EA').id);
});

test('Capture G: after the winner is refunded, a replacement capture becomes the only held payment', async () => {
  resetRazorpay();
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A', status: 'refunded' });
  const orderB = seedOrder('OB');
  const result = await capture(orderB, 'pay_B');
  assert.notEqual(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'held');
  assert.equal(escrowRow('EA').status, 'refunded');
  assert.equal(heldForVisit(V1).length, 1);
  assert.equal(razorpayRefunds.length, 0);
  assert.equal(captureNotifications.length, 1);

  // A visit that was already paid out is not paid again.
  const orderC = seedOrder('OC', { visitId: V2 });
  seedEscrow({ escrowId: 'ER', visitId: V2, status: 'released', razorpayPaymentId: 'pay_R' });
  const late = await capture(orderC, 'pay_C');
  assert.equal(late.duplicate, true);
  assert.equal(escrowRow('ER').status, 'released');
});

test('Capture H: legacy visit with several held payments – new capture refunded, old ones untouched, payout blocked', async () => {
  resetRazorpay();
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', razorpayPaymentId: 'pay_2' });
  const orderC = seedOrder('OC');
  const result = await capture(orderC, 'pay_3');
  assert.equal(result.duplicate, true);
  assert.deepEqual(escrowRow('OC').metadata.duplicateVisitPayment.winnerEscrowIds.sort(), ['E1', 'E2']);
  assert.deepEqual(razorpayRefunds.map((r) => r.paymentId), ['pay_3']);
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(escrowRow('E2').status, 'held');
  const blocked = await payout({ taskId: CHILD_V1 });
  assert.equal(blocked.success, false);
  assert.match(blocked.error, /Multiple active payments/);
});

test('Capture I: payments for different visits are never duplicates of each other', async () => {
  resetRazorpay();
  seedEscrow({ escrowId: 'EA', visitId: V1, razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB', { visitId: V2 });
  const result = await capture(orderB, 'pay_B');
  assert.notEqual(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'held');
  assert.equal(escrowRow('EA').status, 'held');
  assert.equal(razorpayRefunds.length, 0);
});

test('Capture J: same visit id on a different recurring plan is not cross-bound', async () => {
  resetRazorpay();
  const otherPlan = new mongoose.Types.ObjectId().toString();
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB', {
    taskId: otherPlan,
    metadata: { visitId: V1, parentTaskId: otherPlan, recurringPlan: true, visitBudgetRupees: 500 },
  });
  const result = await capture(orderB, 'pay_B');
  assert.notEqual(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'held');
  assert.equal(heldForVisit(V1, otherPlan).length, 1);
  assert.equal(escrowRow('EA').status, 'held');
  assert.equal(razorpayRefunds.length, 0);

  // An escrow whose plan metadata disagrees with its task id is never classified as a duplicate.
  const mismatched = seedOrder('OM', {
    metadata: { visitId: V1, parentTaskId: otherPlan, recurringPlan: true, visitBudgetRupees: 500 },
  });
  const unclassified = await capture(mismatched, 'pay_M');
  assert.notEqual(unclassified.duplicate, true);
  assert.equal(razorpayRefunds.length, 0);
});

// ── Refund synchronization + visit state reconciliation A–P ──────────────────
const { PaymentController } = require('../controllers/PaymentController');
const { AdminFinanceController } = require('../controllers/AdminFinanceController');
const { processRefund, completeRefundFromRazorpayWebhook } = require('./refundService');
const {
  retryPendingRecurringVisitRefundSyncs,
  reconcileRecurringVisitRefundState,
} = require('./recurringVisitRefundSync');

/** Task-service refund callback stand-in. */
let refundSyncs: Row[] = [];
let taskServiceDown = false;
TaskServiceClient.notifyRecurringVisitPaymentRefunded = async (params: Row) => {
  await new Promise((resolve) => setTimeout(resolve, 2));
  if (taskServiceDown) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  refundSyncs.push(params);
};
function resetRefundSync(): void {
  resetRazorpay();
  refundSyncs = [];
  taskServiceDown = false;
}
function fakeRes(): Row {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: Row) {
      this.body = payload;
      return this;
    },
  };
}
async function directRefund(paymentId: string, amountPaise = 55000): Promise<Row> {
  const res = fakeRes();
  await PaymentController.createRefund({ body: { paymentId, amountPaise } } as any, res as any);
  return res.body;
}
async function manualRefund(body: Row): Promise<Row> {
  const res = fakeRes();
  await AdminFinanceController.manualRefund({ body } as any, res as any);
  return res.body;
}
const cancelRefund = (row: Row) =>
  processRefund({
    razorpayOrderId: row.razorpayOrderId,
    razorpayPaymentId: row.razorpayPaymentId,
    reason: 'Visit cancelled',
    cancelledBy: 'poster',
    taskStartDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    cancelledAt: new Date(),
  });
const refundWebhook = (refundId: string, paymentId: string, fully = true) =>
  completeRefundFromRazorpayWebhook({
    refund: { entity: { id: refundId, status: 'processed', payment_id: paymentId } },
    payment: { entity: { id: paymentId, amount: 55000, amount_refunded: fully ? 55000 : 20000, status: fully ? 'refunded' : 'captured' } },
  });
const syncJob = (row: Row) => fakeDb.jobQueue.rows.find((j: Row) => j.jobId === `recurring_visit_refund_sync_${row.escrowId}`);
const reconciliationJobs = (kind: string) =>
  fakeDb.jobQueue.rows.filter((j: Row) => j.jobType === 'reconciliation' && j.payload?.kind === kind);
const refundLedgerFor = (row: Row) => fakeDb.ledger.rows.filter((l: Row) => l.escrowId === row.id && l.type === 'refund');
const expectedSync = (row: Row, visitId = V1) => ({
  parentTaskId: PARENT,
  visitId,
  escrowId: row.escrowId,
  razorpayPaymentId: row.razorpayPaymentId,
  eventId: `recurring_visit_refund_sync_${row.escrowId}`,
});

test('Refund A: /payment/refund marks the exact escrow refunded and records the refund once', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', visitId: V2, razorpayPaymentId: 'pay_2' });
  const body = await directRefund('pay_1');
  assert.equal(body.success, true);
  assert.equal(body.refundId, body.refund.id, 'response shape unchanged');
  assert.deepEqual(razorpayRefunds, [{ paymentId: 'pay_1', paise: 55000 }]);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.ok(escrowRow('E1').refundedAt);
  assert.equal(refundRowsFor('pay_1').length, 1);
  assert.equal(refundRowsFor('pay_1')[0].escrowId, escrowRow('E1').id);
  assert.equal(refundRowsFor('pay_1')[0].razorpayRefundId, body.refund.id);
  assert.equal(refundLedgerFor(escrowRow('E1')).length, 1);
  assert.equal(escrowRow('E2').status, 'held', 'other visit payment untouched');
});

test('Refund B/C: refund webhook marks the escrow refunded; repeated deliveries change nothing', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', visitId: V2, razorpayPaymentId: 'pay_2' });
  // Refund issued outside this service (e.g. Razorpay dashboard): only the webhook reports it.
  await refundWebhook('rfnd_ext', 'pay_1');
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.deepEqual(refundSyncs, [expectedSync(escrowRow('E1'))]);
  assert.equal(reconciliationJobs('unrecorded_refund').length, 1, 'missing local refund record is flagged');
  const snapshot = { ...escrowRow('E1') };

  await refundWebhook('rfnd_ext', 'pay_1');
  await Promise.all([refundWebhook('rfnd_ext', 'pay_1'), refundWebhook('rfnd_ext', 'pay_1')]);
  assert.equal(escrowRow('E1').updatedAt.getTime(), snapshot.updatedAt.getTime(), 'no further escrow writes');
  assert.equal(refundSyncs.length, 1, 'task-service told once');
  assert.equal(fakeDb.refund.rows.length, 0, 'webhook never creates a refund');
  assert.equal(fakeDb.ledger.rows.length, 0, 'webhook never creates ledger entries');
  assert.equal(razorpayRefunds.length, 0);
  assert.equal(escrowRow('E2').status, 'held');
  assert.equal(reconciliationJobs('unrecorded_refund').length, 1);
});

test('Refund C: webhook after a processed refund is idempotent (no refund, ledger or winner change)', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  const refunded = await cancelRefund(a);
  assert.equal(refunded.success, true, refunded.error);
  const refundRows = fakeDb.refund.rows.length;
  const ledgerRows = fakeDb.ledger.rows.length;
  for (let i = 0; i < 3; i += 1) await refundWebhook(refunded.refund.razorpayRefundId, 'pay_1');
  assert.equal(fakeDb.refund.rows.length, refundRows);
  assert.equal(fakeDb.refund.rows[0].status, 'completed');
  assert.equal(fakeDb.ledger.rows.length, ledgerRows);
  assert.equal(razorpayRefunds.length, 1);
  assert.equal(refundSyncs.length, 1);
  assert.equal(reconciliationJobs('unrecorded_refund').length, 0);
});

test('Refund D: a cancel refund (processRefund) syncs exactly that visit to task-service', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  const result = await cancelRefund(a);
  assert.equal(result.success, true, result.error);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.deepEqual(refundSyncs, [expectedSync(escrowRow('E1'))]);
  assert.equal(syncJob(escrowRow('E1')).status, 'completed');
  assert.equal(fakeDb.paymentOrderIdempotency.rows.length, 0, 'visit lock released');
});

test('Refund E: task-service down → refund still succeeds, retry record kept, no duplicate refund', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  taskServiceDown = true;
  const body = await directRefund('pay_1');
  assert.equal(body.success, true);
  assert.equal(escrowRow('E1').status, 'refunded');
  const job = syncJob(escrowRow('E1'));
  assert.equal(job.status, 'pending');
  assert.match(job.lastError, /ECONNREFUSED/);
  assert.deepEqual(job.payload.visitId, V1);

  // Not due yet: nothing is retried.
  assert.deepEqual(await retryPendingRecurringVisitRefundSyncs(), { synced: 0, pending: 0 });
  taskServiceDown = false;
  job.nextRetryAt = new Date(0);
  assert.deepEqual(await retryPendingRecurringVisitRefundSyncs(), { synced: 1, pending: 0 });
  assert.equal(job.status, 'completed');
  assert.deepEqual(refundSyncs, [expectedSync(escrowRow('E1'))]);
  assert.deepEqual(await retryPendingRecurringVisitRefundSyncs(), { synced: 0, pending: 0 });
  assert.equal(refundSyncs.length, 1);
  assert.equal(razorpayRefunds.length, 1, 'retrying the sync never refunds again');

  // A permanent rejection (e.g. visit not found) stops retrying and asks for reconciliation.
  seedEscrow({ escrowId: 'E9', visitId: V2, razorpayPaymentId: 'pay_9' });
  const real = TaskServiceClient.notifyRecurringVisitPaymentRefunded;
  TaskServiceClient.notifyRecurringVisitPaymentRefunded = async () => {
    throw Object.assign(new Error('Request failed'), { response: { status: 404, data: { error: 'Visit not found' } } });
  };
  try {
    await directRefund('pay_9');
  } finally {
    TaskServiceClient.notifyRecurringVisitPaymentRefunded = real;
  }
  assert.equal(syncJob(escrowRow('E9')).status, 'failed');
  assert.match(syncJob(escrowRow('E9')).lastError, /Needs reconciliation: Visit not found/);
});

test('Refund F: refunding Visit 1 payment never touches Visit 2', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', visitId: V1, razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', visitId: V2, razorpayPaymentId: 'pay_2', createdAt: now() });
  assert.equal((await cancelRefund(a)).success, true);
  assert.equal(escrowRow('E2').status, 'held');
  assert.deepEqual(refundSyncs.map((s) => [s.visitId, s.escrowId]), [[V1, 'E1']]);
  await refundWebhook('rfnd_x', 'pay_1');
  assert.equal(escrowRow('E2').status, 'held');
  assert.equal(refundSyncs.length, 1);
});

test('Refund G: after Payment A is refunded, replacement Payment B becomes the visit payment', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  assert.equal((await directRefund('pay_A')).success, true);
  const orderB = seedOrder('OB');
  const result = await capture(orderB, 'pay_B');
  assert.notEqual(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'held');
  assert.equal(heldForVisit(V1).length, 1);
  assert.deepEqual(captureNotifications.map((n) => n.escrowId), ['OB']);
  assert.equal(razorpayRefunds.length, 1, 'B is not refunded');
});

test('Refund H: refunding duplicate Payment B leaves Payment A active; no visit sync for B', async () => {
  resetRefundSync();
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  seedEscrow({ escrowId: 'EA', razorpayPaymentId: 'pay_A' });
  const orderB = seedOrder('OB');
  const result = await capture(orderB, 'pay_B');
  assert.equal(result.duplicate, true);
  assert.equal(escrowRow('OB').status, 'refunded');
  await refundWebhook(fakeDb.refund.rows[0].razorpayRefundId, 'pay_B');
  await refundWebhook(fakeDb.refund.rows[0].razorpayRefundId, 'pay_B');
  assert.equal(refundSyncs.length, 0, 'B was never bound to the visit');
  assert.equal(syncJob(escrowRow('OB')), undefined);
  assert.equal(escrowRow('EA').status, 'held');
  const paid = await payout({ taskId: CHILD_V1 });
  assert.equal(paid.success, true, paid.error);
  assert.equal(fakeDb.payout.rows[0].escrowId, escrowRow('EA').id);
});

test('Refund I: an already refunded payment creates no new refund on any path', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  const first = await directRefund('pay_1');
  const again = await directRefund('pay_1');
  assert.equal(again.success, true);
  assert.equal(again.refundId, first.refundId, 'returns the recorded refund');
  const viaCancel = await cancelRefund(a);
  assert.equal(viaCancel.success, false);
  assert.match(viaCancel.error, /already refunded/);
  const viaManual = await manualRefund({ razorpayOrderId: a.razorpayOrderId, razorpayPaymentId: 'pay_1' });
  assert.equal(viaManual.alreadyRefunded, true);
  assert.equal(razorpayRefunds.length, 1);
  assert.equal(refundRowsFor('pay_1').length, 1);
  assert.equal(refundLedgerFor(escrowRow('E1')).length, 1);
  assert.equal(refundSyncs.length, 1);
});

test('Refund J: a released (paid-out) payment is never refunded or blindly marked refunded', async () => {
  resetRefundSync();
  const r = seedEscrow({ escrowId: 'ER', status: 'released', razorpayPaymentId: 'pay_R' });
  await assert.rejects(directRefund('pay_R'), /already paid out/);
  await assert.rejects(manualRefund({ razorpayOrderId: r.razorpayOrderId, razorpayPaymentId: 'pay_R' }), /already paid out/);
  const viaCancel = await cancelRefund(r);
  assert.equal(viaCancel.success, false);
  assert.equal(razorpayRefunds.length, 0);

  // Razorpay reports a refund anyway (dashboard): flagged for reconciliation, state untouched.
  await refundWebhook('rfnd_R', 'pay_R');
  assert.equal(escrowRow('ER').status, 'released');
  assert.equal(reconciliationJobs('refund_after_release').length, 1);
  assert.equal(refundSyncs.length, 0);
});

test('Refund K: no newest-payment fallback – task-only or mismatched refunds of a recurring plan are refused', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'E1', visitId: V1, razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', visitId: V2, razorpayPaymentId: 'pay_2', createdAt: now() }); // newest
  const byTask = await processRefund({
    razorpayOrderId: 'order_unknown',
    razorpayPaymentId: '',
    taskId: PARENT,
    cancelledBy: 'poster',
    taskStartDate: new Date(),
    cancelledAt: new Date(),
  });
  assert.equal(byTask.success, false);
  assert.match(byTask.error, /exact visit payment/);
  const mismatched = await processRefund({
    razorpayOrderId: escrowRow('E1').razorpayOrderId,
    razorpayPaymentId: 'pay_2',
    cancelledBy: 'poster',
    taskStartDate: new Date(),
    cancelledAt: new Date(),
  });
  assert.equal(mismatched.success, false);
  assert.match(mismatched.error, /does not belong/);
  assert.equal(razorpayRefunds.length, 0);
  assert.equal(escrowRow('E1').status, 'held');
  assert.equal(escrowRow('E2').status, 'held');
});

test('Refund L: manual refund requires the exact payment, refunds only that escrow and is idempotent', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', visitId: V1, razorpayPaymentId: 'pay_1' });
  seedEscrow({ escrowId: 'E2', visitId: V2, razorpayPaymentId: 'pay_2' });
  await assert.rejects(manualRefund({ razorpayOrderId: a.razorpayOrderId, razorpayPaymentId: 'pay_2' }), /does not belong/);
  assert.equal(razorpayRefunds.length, 0);

  const done = await manualRefund({ razorpayOrderId: a.razorpayOrderId, razorpayPaymentId: 'pay_1' });
  assert.equal(done.success, true);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.equal(escrowRow('E2').status, 'held');
  assert.deepEqual(refundSyncs, [expectedSync(escrowRow('E1'))]);

  const repeat = await manualRefund({ razorpayOrderId: a.razorpayOrderId, razorpayPaymentId: 'pay_1' });
  assert.equal(repeat.alreadyRefunded, true);
  assert.equal(repeat.refund.id, done.refund.id);
  assert.equal(razorpayRefunds.length, 1);
  assert.equal(refundRowsFor('pay_1').length, 1);
  assert.equal(refundSyncs.length, 1);
});

test('Refund M: reconciliation repairs stale state exactly and never guesses', async () => {
  resetRefundSync();
  // A: completed full refund recorded, escrow still held.
  const a = seedEscrow({ escrowId: 'EA', visitId: V1, razorpayPaymentId: 'pay_A' });
  fakeDb.refund.rows.push({ id: 'r-a', refundId: 'refund_a', escrowId: a.id, paymentId: 'pay_A', razorpayRefundId: 'rfnd_a', refundAmount: new Prisma.Decimal('550'), status: 'completed', createdAt: now() });
  // A (partial): only part refunded – flagged, not marked.
  const p = seedEscrow({ escrowId: 'EP', visitId: V2, razorpayPaymentId: 'pay_P' });
  fakeDb.refund.rows.push({ id: 'r-p', refundId: 'refund_p', escrowId: p.id, paymentId: 'pay_P', razorpayRefundId: 'rfnd_p', refundAmount: new Prisma.Decimal('200'), status: 'completed', createdAt: now() });
  // B: refunded escrow whose visit was never told.
  seedEscrow({ escrowId: 'EB', visitId: 'visit-uuid-3', razorpayPaymentId: 'pay_B', status: 'refunded', refundedAt: now() });
  // D: duplicate capture never refunded.
  seedEscrow({ escrowId: 'ED', visitId: 'visit-uuid-4', razorpayPaymentId: 'pay_D', status: 'cancelled', errorCode: DUPLICATE_VISIT_PAYMENT_CODE });
  seedEscrow({ escrowId: 'EH', visitId: 'visit-uuid-4', razorpayPaymentId: 'pay_H' });

  const first = await reconcileRecurringVisitRefundState();
  assert.deepEqual(first, { escrowsMarkedRefunded: 1, flaggedForReview: 1, visitSyncs: 2, duplicateRefunds: 1 });
  assert.equal(escrowRow('EA').status, 'refunded');
  assert.equal(escrowRow('EP').status, 'held', 'partial refund is not auto-resolved');
  assert.equal(reconciliationJobs('partial_refund').length, 1);
  assert.deepEqual(refundSyncs.map((s) => s.escrowId).sort(), ['EA', 'EB']);
  assert.equal(escrowRow('ED').status, 'refunded');
  assert.deepEqual(razorpayRefunds.map((r) => r.paymentId), ['pay_D'], 'only the known duplicate is refunded');
  assert.equal(escrowRow('EH').status, 'held');

  const second = await reconcileRecurringVisitRefundState();
  assert.deepEqual(second, { escrowsMarkedRefunded: 0, flaggedForReview: 1, visitSyncs: 0, duplicateRefunds: 0 });
  assert.equal(reconciliationJobs('partial_refund').length, 1, 'flag is not duplicated');
  assert.equal(refundSyncs.length, 2);
  assert.equal(razorpayRefunds.length, 1);
});

test('Refund N: concurrent refunds of one payment → one Razorpay refund, one transition, one sync', async () => {
  resetRefundSync();
  const a = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  const results = await Promise.all([directRefund('pay_1'), directRefund('pay_1'), cancelRefund(a)]);
  assert.equal(results[0].success, true);
  assert.equal(results[1].success, true);
  assert.equal(results[0].refundId, results[1].refundId, 'both callers see the same refund');
  assert.equal(razorpayRefunds.length, 1);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.equal(refundRowsFor('pay_1').length, 1, 'no duplicate refund records');

  const refundId = refundRowsFor('pay_1')[0].razorpayRefundId;
  await Promise.all([refundWebhook(refundId, 'pay_1'), refundWebhook(refundId, 'pay_1')]);
  assert.equal(refundSyncs.length, 1);
  assert.equal(refundRowsFor('pay_1').length, 1);
  assert.equal(fakeDb.paymentOrderIdempotency.rows.length, 0, 'visit lock released');
});

test('Refund O: a refunded visit payment cannot be paid out', async () => {
  resetRefundSync();
  seedHelperBank();
  seedChild(CHILD_V1, V1);
  const a = seedEscrow({ escrowId: 'E1', razorpayPaymentId: 'pay_1' });
  assert.equal((await directRefund('pay_1')).success, true);
  const viaCompletion = await payout({ taskId: CHILD_V1 });
  assert.equal(viaCompletion.success, false);
  assert.match(viaCompletion.error, /No active payment/);
  const viaLegacy = await processPayout({ razorpayOrderId: a.razorpayOrderId, performerUid: HELPER, ...bankDetails });
  assert.equal(viaLegacy.success, false);
  assert.equal(escrowRow('E1').status, 'refunded');
  assert.equal(fakeDb.payout.rows.filter((p: Row) => p.status === 'completed').length, 0);
});

test('Refund P: non-recurring direct refunds keep the existing behaviour (no escrow or refund writes)', async () => {
  resetRefundSync();
  seedEscrow({ escrowId: 'EN', taskId: 'task-plain', visitId: null, metadata: {}, razorpayPaymentId: 'pay_N' });
  const body = await directRefund('pay_N');
  assert.equal(body.success, true);
  assert.equal(escrowRow('EN').status, 'held');
  assert.equal(fakeDb.refund.rows.length, 0);
  assert.equal(refundSyncs.length, 0);
});
