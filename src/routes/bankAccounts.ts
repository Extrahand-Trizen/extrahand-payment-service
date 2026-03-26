import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';
import { BankAccountController } from '../controllers/BankAccountController';

const router = express.Router();

const disableServiceAuth = process.env.DISABLE_SERVICE_AUTH_FOR_BANK_ACCOUNTS === 'true';
if (!disableServiceAuth) {
	router.use(serviceAuthMiddleware);
}

router.post('/', asyncHandler(BankAccountController.upsertBankAccount));
router.get('/me', asyncHandler(BankAccountController.getMyBankAccounts));

export default router;
