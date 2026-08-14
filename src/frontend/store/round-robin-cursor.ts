import { ROUND_ROBIN_AGENT_TYPE, type AgentSelection } from '../../shared/protocol.js';
import { useKookrStore } from './useStore.js';

/** Apply the server-managed rotation cursor from settings. */
export function applyRoundRobinIndex(index: unknown): void {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return;
  useKookrStore.setState({ roundRobinIndex: index });
}

/**
 * Advance the local cursor after a successful round-robin launch so the
 * picker "Next:" line matches the next server resolution without waiting
 * for another settings fetch.
 */
export function noteRoundRobinLaunch(agentType: AgentSelection | ''): void {
  if (agentType !== ROUND_ROBIN_AGENT_TYPE) return;
  useKookrStore.setState((state) => ({ roundRobinIndex: state.roundRobinIndex + 1 }));
}
