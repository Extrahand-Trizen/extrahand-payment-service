import type Razorpay from 'razorpay';
import logger from '../config/logger';
import { getPaymentClient, type PaymentEnvironment } from '../config/paymentEnvironment';
import { prisma } from '../config/prisma';
import { resolvePaymentEnvironmentForPayment } from './paymentService';

const RECON_PAGE_SIZE = 1000;
const SETTLEMENT_CACHE_MS = 12 * 60 * 60 * 1000;

type RefundSettlementReconItem = {
  entity_id?: unknown;
  type?: unknown;
  settled?: unknown;
  settled_at?: unknown;
  settlement_id?: unknown;
  payment_id?: unknown;
};

type RefundSettlementData = {
  status: 'pending' | 'settled' | null;
  settlementId: string | null;
  expectedSettlementAt: null;
  settledAt: Date | null;
};

function getReconItems(response: unknown): RefundSettlementReconItem[] {
  if (
    typeof response !== 'object' ||
    response === null ||
    !('items' in response) ||
    !Array.isArray(response.items)
  ) {
    return [];
  }
  return response.items as RefundSettlementReconItem[];
}

export function resolveRefundSettlementReconItem(
  item: RefundSettlementReconItem,
): Omit<RefundSettlementData, 'expectedSettlementAt'> | null {
  if (String(item.type || '').toLowerCase() !== 'refund') return null;
  if (typeof item.settled !== 'boolean') return null;

  const settledAtSeconds = Number(item.settled_at);
  const settledAt =
    item.settled === true &&
    Number.isFinite(settledAtSeconds) &&
    settledAtSeconds > 0
      ? new Date(settledAtSeconds * 1000)
      : null;
  const settlementId =
    typeof item.settlement_id === 'string' && item.settlement_id.trim()
      ? item.settlement_id.trim()
      : null;

  return {
    status: item.settled ? 'settled' : 'pending',
    settlementId,
    settledAt,
  };
}

function settlementResponse(refund: {
  settlementStatus: string | null;
  settlementId: string | null;
  settledAt: Date | null;
}): RefundSettlementData {
  const status =
    refund.settlementStatus === 'settled' || refund.settlementStatus === 'pending'
      ? refund.settlementStatus
      : null;
  return {
    status,
    settlementId: refund.settlementId,
    expectedSettlementAt: null,
    settledAt: refund.settledAt,
  };
}

