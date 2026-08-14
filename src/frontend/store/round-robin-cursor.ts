import { useKookrStore } from './useStore.js';

/** Apply the server-managed rotation cursor from settings or grok-auth preflight. */
export function applyRoundRobinIndex(index: unknown): void {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
  useKookrStore.setState({ roundRobinIndex: index });
}
