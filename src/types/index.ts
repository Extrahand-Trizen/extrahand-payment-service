import { Request } from 'express';

// Extended Express Request with user
export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    token?: string;
  };
  rateLimitUserId?: string;
  isServiceCall?: boolean; // Indicates if request came from another service
  serviceName?: string; // Name of the calling service
}

// Service response types
export interface ServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// API Response types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Payment types
export interface CreateOrderRequest {
  amount: number;
  currency?: string;
  metadata?: Record<string, any>;
}

export interface VerifyPaymentRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface CreateEscrowRequest {
  taskId: string;
  applicationId?: string;
  posterUid: string;
  performerUid: string;
  amount: number;
  currency?: string;
  autoReleaseAfterDays?: number;
  taskCategory?: string;
  metadata?: Record<string, any>;
}

export interface ProcessPayoutRequest {
  razorpayOrderId: string;
  performerUid: string;
  bankAccountId?: string;
  accountNumber?: string;
  ifscCode?: string;
  accountHolderName?: string;
  bankName?: string;
  userId?: string;
}

export interface ProcessRefundRequest {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  reason?: string;
  cancelledBy: 'poster' | 'performer';
  taskStartDate: Date | string;
  cancelledAt: Date | string;
  userId?: string;
  amount?: number;
}

export interface TransactionQueryParams {
  limit?: number;
  offset?: number;
  startDate?: Date | string;
  endDate?: Date | string;
  type?: 'payment' | 'payout' | 'refund' | 'compensation' | 'fee' | 'escrow';
  status?: string;
  category?: 'earnings' | 'payments' | 'all';
}


