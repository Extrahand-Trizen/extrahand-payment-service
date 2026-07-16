import express from 'express';
import { AdminAuthController } from '../controllers/AdminAuthController';
import { AdminFinanceController } from '../controllers/AdminFinanceController';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';

const router = express.Router();

router.post('/login', AdminAuthController.login);

// Finance/admin endpoints (service-authenticated)
router.use(serviceAuthMiddleware);

// Transactions
router.get('/transactions/metrics', asyncHandler(AdminFinanceController.getTransactionMetrics));
router.get('/transactions', asyncHandler(AdminFinanceController.getTransactions));
router.get('/transactions/:id', asyncHandler(AdminFinanceController.getTransactionById));

// Payouts
router.get('/payouts', asyncHandler(AdminFinanceController.getPayouts));
router.get('/payouts/:id', asyncHandler(AdminFinanceController.getPayoutById));
router.post('/payouts/:id/retry', asyncHandler(AdminFinanceController.retryPayout));
router.post('/payouts/:id/hold', asyncHandler(AdminFinanceController.holdPayout));
// Status update (ops portal) — same handler as /dashboard/payouts/:id/status
router.patch('/payouts/:id/status', asyncHandler(AdminFinanceController.updatePayoutStatus));

// Refunds
router.get('/refunds', asyncHandler(AdminFinanceController.getRefunds));
router.get('/refunds/:id', asyncHandler(AdminFinanceController.getRefundById));
router.post('/refunds/manual', asyncHandler(AdminFinanceController.manualRefund));

// Ledger
router.get('/ledger', asyncHandler(AdminFinanceController.getLedger));
router.get('/ledger/:id', asyncHandler(AdminFinanceController.getLedgerById));

// User financial profiles
router.get('/users', asyncHandler(AdminFinanceController.listUserProfiles));
router.get('/users/:id/financial-profile', asyncHandler(AdminFinanceController.getUserFinancialProfile));

// Reconciliation
router.get('/reconciliation/payin', asyncHandler(AdminFinanceController.getReconciliation));
router.get('/reconciliation/payout', asyncHandler(AdminFinanceController.getReconciliation));
router.get('/reconciliation/settlements', asyncHandler(AdminFinanceController.getReconciliation));

// Risk
router.get('/risk/flags', asyncHandler(AdminFinanceController.getRiskFlags));
router.post('/risk/freeze-user', asyncHandler(AdminFinanceController.freezeUser));
router.post('/risk/freeze-payout', asyncHandler(AdminFinanceController.freezePayout));

// Audit logs
router.get('/audit-logs', asyncHandler(AdminFinanceController.getAuditLogs));

// Alerts
router.get('/alerts', asyncHandler(AdminFinanceController.getAlerts));

export default router;
