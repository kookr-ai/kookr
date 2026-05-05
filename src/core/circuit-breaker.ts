/**
 * Generic circuit breaker for protecting external service calls.
 *
 * States:
 *   closed     — normal operation, calls pass through
 *   open       — calls are rejected immediately (tripped after threshold failures)
 *   half-open  — limited test calls allowed after cooldown
 */

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Human-readable name (e.g. "llm", "github", "terminal"). */
  name: string;
  /** Number of failures within the window to trip the breaker. Default: 5. */
  failureThreshold?: number;
  /** Time window in ms for counting failures. Default: 60_000. */
  failureWindowMs?: number;
  /** Cooldown in ms before transitioning from open → half-open. Default: 30_000. */
  resetTimeoutMs?: number;
  /** Number of consecutive successes in half-open to close the breaker. Default: 2. */
  halfOpenSuccessThreshold?: number;
}

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  resetTimeoutMs: number;
}

export type CircuitBreakerListener = (snapshot: CircuitBreakerSnapshot) => void;

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly breakerName: string) {
    super(`Circuit breaker "${breakerName}" is open — call rejected`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  readonly name: string;
  private state: CircuitBreakerState = 'closed';
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenSuccessThreshold: number;

  /** Timestamps of recent failures (used for sliding window). */
  private failureTimestamps: number[] = [];
  private halfOpenSuccesses = 0;
  private lastFailureTime: number | null = null;
  private lastStateChange: number;

  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: CircuitBreakerListener[] = [];

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.failureThreshold = config.failureThreshold ?? 5;
    this.failureWindowMs = config.failureWindowMs ?? 60_000;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 30_000;
    this.halfOpenSuccessThreshold = config.halfOpenSuccessThreshold ?? 2;
    this.lastStateChange = Date.now();
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onChange(listener: CircuitBreakerListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Get a snapshot of the current breaker state. */
  getSnapshot(): CircuitBreakerSnapshot {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.recentFailureCount(),
      successCount: this.halfOpenSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastStateChange: this.lastStateChange,
      resetTimeoutMs: this.resetTimeoutMs,
    };
  }

  /**
   * Execute a function through the circuit breaker.
   * Throws CircuitBreakerOpenError if the breaker is open.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      throw new CircuitBreakerOpenError(this.name);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /** Record a successful call. */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
        this.transition('closed');
      }
    }
    // In closed state, successes are irrelevant to the breaker logic.
  }

  /** Record a failed call. */
  recordFailure(): void {
    const now = Date.now();
    this.lastFailureTime = now;
    this.failureTimestamps.push(now);

    if (this.state === 'half-open') {
      // Any failure in half-open immediately reopens
      this.transition('open');
      return;
    }

    if (this.state === 'closed') {
      if (this.recentFailureCount() >= this.failureThreshold) {
        this.transition('open');
      }
    }
  }

  /** Manually rearm (close) the breaker — used from the dashboard. */
  rearm(): void {
    if (this.state !== 'closed') {
      this.transition('closed');
    }
  }

  /** Clean up timers. */
  dispose(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    this.listeners = [];
  }

  /** Current state getter for testing. */
  getState(): CircuitBreakerState {
    return this.state;
  }

  // --- Internal ---

  private recentFailureCount(): number {
    const cutoff = Date.now() - this.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter(t => t > cutoff);
    return this.failureTimestamps.length;
  }

  private transition(newState: CircuitBreakerState): void {
    if (this.state === newState) return;

    // Clean up any pending reset timer
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }

    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === 'open') {
      // Schedule auto-transition to half-open after cooldown
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null;
        this.transition('half-open');
      }, this.resetTimeoutMs);
    }

    if (newState === 'half-open') {
      this.halfOpenSuccesses = 0;
    }

    if (newState === 'closed') {
      this.failureTimestamps = [];
      this.halfOpenSuccesses = 0;
    }

    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

/**
 * Registry managing all circuit breakers in the system.
 * Broadcasts state changes via a single listener.
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private registryListeners: CircuitBreakerListener[] = [];

  /** Register a circuit breaker and subscribe to its state changes. */
  register(breaker: CircuitBreaker): void {
    this.breakers.set(breaker.name, breaker);
    breaker.onChange((snapshot) => {
      for (const listener of this.registryListeners) {
        listener(snapshot);
      }
    });
  }

  /** Get a breaker by name. */
  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  /** Get snapshots of all registered breakers. */
  getAllSnapshots(): CircuitBreakerSnapshot[] {
    return Array.from(this.breakers.values()).map(b => b.getSnapshot());
  }

  /** Rearm a specific breaker by name. Returns true if found. */
  rearm(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (!breaker) return false;
    breaker.rearm();
    return true;
  }

  /** Subscribe to state changes from any registered breaker. */
  onChange(listener: CircuitBreakerListener): () => void {
    this.registryListeners.push(listener);
    return () => {
      this.registryListeners = this.registryListeners.filter(l => l !== listener);
    };
  }

  /** Clean up all breakers. */
  dispose(): void {
    for (const breaker of this.breakers.values()) {
      breaker.dispose();
    }
    this.breakers.clear();
    this.registryListeners = [];
  }
}
