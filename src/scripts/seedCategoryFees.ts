import { prisma } from '../config/prisma';
import XLSX from 'xlsx';
import logger from '../config/logger';

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

      const resolvedGst = parsePercent(r['gstPercentage'] ?? r['GST Rate']) ?? 0.18;

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
