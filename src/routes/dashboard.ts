import express from 'express';
import { serviceAuthMiddleware } from '../middleware/serviceAuth';
import { asyncHandler } from '../middleware/errorHandler';
import { DashboardController } from '../controllers/DashboardController';

const router = express.Router();

// All dashboard routes are internal service-to-service endpoints
router.use(serviceAuthMiddleware);

router.get('/overview', asyncHandler(DashboardController.getOverview));
router.get('/transactions', asyncHandler(DashboardController.getTransactions));
router.get('/transactions/:id', asyncHandler(DashboardController.getTransactionTrace));
router.get('/payouts', asyncHandler(DashboardController.getPayouts));
router.post('/payouts/:id/retry', asyncHandler(DashboardController.retryPayout));
router.get('/refunds', asyncHandler(DashboardController.getRefunds));
router.get('/ledger', asyncHandler(DashboardController.getLedger));
router.get('/users/:userId/financial', asyncHandler(DashboardController.getUserFinancial));
router.get('/anomalies', asyncHandler(DashboardController.getAnomalies));
router.get('/reconciliation', asyncHandler(DashboardController.getReconciliation));
router.get('/reconciliation/export.csv', asyncHandler(DashboardController.exportReconciliationCsv));
router.get('/admin/team', asyncHandler(DashboardController.getAdminTeam));
router.post('/admin/invite', asyncHandler(DashboardController.inviteAdmin));
router.put('/admin/:id/role', asyncHandler(DashboardController.setAdminRole));
router.put('/admin/:id/disable', asyncHandler(DashboardController.disableAdmin));
router.get('/fees', asyncHandler(DashboardController.getFees));
router.get('/fees/categories', asyncHandler(DashboardController.getFeeCategories));
router.put('/fees/categories/:key', asyncHandler(DashboardController.upsertFeeCategory));

export default router;

