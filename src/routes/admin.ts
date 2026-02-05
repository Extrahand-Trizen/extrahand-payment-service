import express from 'express';
import { AdminAuthController } from '../controllers/AdminAuthController';

const router = express.Router();

router.post('/login', AdminAuthController.login);

export default router;
