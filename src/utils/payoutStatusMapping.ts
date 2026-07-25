export function mapRazorpayPayoutStatusToInternal(razorpayStatus?: string | null): string {
  const s = String(razorpayStatus || '').toLowerCase().trim();

  if (!s) return 'processing';

  if (s === 'processed' || s === 'completed' || s === 'success' || s === 'created') return 'completed';
  if (s === 'failed' || s === 'failure') return 'failed';
  if (s === 'reversed') return 'reversed';

  // Common "still in progress" states returned by payout APIs.
  if (s === 'processing' || s === 'queued') return 'processing';

  return 'processing';
}
