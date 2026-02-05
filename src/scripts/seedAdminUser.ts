import { upsertAdminUser } from '../services/adminAuthService';
import logger from '../config/logger';

async function run() {
  try {
    await upsertAdminUser('admin', 'admin@123');
    logger.info('✅ Admin user upserted');
    process.exit(0);
  } catch (err: any) {
    logger.error('❌ Admin user seed failed', err);
    process.exit(1);
  }
}

run();
