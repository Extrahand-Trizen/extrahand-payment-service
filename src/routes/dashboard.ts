import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';
import { DashboardController } from '../controllers/DashboardController';
import { AdminFinanceController } from '../controllers/AdminFinanceController';

const router = express.Router();

// All dashboard routes are internal service-to-service endpoints
router.use(serviceAuthMiddleware);

router.get('/overview', asyncHandler(DashboardController.getOverview));
router.get('/transactions', asyncHandler(DashboardController.getTransactions));
router.get('/all-transactions', asyncHandler(AdminFinanceController.getTransactions)); // New: Admin list all
router.get('/transactions/:id', asyncHandler(DashboardController.getTransactionTrace));
router.get('/payouts', asyncHandler(DashboardController.getPayouts));
router.get('/payouts/:id', asyncHandler(AdminFinanceController.getPayoutById));
router.post('/payouts/:id/retry', asyncHandler(DashboardController.retryPayout));
router.post('/payouts/:id/hold', asyncHandler(AdminFinanceController.holdPayout));
router.patch('/payouts/:id/status', asyncHandler(AdminFinanceController.updatePayoutStatus));
router.patch('/payouts/:id/team-test', asyncHandler(AdminFinanceController.updatePayoutTeamTest));
router.patch('/transactions/:id/team-test', asyncHandler(AdminFinanceController.updateTransactionTeamTest));
router.delete('/transactions/:id', asyncHandler(AdminFinanceController.deleteTransaction));
router.delete('/payouts/:id', asyncHandler(AdminFinanceController.deletePayout));
router.delete('/refunds/:id', asyncHandler(AdminFinanceController.deleteRefund));
router.get('/refunds', asyncHandler(DashboardController.getRefunds));
router.get('/refunds/:id', asyncHandler(AdminFinanceController.getRefundById));
router.patch('/refunds/:id/team-test', asyncHandler(AdminFinanceController.updateRefundTeamTest));
router.post('/refunds/manual', asyncHandler(AdminFinanceController.manualRefund));
router.get('/ledger', asyncHandler(DashboardController.getLedger));
router.get('/ledger/:id', asyncHandler(AdminFinanceController.getLedgerById));
router.get('/users', asyncHandler(AdminFinanceController.listUserProfiles));
router.get('/users/:userId/financial', asyncHandler(DashboardController.getUserFinancial));
router.get('/users/:id/financial-profile', asyncHandler(AdminFinanceController.getUserFinancialProfile));
router.post('/risk/freeze-user', asyncHandler(AdminFinanceController.freezeUser));
router.post('/risk/freeze-payout', asyncHandler(AdminFinanceController.freezePayout));
router.get('/anomalies', asyncHandler(DashboardController.getAnomalies));
router.get('/reconciliation', asyncHandler(DashboardController.getReconciliation));
router.get('/reconciliation/payin', asyncHandler(AdminFinanceController.getReconciliation)); // New: Admin payin recon
router.get('/reconciliation/payout', asyncHandler(AdminFinanceController.getReconciliation)); // New: Admin payout recon
router.get('/reconciliation/settlements', asyncHandler(AdminFinanceController.getReconciliation)); // New: Admin settlement recon
router.get('/reconciliation/export.csv', asyncHandler(DashboardController.exportReconciliationCsv));
router.get('/admin/team', asyncHandler(DashboardController.getAdminTeam));
router.post('/admin/invite', asyncHandler(DashboardController.inviteAdmin));
router.put('/admin/:id/role', asyncHandler(DashboardController.setAdminRole));
router.put('/admin/:id/disable', asyncHandler(DashboardController.disableAdmin));
router.get('/fees', asyncHandler(DashboardController.getFees));
router.get('/fees/categories', asyncHandler(DashboardController.getFeeCategories));
router.put('/fees/categories/:key', asyncHandler(DashboardController.upsertFeeCategory));

export default router;