function monthCursor(startDate: Date, endDate: Date): Date[] {
  const months: Date[] = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

async function findRefundInRecon(
  client: Razorpay,
  refund: { razorpayRefundId: string; paymentId: string; createdAt: Date },
  endDate: Date,
): Promise<RefundSettlementReconItem | null> {
  for (const month of monthCursor(refund.createdAt, endDate)) {
    let skip = 0;
    while (true) {
      const response = await client.settlements.reports({
        year: month.getUTCFullYear(),
        month: month.getUTCMonth() + 1,
        count: RECON_PAGE_SIZE,
        skip,
      });
      const items = getReconItems(response);
      const match = items.find(
        (item) =>
          String(item.type || '').toLowerCase() === 'refund' &&
          item.entity_id === refund.razorpayRefundId &&
          (item.payment_id == null || item.payment_id === refund.paymentId),
      );
      if (match) return match;
      if (items.length < RECON_PAGE_SIZE) break;
      skip += items.length;
    }
  }
  return null;
}

async function persistRefundSettlement(
  razorpayRefundId: string,
  paymentId: string | null | undefined,
  item: RefundSettlementReconItem,
  checkedAt: Date,
): Promise<void> {
  const settlement = resolveRefundSettlementReconItem(item);
  if (!settlement) return;

  const where = {
    razorpayRefundId,
    ...(paymentId ? { paymentId } : {}),
  };
  if (settlement.status === 'settled') {
    await prisma.refund.updateMany({
      where: {
        ...where,
        OR: [
          { settlementStatus: null },
          { settlementStatus: 'pending' },
          { settledAt: null },
          ...(settlement.settledAt ? [{ settledAt: { lt: settlement.settledAt } }] : []),
        ],
      },
      data: {
        settlementStatus: settlement.status,
        ...(settlement.settlementId ? { settlementId: settlement.settlementId } : {}),
        ...(settlement.settledAt ? { settledAt: settlement.settledAt } : {}),
        settlementCheckedAt: checkedAt,
      },
    });
    return;
  }

  await prisma.refund.updateMany({
    where: {
      ...where,
      OR: [{ settlementStatus: null }, { settlementStatus: 'pending' }],
    },
    data: {
      settlementStatus: settlement.status,
      ...(settlement.settlementId ? { settlementId: settlement.settlementId } : {}),
      settlementCheckedAt: checkedAt,
    },
  });
}

export async function syncRefundSettlement(
  refund: {
    id: string;
    razorpayRefundId: string | null;
    paymentId: string;
    createdAt: Date;
    settlementStatus: string | null;
    settlementId: string | null;
    settledAt: Date | null;
    settlementCheckedAt: Date | null;
    escrow?: { razorpayOrderId?: string | null } | null;
  },
): Promise<RefundSettlementData> {
  const cachedResult = settlementResponse(refund);
  const razorpayRefundId = refund.razorpayRefundId;
  if (!razorpayRefundId || refund.settlementStatus === 'settled') {
    return cachedResult;
  }
  const checkedAt = refund.settlementCheckedAt?.getTime() ?? 0;
  if (Date.now() - checkedAt < SETTLEMENT_CACHE_MS) return cachedResult;

  try {
    const environment = await resolvePaymentEnvironmentForPayment(
      refund.paymentId,
      refund.escrow?.razorpayOrderId ?? undefined,
    );
    const client = getPaymentClient(environment);
    const reconItem = await findRefundInRecon(
      client,
      { ...refund, razorpayRefundId },
      new Date(),
    );
    const now = new Date();
    if (reconItem) {
      await persistRefundSettlement(
        razorpayRefundId,
        refund.paymentId,
        reconItem,
        now,
      );
      const persistedRefund = await prisma.refund.findUnique({
        where: { id: refund.id },
        select: {
          settlementStatus: true,
          settlementId: true,
          settledAt: true,
        },
      });
      if (persistedRefund) {
        return settlementResponse(persistedRefund);
      }
    } else {
      await prisma.refund.updateMany({
        where: {
          id: refund.id,
          OR: [{ settlementStatus: null }, { settlementStatus: 'pending' }],
        },
        data: { settlementCheckedAt: now },
      });
    }
  } catch (error: unknown) {
    logger.warn('Failed to sync refund settlement reconciliation', {
      refundId: refund.id,
      razorpayRefundId: refund.razorpayRefundId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return cachedResult;
}

export async function syncRefundSettlementsForDate(
  settlementDate: Date,
  environment: PaymentEnvironment,
): Promise<void> {
  if (Number.isNaN(settlementDate.getTime())) {
    throw new Error('Invalid settlement date for refund reconciliation');
  }

  const client = getPaymentClient(environment);
  let skip = 0;
  while (true) {
    const response = await client.settlements.reports({
      year: settlementDate.getUTCFullYear(),
      month: settlementDate.getUTCMonth() + 1,
      day: settlementDate.getUTCDate(),
      count: RECON_PAGE_SIZE,
      skip,
    });
    const items = getReconItems(response);
    const checkedAt = new Date();
    for (const item of items) {
      if (String(item.type || '').toLowerCase() !== 'refund') continue;
      if (typeof item.entity_id !== 'string' || !item.entity_id.trim()) continue;
      await persistRefundSettlement(
        item.entity_id,
        typeof item.payment_id === 'string' ? item.payment_id : null,
        item,
        checkedAt,
      );
    }
    if (items.length < RECON_PAGE_SIZE) break;
    skip += items.length;
  }
}
