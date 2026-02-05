/**
 * Decimal128 Utility Functions
 * 
 * Helper functions to convert between JavaScript numbers and MongoDB Decimal128
 * for exact money calculations (prevents floating-point errors)
 */

import mongoose from 'mongoose';

/**
 * Convert a number to MongoDB Decimal128
 * 
 * @param value - Number to convert (can be number or string)
 * @returns Decimal128 instance
 */
export function toDecimal128(value: number | string): mongoose.Types.Decimal128 {
  if (typeof value === 'string') {
    return mongoose.Types.Decimal128.fromString(value);
  }
  // Convert number to string with proper precision
  // Use toFixed to avoid floating-point representation issues
  return mongoose.Types.Decimal128.fromString(value.toFixed(2));
}

/**
 * Convert MongoDB Decimal128 to number
 * 
 * @param value - Decimal128 instance or number
 * @returns Number value
 */
export function fromDecimal128(value: mongoose.Types.Decimal128 | number | null | undefined): number {
  if (!value) {
    return 0;
  }
  
  if (typeof value === 'number') {
    return value;
  }
  
  if (value instanceof mongoose.Types.Decimal128) {
    return parseFloat(value.toString());
  }
  
  return 0;
}

/**
 * Convert paise (integer) to Decimal128
 * Useful for Razorpay amounts which are in paise
 * 
 * @param paise - Amount in paise (integer)
 * @returns Decimal128 instance
 */
export function paiseToDecimal128(paise: number): mongoose.Types.Decimal128 {
  // Paise is already an integer, so we can convert directly
  return mongoose.Types.Decimal128.fromString(paise.toString());
}

/**
 * Convert rupees to Decimal128
 * 
 * @param rupees - Amount in rupees (can have decimals)
 * @returns Decimal128 instance
 */
export function rupeesToDecimal128(rupees: number): mongoose.Types.Decimal128 {
  // Use toFixed(2) to ensure 2 decimal places
  return mongoose.Types.Decimal128.fromString(rupees.toFixed(2));
}

/**
 * Convert Decimal128 to rupees (number)
 * 
 * @param value - Decimal128 instance
 * @returns Number in rupees
 */
export function decimal128ToRupees(value: mongoose.Types.Decimal128 | number | null | undefined): number {
  return fromDecimal128(value);
}

/**
 * Convert Decimal128 to paise (integer)
 * 
 * @param value - Decimal128 instance
 * @returns Number in paise (integer)
 */
export function decimal128ToPaise(value: mongoose.Types.Decimal128 | number | null | undefined): number {
  const rupees = fromDecimal128(value);
  return Math.round(rupees * 100);
}








