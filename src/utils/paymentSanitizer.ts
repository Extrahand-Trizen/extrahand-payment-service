/**
 * Payment Data Sanitization Utility
 * 
 * Removes sensitive payment data (card numbers, CVV, expiry) from Razorpay responses
 * to ensure PCI DSS compliance. Only safe fields are stored.
 */

/**
 * Interface for sanitized Razorpay payment card data
 */
export interface SanitizedCardData {
  id?: string;
  entity?: string;
  name?: string; // Cardholder name (safe)
  last4?: string; // Last 4 digits (safe)
  network?: string; // Visa/Mastercard (safe)
  type?: string; // credit/debit (safe)
  issuer?: string; // Bank name (safe)
  international?: boolean;
  emi?: boolean;
  sub_type?: string;
  token_iin?: string; // Token IIN (safe)
  // Explicitly excluded: number, expiry_month, expiry_year, cvv
}

/**
 * Interface for sanitized Razorpay payment response
 */
export interface SanitizedPaymentData {
  id: string;
  entity: string;
  amount: number;
  currency: string;
  status: string;
  method: string;
  card?: SanitizedCardData;
  // Other safe fields from Razorpay payment response
  [key: string]: any;
}

function maskUpiId(upiId: string | undefined): string | undefined {
  const value = (upiId || '').trim();
  if (!value.includes('@')) {
    return value || undefined;
  }

  const [localPart, handle] = value.split('@');
  if (!localPart || !handle) {
    return value;
  }

  const visiblePrefix = localPart.slice(0, Math.min(3, localPart.length));
  const maskedLocal = `${visiblePrefix}${'*'.repeat(Math.max(4, localPart.length - visiblePrefix.length))}`;
  return `${maskedLocal}@${handle}`;
}

/**
 * Sanitize Razorpay payment data - removes sensitive card information
 * 
 * @param paymentData - Raw Razorpay payment response
 * @returns Sanitized payment data with only safe fields
 */
export function sanitizeRazorpayPaymentData(paymentData: any): SanitizedPaymentData | null {
  if (!paymentData) {
    return null;
  }

  // Create a copy to avoid mutating the original
  const sanitized: any = { ...paymentData };

  // If card data exists, sanitize it
  if (sanitized.card && typeof sanitized.card === 'object') {
    const card = sanitized.card;
    
    // Only keep safe fields
    sanitized.card = {
      id: card.id,
      entity: card.entity,
      name: card.name, // Cardholder name (safe)
      last4: card.last4, // Last 4 digits (safe)
      network: card.network, // Visa/Mastercard (safe)
      type: card.type, // credit/debit (safe)
      issuer: card.issuer, // Bank name (safe)
      international: card.international,
      emi: card.emi,
      sub_type: card.sub_type,
      token_iin: card.token_iin, // Token IIN (safe)
      // Explicitly exclude: number, expiry_month, expiry_year, cvv
    };

    // Remove any undefined fields
    Object.keys(sanitized.card).forEach(key => {
      if (sanitized.card[key] === undefined) {
        delete sanitized.card[key];
      }
    });
  }

  // Mask UPI identifiers (VPA) when present.
  if (typeof sanitized.vpa === 'string') {
    sanitized.vpa = maskUpiId(sanitized.vpa);
  }

  if (typeof sanitized.upi_id === 'string') {
    sanitized.upi_id = maskUpiId(sanitized.upi_id);
  }

  if (typeof sanitized.upiId === 'string') {
    sanitized.upiId = maskUpiId(sanitized.upiId);
  }

  if (sanitized.upi && typeof sanitized.upi === 'object') {
    const upiObj: any = { ...sanitized.upi };
    if (typeof upiObj.vpa === 'string') {
      upiObj.vpa = maskUpiId(upiObj.vpa);
    }
    if (typeof upiObj.upi_id === 'string') {
      upiObj.upi_id = maskUpiId(upiObj.upi_id);
    }
    if (typeof upiObj.upiId === 'string') {
      upiObj.upiId = maskUpiId(upiObj.upiId);
    }
    sanitized.upi = upiObj;
  }

  // Remove any potentially sensitive fields from notes or other locations
  if (sanitized.notes) {
    const safeNotes = { ...sanitized.notes };
    delete safeNotes.card_number;
    delete safeNotes.cvv;
    delete safeNotes.expiry;
    delete safeNotes.expiry_month;
    delete safeNotes.expiry_year;
    if (typeof safeNotes.vpa === 'string') {
      safeNotes.vpa = maskUpiId(safeNotes.vpa);
    }
    if (typeof safeNotes.upiId === 'string') {
      safeNotes.upiId = maskUpiId(safeNotes.upiId);
    }
    if (typeof safeNotes.upi_id === 'string') {
      safeNotes.upi_id = maskUpiId(safeNotes.upi_id);
    }
    sanitized.notes = safeNotes;
  }

  // Remove any other potentially sensitive fields at root level
  const sensitiveFields = ['number', 'card_number', 'cvv', 'cvv2', 'expiry', 'expiry_month', 'expiry_year'];
  sensitiveFields.forEach(field => {
    if (sanitized[field] !== undefined) {
      delete sanitized[field];
    }
  });

  return sanitized as SanitizedPaymentData;
}

