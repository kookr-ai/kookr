import { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { isDndEnabled } from './useDnd.js';
import { isActiveFinding } from '../store/finding-helpers.js';
import type { AgentState } from '../../shared/protocol.js';

const STORAGE_KEY = 'kookr-sound-enabled';

// After an agent leaves the findings list, suppress re-chimes for this long.
// Guards against transient anomaly flicker (subagent boundaries, watchdog
// re-evaluation, brief stale_agent oscillation) where the same logical issue
// rapidly cycles in and out of finding state with a fresh detectedAt each time.
export const RECHIME_COOLDOWN_MS = 30_000;

/** Read mute preference from localStorage (default: enabled). */
export function isSoundEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== 'false';
}

/** Persist mute preference. */
export function setSoundEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(enabled));
}

/**
 * Play a short two-tone chime via Web Audio API.
 * Gracefully handles browsers that block AudioContext before user interaction.
 */
function playChime(): void {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    // First tone: A5 (880 Hz)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.frequency.value = 880;
    osc1.type = 'sine';
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc1.start(now);
    osc1.stop(now + 0.3);

    // Second tone: C#6 (1109 Hz) — rising interval for urgency
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.frequency.value = 1109;
    osc2.type = 'sine';
    gain2.gain.setValueAtTime(0.25, now + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    osc2.start(now + 0.15);
    osc2.stop(now + 0.5);

    // Clean up after playback
    setTimeout(() => void ctx.close(), 600);
  } catch {
    // AudioContext blocked by browser autoplay policy — silently ignore
  }
}

/**
 * Stable identity for a single logical finding: type + detectedAt.
 * attention-queue.ts preserves detectedAt across re-enqueues of the same
 * anomaly type, so this triple does not change while the same finding stays
 * on the queue — even if the watchdog re-evaluates and rebuilds the Anomaly.
 *
 * Returns null for any anomaly missing detectedAt; such an anomaly cannot be
 * deduped reliably and is excluded from the audible-chime path entirely
 * rather than collapsing every undated finding into a single key.
 */
function findingKey(agent: AgentState): string | null {
  if (!agent.anomaly?.detectedAt) return null;
  const detectedAt = agent.anomaly.detectedAt instanceof Date
    ? agent.anomaly.detectedAt.toISOString()
    : String(agent.anomaly.detectedAt);
  return `${agent.anomaly.type}:${detectedAt}`;
}

export interface ChimeRecord {
  /** Key of the finding most recently associated with this agent. */
  key: string;
  /** null = agent currently in findings; non-null = post-clear cooldown deadline. */
  cooldownUntil: number | null;
}

/**
 * Pure decision function for the audible chime.
 *
 * Mutates `state` in place to track per-agent dedup keys and post-clear
 * cooldowns. Returns true when at least one new high-severity finding has
 * appeared that should produce an audible chime.
 *
 * Exported for unit testing — the React hook below is a thin wrapper.
 */
export function evaluateChime(
  agents: AgentState[],
  state: Map<string, ChimeRecord>,
  now: number,
): boolean {
  const activeAgentIds = new Set<string>();
  let shouldChime = false;

  for (const agent of agents) {
    if (!isActiveFinding(agent)) continue;
    activeAgentIds.add(agent.agentId);

    const severity = agent.anomaly?.severity;
    if (severity !== 'critical' && severity !== 'warning') continue;

    const key = findingKey(agent);
    if (!key) continue;

    const prior = state.get(agent.agentId);
    if (prior?.key === key) continue;
    if (prior?.cooldownUntil != null && prior.cooldownUntil > now) {
      // In flicker cooldown — suppress, but record the new key so the chime
      // does not fire when the cooldown later expires while this same anomaly
      // is still on the queue.
      state.set(agent.agentId, { key, cooldownUntil: prior.cooldownUntil });
      continue;
    }

    shouldChime = true;
    state.set(agent.agentId, { key, cooldownUntil: null });
  }

  // Sweep agents that have left findings: start cooldown, or evict if the
  // cooldown has already elapsed.
  for (const [agentId, record] of state) {
    if (activeAgentIds.has(agentId)) continue;
    if (record.cooldownUntil === null) {
      state.set(agentId, { key: record.key, cooldownUntil: now + RECHIME_COOLDOWN_MS });
    } else if (record.cooldownUntil <= now) {
      state.delete(agentId);
    }
  }

  return shouldChime;
}

/**
 * Per-tab dedup state for the chime. Module-scoped on purpose: useRef would
 * be reset by React StrictMode's mount→unmount→mount cycle in development,
 * causing every active finding to re-chime on second mount. The hook is a
 * singleton inside <App />, so module scope and a hook-private Map are
 * functionally identical for production but stable across StrictMode mounts.
 */
const chimedState = new Map<string, ChimeRecord>();

/**
 * Plays an audible chime when an agent enters the Supervisor Findings list
 * with a warning- or critical-severity anomaly. Respects the mute toggle
 * and DND.
 *
 * Uses the same predicate as the Findings panel (isActiveFinding) and dedups
 * by (agentId, anomaly.type, anomaly.detectedAt) so a single finding chimes
 * exactly once even as the watchdog re-evaluates and re-enqueues. A short
 * post-clear cooldown suppresses chimes from anomalies that briefly clear
 * and re-appear (subagent boundary flicker).
 */
export function useAudibleAlert(): void {
  const agents = useKookrStore((s) => s.agents);

  useEffect(() => {
    const shouldChime = evaluateChime(agents, chimedState, Date.now());
    if (shouldChime && isSoundEnabled() && !isDndEnabled()) {
      playChime();
    }
  }, [agents]);
}
