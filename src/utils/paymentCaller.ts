import { Request } from 'express';
import { UnauthorizedError } from '../errors/AppError';

/**
 * Who is asking for a refund / cancellation. Every caller holds the service token, so the token
 * alone says nothing about the end user:
 * - trusted backends (task-service, main admin) authorize the user/admin themselves;
 * - the api-gateway (or any caller naming a user) relays an app request for the verified user
 *   in X-User-Id / X-Profile-Id and may only act on that user's own payments;
 * - an unnamed backend that names no user (legacy server-to-server job) keeps internal behaviour.
 */
const TRUSTED_INTERNAL_SERVICES = new Set(['task-service', 'main-admin-service']);
/** Only task-service computes Hourly Helper cancellation settlements. */
const SETTLEMENT_SERVICES = new Set(['task-service']);

export type PaymentCaller =
  | { kind: 'internal'; service: string }
  | { kind: 'user'; service: string; uids: string[] };

const str = (value: unknown): string => (value == null ? '' : String(value).trim());

function header(req: Request, name: string): string {
  const value = req.headers?.[name];
  return str(Array.isArray(value) ? value[0] : value);
}

export function resolvePaymentCaller(req: Request): PaymentCaller {
  const service = header(req, 'x-service-name');
  if (TRUSTED_INTERNAL_SERVICES.has(service)) return { kind: 'internal', service };
  const uids = [...new Set([header(req, 'x-user-id'), header(req, 'x-profile-id')].filter(Boolean))];
  if (service === 'api-gateway' || uids.length > 0) return { kind: 'user', service, uids };
  return { kind: 'internal', service };
}

export function callerMaySupplySettlement(caller: PaymentCaller): boolean {
  return caller.kind === 'internal' && SETTLEMENT_SERVICES.has(caller.service);
}

/** The verified identities of a user caller; a relayed request without one is rejected. */
export function requireCallerIdentity(caller: Extract<PaymentCaller, { kind: 'user' }>): string[] {
  if (caller.uids.length === 0) throw new UnauthorizedError('Authenticated user required');
  return caller.uids;
}

/** The caller's role on this payment, from the escrow record only. */
export function callerRoleForEscrow(
  escrow: { posterUid?: unknown; performerUid?: unknown } | null | undefined,
  uids: string[],
): 'poster' | 'performer' | null {
  const poster = str(escrow?.posterUid);
  if (poster && uids.includes(poster)) return 'poster';
  const performer = str(escrow?.performerUid);
  if (performer && performer !== 'pending_assignment' && uids.includes(performer)) return 'performer';
  return null;
}
