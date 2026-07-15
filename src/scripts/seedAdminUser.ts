import dotenv from 'dotenv';

dotenv.config();

const useProd = process.argv.includes('--prod');

if (useProd) {
  const prodUrl = process.env.PROD_POSTGRESDB_URI || '';
  if (!prodUrl) {
    console.error('PROD_POSTGRESDB_URI is required when using --prod');
    process.exit(1);
  }
  process.env.USE_DEV_POSTGRES = 'false';
  process.env.PROD_POSTGRESDB_URI = prodUrl;
  console.log('[seed:admin] Target: PROD (USE_DEV_POSTGRES=false)');
} else {
  process.env.USE_DEV_POSTGRES = 'true';
  console.log('[seed:admin] Target: DEV (USE_DEV_POSTGRES=true)');
}

const USERNAME = process.env.ADMIN_SEED_USERNAME || 'admin';
const PASSWORD = process.env.ADMIN_SEED_PASSWORD || 'admin@123';

async function run() {
  try {
    const { upsertAdminUser } = await import('../services/adminAuthService');
    const { disconnectPrisma } = await import('../config/prisma');
    const logger = (await import('../config/logger')).default;

    await upsertAdminUser(USERNAME, PASSWORD);
    logger.info(`✅ Admin user "${USERNAME}" upserted`);
    await disconnectPrisma();
    process.exit(0);
  } catch (err: unknown) {
    const logger = (await import('../config/logger')).default;
    logger.error('❌ Admin user seed failed', err);
    process.exit(1);
  }
}

run();
