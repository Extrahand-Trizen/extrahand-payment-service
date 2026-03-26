import express from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { BankAccountController } from '../controllers/BankAccountController';

const router = express.Router();

router.post('/', asyncHandler(BankAccountController.upsertBankAccount));

export default router;
