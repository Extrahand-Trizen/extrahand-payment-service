import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { prisma } from '../config/prisma';
import logger from '../config/logger';
import {
  CATEGORY_FEE_SEED_ROWS,
  type CategoryFeeMode,
  type CategoryFeeSeedRow,
} from './categoryFeeSeedData';
import { CategoryFeeMode as PrismaCategoryFeeMode } from '@prisma/client';

const GST_18_PERCENT_CATEGORY_KEYS = new Set([
  'water-tanker-services',
  'driver-chauffeur',
  'water_tanker_services',
]);

const EXCEL_CANDIDATE_PATHS = [
  path.resolve(__dirname, '../../../Categories with GST 1.xlsx'),
  path.resolve(__dirname, '../../Categories with GST 1.xlsx'),
  path.resolve(process.cwd(), 'Categories with GST 1.xlsx'),
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parsePercent(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim().replace('%', '');
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n / 100 : undefined;
}

function parseSacField(raw: unknown): { sacCode?: string; sacHeading?: string } {
  if (raw === null || raw === undefined) return {};
  const text = String(raw).trim();
  if (!text) return {};

  const labeled = text.match(/^SAC\s+(\d+)\s*(?:\(([^)]+)\))?/i);
  if (labeled) {
    return {
      sacCode: labeled[1],
      sacHeading: labeled[2]?.trim() || undefined,
    };
  }

  if (/^\d+$/.test(text)) {
    return { sacCode: text };
  }

  return { sacHeading: text };
}

function resolveSacFields(row: Record<string, unknown>): { sacCode?: string; sacHeading?: string } {
  const parsed = parseSacField(row['SAC / Heading'] ?? row['SAC'] ?? row['sac'] ?? row['Sac']);
  return {
    sacCode:
      (row['sacCode'] ?? row['SAC Code'] ?? row['Sac Code'])?.toString().trim() || parsed.sacCode,
    sacHeading:
      (row['sacHeading'] ?? row['SAC Heading'] ?? row['Sac Heading'])?.toString().trim() ||
      parsed.sacHeading,
  };
}

function toPrismaMode(mode: CategoryFeeMode): PrismaCategoryFeeMode {
  return mode === 'BOOK_NOW' ? PrismaCategoryFeeMode.BOOK_NOW : PrismaCategoryFeeMode.BIDDING;
}

async function upsertSeedRow(row: CategoryFeeSeedRow): Promise<void> {
  const mode = toPrismaMode(row.mode);
  await prisma.categoryFeeConfig.upsert({
    where: { categoryKey_mode: { categoryKey: row.categoryKey, mode } },
    create: {
      categoryKey: row.categoryKey,
      mode,
      displayName: row.displayName,
      sacCode: row.sacCode ?? null,
      sacHeading: row.sacHeading ?? null,
      gstPercentage: row.gstPercentage,
    },
    update: {
      displayName: row.displayName,
      sacCode: row.sacCode ?? null,
      sacHeading: row.sacHeading ?? null,
      gstPercentage: row.gstPercentage,
    },
  });
  logger.info(`Upserted category config: ${row.mode}/${row.categoryKey}`);
}

async function seedFromBuiltInRows(): Promise<void> {
  for (const row of CATEGORY_FEE_SEED_ROWS) {
    await upsertSeedRow(row);
  }
}

async function seedFromExcelIfPresent(): Promise<void> {
  const excelPath = EXCEL_CANDIDATE_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!excelPath) {
    logger.warn('Categories Excel not found — skipped optional spreadsheet import');
    return;
  }

  const workbook = XLSX.readFile(excelPath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];

  for (const r of rows) {
    const categoryLabel = (
      r['categoryKey'] ||
      r['Category'] ||
      r['category'] ||
      r['CategoryKey'] ||
      r['Category Key'] ||
      r['Service Category'] ||
      r['ExtraHand Category']
    )
      ?.toString()
      .trim();
    const categoryKey = categoryLabel ? slugify(categoryLabel) : null;
    if (!categoryKey) continue;

    const resolvedGst = GST_18_PERCENT_CATEGORY_KEYS.has(categoryKey)
      ? 0.18
      : (parsePercent(r['gstPercentage'] ?? r['GST Rate'] ?? r['GST']) ?? 0.18);

    const sac = resolveSacFields(r);

    const excelMode =
      String(r['mode'] ?? r['Mode'] ?? 'BIDDING').toUpperCase() === 'BOOK_NOW'
        ? PrismaCategoryFeeMode.BOOK_NOW
        : PrismaCategoryFeeMode.BIDDING;

    await prisma.categoryFeeConfig.upsert({
      where: { categoryKey_mode: { categoryKey, mode: excelMode } },
      create: {
        categoryKey,
        mode: excelMode,
        displayName:
          (r['displayName'] ||
            r['DisplayName'] ||
            r['Display Name'] ||
            r['ExtraHand Category'] ||
            categoryLabel) as string,
        sacCode: sac.sacCode ?? null,
        sacHeading: sac.sacHeading ?? null,
        gstPercentage: resolvedGst,
        platformFeePercentage: r['platformFeePercentage']
          ? parseFloat(String(r['platformFeePercentage']))
          : undefined,
        razorpayFeeGstPercentage: r['razorpayFeeGstPercentage']
          ? parseFloat(String(r['razorpayFeeGstPercentage']))
          : undefined,
        minPrice: r['minPrice'] ? parseFloat(String(r['minPrice'])) : undefined,
        maxPrice: r['maxPrice'] ? parseFloat(String(r['maxPrice'])) : undefined,
        effectiveFrom: r['effectiveFrom'] ? new Date(String(r['effectiveFrom'])) : undefined,
        effectiveTo: r['effectiveTo'] ? new Date(String(r['effectiveTo'])) : undefined,
      },
      update: {
        displayName:
          (r['displayName'] ||
            r['DisplayName'] ||
            r['Display Name'] ||
            r['ExtraHand Category'] ||
            categoryLabel) as string,
        sacCode: sac.sacCode ?? null,
        sacHeading: sac.sacHeading ?? null,
        gstPercentage: resolvedGst,
        platformFeePercentage: r['platformFeePercentage']
          ? parseFloat(String(r['platformFeePercentage']))
          : undefined,
        razorpayFeeGstPercentage: r['razorpayFeeGstPercentage']
          ? parseFloat(String(r['razorpayFeeGstPercentage']))
          : undefined,
        minPrice: r['minPrice'] ? parseFloat(String(r['minPrice'])) : undefined,
        maxPrice: r['maxPrice'] ? parseFloat(String(r['maxPrice'])) : undefined,
        effectiveFrom: r['effectiveFrom'] ? new Date(String(r['effectiveFrom'])) : undefined,
        effectiveTo: r['effectiveTo'] ? new Date(String(r['effectiveTo'])) : undefined,
      },
    });

    logger.info(`Upserted category config from Excel: ${excelMode}/${categoryKey}`);
  }
}

async function run() {
  try {
    await seedFromBuiltInRows();
    await seedFromExcelIfPresent();

    const count = await prisma.categoryFeeConfig.count();
    logger.info(`✅ Seed completed — ${count} category fee config row(s) in database`);
    process.exit(0);
  } catch (err: unknown) {
    logger.error('❌ Seed failed', err);
    process.exit(1);
  }
}

run();
