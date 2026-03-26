import express from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { BankAccountController } from '../controllers/BankAccountController';

const router = express.Router();

router.post('/', asyncHandler(BankAccountController.upsertBankAccount));
router.get('/me', asyncHandler(BankAccountController.getMyBankAccounts));
router.put('/:bankAccountId/default', asyncHandler(BankAccountController.setDefaultBankAccount));
router.delete('/:bankAccountId', asyncHandler(BankAccountController.deleteBankAccount));

export default router;
