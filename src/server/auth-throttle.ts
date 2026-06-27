export type AuthThrottleRejectReason =
  | 'no_credential'
  | 'cookie_missing'
  | 'bad_token'
  | 'revoked'
  | 'expired'
  | 'cross_origin'
  | 'viewer_route_denied'
  | 'throttled';

export interface AuthThrottleOptions {
  freeFailures?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxEntries?: number;
  auditBurstWindowMs?: number;
  failureWindowMs?: number;
  nowMs?: () => number;
  audit?: (record: AuthThrottleAuditRecord) => void;
}

export interface AuthThrottleAuditRecord {
  event: 'auth_failure_burst';
  source: string;
  failures: number;
  reason: AuthThrottleRejectReason;
  lockoutMs: number;
  throttledAttempts: number;
}

export interface AuthThrottleSnapshot {
  schemaVersion: 'auth-throttle.v1';
  totalFailedAttempts: number;
  totalThrottledAttempts: number;
  activeSourceCount: number;
  lockedOutSources: Array<{
    source: string;
    failures: number;
    retryAfterMs: number;
    throttledAttempts: number;
    lastReason: AuthThrottleRejectReason;
  }>;
}

interface SourceState {
  failures: number;
  lockedUntilMs: number;
  lastAttemptMs: number;
  lastAuditMs: number;
  throttledAttempts: number;
  lastReason: AuthThrottleRejectReason;
}

const DEFAULT_FREE_FAILURES = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_024;
const DEFAULT_AUDIT_BURST_WINDOW_MS = 60_000;
const DEFAULT_FAILURE_WINDOW_MS = 5 * 60_000;

function defaultAudit(record: AuthThrottleAuditRecord): void {
  console.warn(JSON.stringify(record));
}

function normalizeSource(source: string | undefined | null): string {
  const normalized = source?.trim();
  return normalized || 'unknown';
}

export class AuthThrottle {
  private readonly freeFailures: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxEntries: number;
  private readonly auditBurstWindowMs: number;
  private readonly failureWindowMs: number;
  private readonly nowMs: () => number;
  private readonly audit: (record: AuthThrottleAuditRecord) => void;
  private readonly sources = new Map<string, SourceState>();
  private totalFailedAttempts = 0;
  private totalThrottledAttempts = 0;

  constructor(opts: AuthThrottleOptions = {}) {
    this.freeFailures = opts.freeFailures ?? DEFAULT_FREE_FAILURES;
    this.baseBackoffMs = opts.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.auditBurstWindowMs = opts.auditBurstWindowMs ?? DEFAULT_AUDIT_BURST_WINDOW_MS;
    this.failureWindowMs = opts.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.nowMs = opts.nowMs ?? Date.now;
    this.audit = opts.audit ?? defaultAudit;
  }

  isLockedOut(source: string | undefined | null): boolean {
    const state = this.sources.get(normalizeSource(source));
    return state ? state.lockedUntilMs > this.nowMs() : false;
  }

  recordFailure(source: string | undefined | null, reason: AuthThrottleRejectReason): void {
    const key = normalizeSource(source);
    const now = this.nowMs();
    const state = this.touch(key, now);
    state.failures += 1;
    state.lastAttemptMs = now;
    state.lastReason = reason;
    this.totalFailedAttempts += 1;

    const lockoutMs = this.backoffMsForFailures(state.failures);
    if (lockoutMs > 0) {
      state.lockedUntilMs = Math.max(state.lockedUntilMs, now + lockoutMs);
      this.maybeAuditBurst(key, state, reason, lockoutMs, now);
    }
  }

  recordThrottledAttempt(source: string | undefined | null, reason: AuthThrottleRejectReason = 'throttled'): void {
    const key = normalizeSource(source);
    const now = this.nowMs();
    const state = this.touch(key, now);
    state.throttledAttempts += 1;
    state.lastAttemptMs = now;
    state.lastReason = reason;
    this.totalThrottledAttempts += 1;

    const retryAfterMs = Math.max(0, state.lockedUntilMs - now);
    if (retryAfterMs > 0) {
      this.maybeAuditBurst(key, state, reason, retryAfterMs, now);
    }
  }

  reset(source: string | undefined | null): void {
    this.sources.delete(normalizeSource(source));
  }

  snapshot(): AuthThrottleSnapshot {
    const now = this.nowMs();
    const lockedOutSources = Array.from(this.sources.entries())
      .filter(([, state]) => state.lockedUntilMs > now)
      .map(([source, state]) => ({
        source,
        failures: state.failures,
        retryAfterMs: Math.max(0, state.lockedUntilMs - now),
        throttledAttempts: state.throttledAttempts,
        lastReason: state.lastReason,
      }));

    return {
      schemaVersion: 'auth-throttle.v1',
      totalFailedAttempts: this.totalFailedAttempts,
      totalThrottledAttempts: this.totalThrottledAttempts,
      activeSourceCount: this.sources.size,
      lockedOutSources,
    };
  }

  private touch(source: string, now: number): SourceState {
    const existing = this.sources.get(source);
    if (existing) {
      if (this.shouldResetState(existing, now)) {
        existing.failures = 0;
        existing.lockedUntilMs = 0;
        existing.lastAuditMs = Number.NEGATIVE_INFINITY;
        existing.throttledAttempts = 0;
        existing.lastReason = 'bad_token';
      }
      this.sources.delete(source);
      this.sources.set(source, existing);
      return existing;
    }

    const created: SourceState = {
      failures: 0,
      lockedUntilMs: 0,
      lastAttemptMs: now,
      lastAuditMs: Number.NEGATIVE_INFINITY,
      throttledAttempts: 0,
      lastReason: 'bad_token',
    };
    this.sources.set(source, created);
    while (this.sources.size > this.maxEntries) {
      const oldest = this.sources.keys().next().value;
      if (oldest === undefined) break;
      this.sources.delete(oldest);
    }
    return created;
  }

  private shouldResetState(state: SourceState, now: number): boolean {
    if (state.lockedUntilMs > 0 && state.lockedUntilMs <= now) return true;
    return now - state.lastAttemptMs > this.failureWindowMs;
  }

  private backoffMsForFailures(failures: number): number {
    const penalizedFailures = failures - this.freeFailures;
    if (penalizedFailures <= 0) return 0;
    const exponent = Math.min(penalizedFailures - 1, 20);
    return Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** exponent);
  }

  private maybeAuditBurst(
    source: string,
    state: SourceState,
    reason: AuthThrottleRejectReason,
    lockoutMs: number,
    now: number,
  ): void {
    if (now - state.lastAuditMs < this.auditBurstWindowMs) return;
    state.lastAuditMs = now;
    this.audit({
      event: 'auth_failure_burst',
      source,
      failures: state.failures,
      reason,
      lockoutMs,
      throttledAttempts: state.throttledAttempts,
    });
  }
}