/**
 * Sanitize Razorpay order data - orders are generally safe, but we sanitize any nested payment data
 * 
 * @param orderData - Raw Razorpay order response
 * @returns Sanitized order data
 */
export function sanitizeRazorpayOrderData(orderData: any): any | null {
  if (!orderData) {
    return null;
  }

  // Orders typically don't contain sensitive data, but we sanitize to be safe
  const sanitized = { ...orderData };

  // If order contains payment data, sanitize it
  if (sanitized.payments && Array.isArray(sanitized.payments)) {
    sanitized.payments = sanitized.payments.map((payment: any) => 
      sanitizeRazorpayPaymentData(payment)
    );
  }

  // Remove any sensitive fields from notes
  if (sanitized.notes) {
    const safeNotes = { ...sanitized.notes };
    delete safeNotes.card_number;
    delete safeNotes.cvv;
    delete safeNotes.expiry;
    sanitized.notes = safeNotes;
  }

  return sanitized;
}

/**
 * Sanitize Razorpay refund data - refunds are generally safe, but we sanitize any nested payment data
 * 
 * @param refundData - Raw Razorpay refund response
 * @returns Sanitized refund data
 */
export function sanitizeRazorpayRefundData(refundData: any): any | null {
  if (!refundData) {
    return null;
  }

  // Refunds typically don't contain sensitive data, but we sanitize to be safe
  const sanitized = { ...refundData };

  // If refund contains payment data, sanitize it
  if (sanitized.payment && typeof sanitized.payment === 'object') {
    sanitized.payment = sanitizeRazorpayPaymentData(sanitized.payment);
  }

  // Remove any sensitive fields from notes
  if (sanitized.notes) {
    const safeNotes = { ...sanitized.notes };
    delete safeNotes.card_number;
    delete safeNotes.cvv;
    delete safeNotes.expiry;
    sanitized.notes = safeNotes;
  }

  return sanitized;
}

/**
 * Create a masked card fingerprint for display purposes
 * 
 * @param cardData - Card data (can be sanitized or raw)
 * @returns Masked card fingerprint string (e.g., "XXXX XXXX XXXX 1234")
 */
export function createCardFingerprint(cardData: any): string {
  if (!cardData) {
    return 'XXXX XXXX XXXX XXXX';
  }

  const last4 = cardData.last4 || cardData.number?.slice(-4);
  if (!last4) {
    return 'XXXX XXXX XXXX XXXX';
  }

  return `XXXX XXXX XXXX ${last4}`;
}

/**
 * Sanitize entire razorpayData object (used in PaymentTransaction model)
 * 
 * @param razorpayData - Object containing order, payment, and/or refund data
 * @returns Sanitized razorpayData object
 */
export function sanitizeRazorpayData(razorpayData: {
  order?: any;
  payment?: any;
  refund?: any;
}): {
  order?: any;
  payment?: any;
  refund?: any;
} {
  const sanitized: any = {};

  if (razorpayData.order) {
    sanitized.order = sanitizeRazorpayOrderData(razorpayData.order);
  }

  if (razorpayData.payment) {
    sanitized.payment = sanitizeRazorpayPaymentData(razorpayData.payment);
  }

  if (razorpayData.refund) {
    sanitized.refund = sanitizeRazorpayRefundData(razorpayData.refund);
  }

  return sanitized;
}

/** Razorpay orders.notes: max 15 keys, string values (256 chars each). */
export const RAZORPAY_NOTES_MAX_KEYS = 15;
const RAZORPAY_NOTE_VALUE_MAX_LEN = 256;

const RAZORPAY_NOTE_PRIORITY_KEYS = [
  'type',
  'taskId',
  'applicationId',
  'posterUid',
  'performerUid',
  'bookingOrderId',
  'bookingMode',
  'originalAmountRupees',
  'customerCoinDiscountRupees',
  'pendingCustomerCoinDiscountRupees',
  'taskCategory',
  'taskTitle',
] as const;

function stringifyRazorpayNoteValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return null;
  const str = String(value).trim();
  if (!str.length) return null;
  return str.length > RAZORPAY_NOTE_VALUE_MAX_LEN
    ? str.slice(0, RAZORPAY_NOTE_VALUE_MAX_LEN)
    : str;
}

/**
 * Build Razorpay order notes from metadata. Full metadata is stored on Escrow;
 * only correlation ids and amounts are sent to Razorpay (15-key limit).
 */
export function buildRazorpayOrderNotes(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const notes: Record<string, string> = {};

  const add = (key: string, value: unknown) => {
    if (Object.keys(notes).length >= RAZORPAY_NOTES_MAX_KEYS) return;
    if (key in notes) return;
    const str = stringifyRazorpayNoteValue(value);
    if (str != null) notes[key] = str;
  };

  for (const key of RAZORPAY_NOTE_PRIORITY_KEYS) {
    if (key in metadata) add(key, metadata[key]);
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(notes).length >= RAZORPAY_NOTES_MAX_KEYS) break;
    add(key, value);
  }

  return notes;
}

