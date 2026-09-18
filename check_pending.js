require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');

async function testUri(url, label) {
  if (!url) {
    console.log(`${label} not configured`);
    return;
  }
  const pool = new pg.Pool({ connectionString: url });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  try {
    const totalCount = await prisma.escrow.count();
    const pendingCount = await prisma.escrow.count({
      where: { taskId: { startsWith: 'booknow-pending-' } },
    });
    const samples = await prisma.escrow.findMany({
      where: { taskId: { startsWith: 'booknow-pending-' } },
      select: {
        id: true,
        escrowId: true,
        taskId: true,
        bookingOrderId: true,
        status: true,
        paymentStatus: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    console.log(`\n=== ${label} ===`);
    console.log(`Total escrows: ${totalCount}`);
    console.log(`Pending BookNow escrows: ${pendingCount}`);
    console.log('Sample pending escrows:', JSON.stringify(samples, null, 2));
  } catch (err) {
    console.error(`Error querying ${label}:`, err.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function main() {
  await testUri(process.env.POSTGRESDB_URI, 'PROD_POSTGRES (Neon)');
  await testUri(process.env.DEV_POSTGRESDB_URI, 'DEV_POSTGRES (Neon)');
}

main().then(() => process.exit(0));

