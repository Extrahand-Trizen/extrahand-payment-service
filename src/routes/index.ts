import express from 'express';
import paymentRoutes from './payment';
import escrowRoutes from './escrow';
import webhookRoutes from './webhooks';
import refundRoutes from './refunds';
import payoutRoutes from './payouts';
import earningsRoutes from './earnings';
import transactionRoutes from './transactions';
import feesRoutes from './fees';
import adminRoutes from './admin';
import cascadeDeleteRoutes from './cascadeDelete';
import bankAccountRoutes from './bankAccounts';
import dashboardRoutes from './dashboard';
import { validateEnv } from '../config/env';
import { isDatabaseConnected, isPostgresConnected } from '../config/database';

const router = express.Router();
const env = validateEnv();

// Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'extrahand-payment-service',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: env.NODE_ENV,
    razorpay: 'configured',
    mongodb: isDatabaseConnected() ? 'connected' : 'disconnected',
    postgres: isPostgresConnected() ? 'connected' : 'disconnected',
  });
});

// Payment routes
router.use('/payment', paymentRoutes);

// Escrow routes
router.use('/escrow', escrowRoutes);

// Webhook routes (no service auth required - Razorpay calls these directly)
router.use('/webhooks', webhookRoutes);

// Refund routes
router.use('/refunds', refundRoutes);

// Payout routes
router.use('/payouts', payoutRoutes);

// Bank account routes
router.use('/bank-accounts', bankAccountRoutes);

// Earnings routes
router.use('/earnings', earningsRoutes);

// Transaction history routes
router.use('/transactions', transactionRoutes);

// Fee structure routes (public - returns percentages only)
router.use('/fees', feesRoutes);

// Admin auth routes
router.use('/admin', adminRoutes);

// Cascade delete routes (service auth)
router.use('/cascade-delete', cascadeDeleteRoutes);

// Internal dashboard routes (service auth)
router.use('/dashboard', dashboardRoutes);

export default router;

