const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pg = require('pg');

const devUrl = 'postgresql://neondb_owner:npg_Ac0txfqXWd3U@ep-falling-glade-a47szxlx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';
const prodUrl = 'postgresql://neondb_owner:npg_Ac0txfqXWd3U@ep-frosty-boat-a48z9l9k-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

async function checkDb(url, name) {
  const pool = new pg.Pool({ connectionString: url });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.$connect();
    const payouts = await prisma.payout.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5
    });
    console.log(`\nLatest 5 payouts in ${name}:`);
    console.log(JSON.stringify(payouts, null, 2));
  } catch (err) {
    console.error(`Error querying ${name}:`, err.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

(async () => {
  await checkDb(devUrl, 'DEV DB');
  await checkDb(prodUrl, 'PROD DB');
  process.exit(0);
})();
