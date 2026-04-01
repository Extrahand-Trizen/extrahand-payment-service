import { Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { getAdminUser, verifyPassword } from '../services/adminAuthService';
 
export class AdminAuthController {
  static login = asyncHandler(async (req: Request, res: Response) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    const admin = await getAdminUser(username);
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    return res.status(200).json({ success: true, user: { username: admin.username } });
  });
}
