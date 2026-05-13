import { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import { maybePlayChime } from '../audio/sound.js';
import { isActiveFinding } from '../store/finding-helpers.js';
import type { AgentState } from '../../shared/protocol.js';
import type { AudioAlertContext } from '../audio/audio-alert-log.js';

// After an agent leaves the findings list, suppress re-chimes for this long.
// Guards against transient anomaly flicker (subagent boundaries, watchdog
// re-evaluation, brief stale_agent oscillation) where the same logical issue
// rapidly cycles in and out of finding state with a fresh detectedAt each time.
export const RECHIME_COOLDOWN_MS = 30_000;

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
function detectedAtString(agent: AgentState): string | null {
  if (!agent.anomaly?.detectedAt) return null;
  return agent.anomaly.detectedAt instanceof Date
    ? agent.anomaly.detectedAt.toISOString()
    : String(agent.anomaly.detectedAt);
}

function findingKey(agent: AgentState): string | null {
  const detectedAt = detectedAtString(agent);
  if (!agent.anomaly || !detectedAt) return null;
  return `${agent.anomaly.type}:${detectedAt}`;
}

export interface ChimeRecord {
  /** Key of the finding most recently associated with this agent. */
  key: string;
  /** null = agent currently in findings; non-null = post-clear cooldown deadline. */
  cooldownUntil: number | null;
}

export interface FindingChimeEvaluation {
  shouldChime: boolean;
  evaluationId: string;
  candidateCount: number;
  primaryCandidate?: AgentState;
  context?: AudioAlertContext;
}

interface FindingCandidate {
  agent: AgentState;
  dedupeKey: string;
  detectedAt: string;
}

function severityRank(severity: string | undefined): number {
  if (severity === 'critical') return 2;
  if (severity === 'warning') return 1;
  return 0;
}

function sortFindingCandidates(a: FindingCandidate, b: FindingCandidate): number {
  const severityDelta = severityRank(b.agent.anomaly?.severity) - severityRank(a.agent.anomaly?.severity);
  if (severityDelta !== 0) return severityDelta;
  const detectedDelta = new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime();
  if (detectedDelta !== 0) return detectedDelta;
  return a.agent.agentId.localeCompare(b.agent.agentId);
}

function buildFindingReason(primary: AgentState, candidateCount: number): string {
  const anomaly = primary.anomaly;
  const suffix = candidateCount > 1 ? ` (+${candidateCount - 1} more)` : '';
  if (!anomaly) return `finding on ${primary.agentId}${suffix}`;
  return `${anomaly.type} ${anomaly.severity} on ${primary.taskName ?? primary.agentId}${suffix}`;
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
  return evaluateFindingChime(agents, state, now).shouldChime;
}

export function evaluateFindingChime(
  agents: AgentState[],
  state: Map<string, ChimeRecord>,
  now: number,
): FindingChimeEvaluation {
  const activeAgentIds = new Set<string>();
  const candidates: FindingCandidate[] = [];

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

    candidates.push({
      agent,
      dedupeKey: `${agent.agentId}:${key}`,
      detectedAt: detectedAtString(agent) ?? '',
    });
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

  const sortedCandidates = [...candidates].sort(sortFindingCandidates);
  const primary = sortedCandidates[0]?.agent;
  const primaryDetectedAt = primary ? detectedAtString(primary) : null;
  const primaryKey = primary ? findingKey(primary) : null;
  const candidateCount = candidates.length;
  return {
    shouldChime: candidateCount > 0,
    evaluationId: `finding-${now}-${candidates.map((candidate) => candidate.dedupeKey).sort().join('|')}`,
    candidateCount,
    primaryCandidate: primary,
    context: primary && primary.anomaly && primaryDetectedAt && primaryKey
      ? {
          source: 'finding',
          reason: buildFindingReason(primary, candidateCount),
          agentId: primary.agentId,
          taskId: primary.taskId,
          taskName: primary.taskName,
          anomalyType: primary.anomaly.type,
          severity: primary.anomaly.severity,
          detectedAt: primaryDetectedAt,
          dedupeKey: `${primary.agentId}:${primaryKey}`,
          evaluationId: `finding-${now}-${candidates.map((candidate) => candidate.dedupeKey).sort().join('|')}`,
          candidateCount,
          primaryCause: 'highest_severity',
          activeFindingsCount: agents.filter(isActiveFinding).length,
        }
      : undefined,
  };
}

/**
 * Per-tab dedup state for the chime. Module-scoped on purpose: useRef would
 * be reset by React StrictMode's mount→unmount→mount cycle in development,
 * causing every active finding to re-chime on second mount. The hook is a
 * singleton inside <App />, so module scope and a hook-private Map are
 * functionally identical for production but stable across StrictMode mounts.
 */
const chimedState = new Map<string, ChimeRecord>();

export function __resetAudibleAlertForTests(): void {
  chimedState.clear();
}

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
    const evaluation = evaluateFindingChime(agents, chimedState, Date.now());
    if (evaluation.shouldChime && evaluation.context) {
      maybePlayChime(evaluation.context);
    }
  }, [agents]);
}
