export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerSnapshot {
  name: string;
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  lastStateChange: number;
  resetTimeoutMs: number;
}
