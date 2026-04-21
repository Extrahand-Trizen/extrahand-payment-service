import { prisma } from '../config/prisma';
import XLSX from 'xlsx';
import logger from '../config/logger';

const GST_18_PERCENT_CATEGORY_KEYS = new Set([
  'water-tanker-services',
  'driver-chauffeur',
  'water_tanker_services',
]);

const MANUAL_CATEGORY_CONFIGS = [
  {
    categoryKey: 'beauticians',
    displayName: 'Beauty Services',
    gstPercentage: 0.18,
  },
  {
    categoryKey: 'fitness',
    displayName: 'Fitness Trainers',
    gstPercentage: 0.18,
  },
  {
    categoryKey: 'massage_spa',
    displayName: 'Massage / Spa',
    gstPercentage: 0.05,
  },
  {
    categoryKey: 'security_patrol',
    displayName: 'Security Patrol / Watchman',
    gstPercentage: 0.18,
  },
  {
    categoryKey: 'water_tanker_services',
    displayName: 'Water & Tanker Services',
    gstPercentage: 0.18,
  },
  {
    categoryKey: 'senior_elder_care',
    displayName: 'Senior Care / Elder Care',
    gstPercentage: 0.18,
  },
] as const;

async function run() {
  try {
    const workbook = XLSX.readFile('../Categories with GST 1.xlsx');
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet) as any[];

    const slugify = (value: string) => {
      return value
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    };

    const parsePercent = (value: any) => {
      if (value === null || value === undefined) return undefined;
      const raw = String(value).trim().replace('%', '');
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n / 100 : undefined;
    };

    for (const r of rows) {
      // Expect columns: categoryKey, displayName, gstPercentage, platformFeePercentage, razorpayFeeGstPercentage, minPrice, maxPrice
      const categoryLabel = (r['categoryKey'] || r['Category'] || r['category'] || r['CategoryKey'] || r['Category Key'] || r['Service Category'])?.toString().trim();
      const categoryKey = categoryLabel ? slugify(categoryLabel) : null;
      if (!categoryKey) continue;

      const resolvedGst = GST_18_PERCENT_CATEGORY_KEYS.has(categoryKey)
        ? 0.18
        : (parsePercent(r['gstPercentage'] ?? r['GST Rate']) ?? 0.18);

      const payload: any = {
        categoryKey,
        displayName: r['displayName'] || r['DisplayName'] || r['Display Name'] || categoryLabel || null,
        gstPercentage: resolvedGst,
        platformFeePercentage: r['platformFeePercentage'] ? parseFloat(String(r['platformFeePercentage'])) : undefined,
        razorpayFeeGstPercentage: r['razorpayFeeGstPercentage'] ? parseFloat(String(r['razorpayFeeGstPercentage'])) : undefined,
        minPrice: r['minPrice'] ? parseFloat(String(r['minPrice'])) : undefined,
        maxPrice: r['maxPrice'] ? parseFloat(String(r['maxPrice'])) : undefined,
        effectiveFrom: r['effectiveFrom'] ? new Date(r['effectiveFrom']) : undefined,
        effectiveTo: r['effectiveTo'] ? new Date(r['effectiveTo']) : undefined,
      };

      await prisma.categoryFeeConfig.upsert({
        where: { categoryKey },
        create: payload,
        update: payload,
      });

      logger.info(`Upserted category config: ${categoryKey}`);
    }

    for (const config of MANUAL_CATEGORY_CONFIGS) {
      await prisma.categoryFeeConfig.upsert({
        where: { categoryKey: config.categoryKey },
        create: {
          categoryKey: config.categoryKey,
          displayName: config.displayName,
          gstPercentage: config.gstPercentage,
        },
        update: {
          displayName: config.displayName,
          gstPercentage: config.gstPercentage,
        },
      });

      logger.info(`Upserted manual category config: ${config.categoryKey}`);
    }

    await prisma.categoryFeeConfig.upsert({
      where: { categoryKey: 'default' },
      create: {
        categoryKey: 'default',
        displayName: 'Default',
        gstPercentage: 0.18,
      },
      update: {
        displayName: 'Default',
        gstPercentage: 0.18,
      }
    });

    logger.info('✅ Seed completed');
    process.exit(0);
  } catch (err: any) {
    logger.error('❌ Seed failed', err);
    process.exit(1);
  }
}

run();
