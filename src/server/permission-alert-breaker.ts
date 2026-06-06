import { CircuitBreaker } from '../core/circuit-breaker.js';

export function createPermissionAlertBreaker(): CircuitBreaker {
  return new CircuitBreaker({
    name: 'permission-alert',
    failureThreshold: 3,
    failureWindowMs: 60_000,
    resetTimeoutMs: 30_000,
  });
}
