/**
 * Verification gate for payment service
 * 
 * STEP 5: Payment withdrawal verification requirements
 * - PAN verification required
 * - Bank account verification required
 */

export interface VerificationGateProfile {
  userType?: "individual" | "business";
  isPhoneVerified?: boolean;
  isEmailVerified?: boolean;
  isAadhaarVerified?: boolean;
  isBankVerified?: boolean;
  isPanVerified?: boolean;
  business?: {
    pan?: { isPANVerified?: boolean };
    bankAccount?: { isVerified?: boolean };
  };
}

export interface VerificationGateResult {
  allowed: boolean;
  missing: string[];
  message?: string;
}

function isPanVerified(profile: VerificationGateProfile | null): boolean {
  if (!profile) return false;
  if (profile.userType === "business") {
    return !!profile.business?.pan?.isPANVerified;
  }
  return !!profile.isPanVerified;
}

function isBankVerified(profile: VerificationGateProfile | null): boolean {
  if (!profile) return false;
  if (profile.userType === "business") {
    return !!profile.business?.bankAccount?.isVerified;
  }
  return !!profile.isBankVerified;
}

/**
 * STEP 5: Check if user can withdraw payments
 * Requirements: PAN + Bank verification
 */
export function getPaymentWithdrawalVerificationStatus(
  profile: VerificationGateProfile | null
): VerificationGateResult {
  const missing: string[] = [];
  
  if (!profile) {
    return { 
      allowed: false, 
      missing: ["PAN", "Bank Account"],
      message: "Verification required for withdrawals"
    };
  }

  const panVerified = isPanVerified(profile);
  const bankVerified = isBankVerified(profile);

  if (!panVerified) missing.push("PAN");
  if (!bankVerified) missing.push("Bank Account");

  return {
    allowed: missing.length === 0,
    missing,
    message: missing.length > 0 
      ? `Please verify your ${missing.join(" and ")} to withdraw payments` 
      : undefined
  };
}
