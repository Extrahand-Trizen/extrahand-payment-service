import logger from '../config/logger';

export type CircuitState = 'closed' | 'open' | 'half_open';

export type CircuitBreakerOptions = {
  failureThreshold?: number;
  resetTimeoutMs?: number;
};

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(
    private readonly name: string,
    private readonly options: CircuitBreakerOptions = {}
  ) {}

  private failureThreshold(): number {
    return this.options.failureThreshold ?? 5;
  }

  private resetTimeoutMs(): number {
    return this.options.resetTimeoutMs ?? 120_000;
  }

  private refreshStateIfCooldownElapsed(): void {
    if (this.state !== 'open') return;
    if (Date.now() - this.openedAt >= this.resetTimeoutMs()) {
      this.state = 'half_open';
      this.probeInFlight = false;
    }
  }

  getState(): CircuitState {
    this.refreshStateIfCooldownElapsed();
    return this.state;
  }

  isCallAllowed(): boolean {
    this.refreshStateIfCooldownElapsed();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.probeInFlight = false;
    if (this.state === 'half_open') {
      this.trip();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold()) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = Date.now();
    this.consecutiveFailures = this.failureThreshold();
    logger.warn('Circuit breaker OPEN — downstream calls skipped', {
      circuit: this.name,
      resetTimeoutMs: this.resetTimeoutMs(),
    });
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const messagingServiceCircuit = new CircuitBreaker('messaging-service', {
  failureThreshold: envInt('MESSAGING_CIRCUIT_FAILURE_THRESHOLD', 5),
  resetTimeoutMs: envInt('MESSAGING_CIRCUIT_RESET_MS', 120_000),
});
