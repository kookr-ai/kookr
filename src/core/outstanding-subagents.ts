import type { AgentEvent, Anomaly } from './types.js';

/**
 * Time after which an outstanding subagent entry is considered stale and dropped.
 * Caps the duration of needs_input / stale_agent / hook_disconnected suppression
 * when a SubagentStop event is lost (process SIGKILL, watcher drop, etc).
 * 30 minutes is ~3× the longest legitimate background subagent observed in
 * production hook logs at design time.
 */
export const SUBAGENT_TTL_MS = 30 * 60 * 1000;

/**
 * Anomaly types suppressed while background subagents are still outstanding.
 *
 * - `needs_input`: parent Stop fires whenever its turn ends, including while
 *   waiting on a `run_in_background` subagent (rfc-subagent-aware-needs-input).
 * - `stale_agent` / `hook_disconnected`: parent emits no hooks while a subagent
 *   works; the watchdog would otherwise mint false positives
 *   (rfc-supervisor-stale-agent-false-positives).
 *
 * `permission_blocked` is deliberately excluded — a parent blocked on
 * permission is genuinely blocked regardless of subagent state.
 */
export const SUBAGENT_SUPPRESSIBLE_TYPES: ReadonlySet<Anomaly['type']> = new Set([
  'needs_input',
  'stale_agent',
  'hook_disconnected',
]);

export interface EvictStaleResult {
  /** Surviving outstanding subagent count after eviction. */
  remaining: number;
  /** How many entries were dropped by the TTL. */
  evicted: number;
}

export interface SuppressIfRunningResult {
  /** Anomaly after suppression, or null when swallowed. */
  anomaly: Anomaly | null;
  remaining: number;
  evicted: number;
}

/**
 * Tracks outstanding background subagents per parent agent and applies the
 * pure subagent-running suppression policy.
 *
 * Owns only the outstanding-subagent map and TTL eviction. Callers record
 * telemetry ({@link recordSubagentOrphans}, {@link recordSubagentTtlEviction})
 * and own snapshot/turn-state projection side effects.
 */
export class OutstandingSubagentTracker {
  /**
   * Outer key: parent agentId (tmux session name).
   * Inner key: subagentId from the hook; value: Date.now() at SubagentStart.
   */
  private outstanding = new Map<string, Map<string, number>>();

  /**
   * Update outstanding-subagent tracking for one event.
   * SubagentStart adds the subagentId with `now`; SubagentStop removes it;
   * session_end is handled by the caller via {@link flush}; a Stop hook with
   * explicit zero active background tasks/crons is authoritative provider
   * evidence that no subordinate work remains, so it clears stale entries
   * without counting them as orphans.
   */
  updateFromEvent(agentId: string, event: AgentEvent, now: number = Date.now()): void {
    if (event.type === 'subagent_start' && event.agentId) {
      let map = this.outstanding.get(agentId);
      if (!map) {
        map = new Map();
        this.outstanding.set(agentId, map);
      }
      map.set(event.agentId, now);
    } else if (event.type === 'subagent_stop' && event.agentId) {
      this.outstanding.get(agentId)?.delete(event.agentId);
    } else if (
      event.type === 'stop'
      && event.activeBackgroundTaskCount === 0
      && event.activeSessionCronCount === 0
    ) {
      this.outstanding.delete(agentId);
    }
  }

  /**
   * Drop the outstanding-subagent map for an agent. Returns the orphan count
   * (entries whose SubagentStop never arrived). Caller records telemetry.
   * Idempotent: a second flush returns 0.
   */
  flush(agentId: string): number {
    const map = this.outstanding.get(agentId);
    const orphanCount = map?.size ?? 0;
    this.outstanding.delete(agentId);
    return orphanCount;
  }

  /** Current outstanding count without TTL eviction. */
  size(agentId: string): number {
    return this.outstanding.get(agentId)?.size ?? 0;
  }

  /** Distinct parents with a non-empty outstanding map (pre-TTL). */
  parentCount(): number {
    return this.outstanding.size;
  }

  /** Sum of outstanding subagent entries across all parents (pre-TTL). */
  totalOutstanding(): number {
    let total = 0;
    for (const map of this.outstanding.values()) total += map.size;
    return total;
  }

  /**
   * Drop subagent entries older than {@link SUBAGENT_TTL_MS}. Caps suppression
   * duration when SubagentStop is lost. Eviction is lazy — only runs when
   * called (typically from suppress / snapshot paths).
   */
  evictStale(agentId: string, now: number = Date.now()): EvictStaleResult {
    const map = this.outstanding.get(agentId);
    if (!map) return { remaining: 0, evicted: 0 };
    let evicted = 0;
    for (const [subagentId, startedAt] of map) {
      if (now - startedAt > SUBAGENT_TTL_MS) {
        map.delete(subagentId);
        evicted++;
      }
    }
    return { remaining: map.size, evicted };
  }

  /**
   * Suppress eligible anomaly types when one or more background subagents are
   * still running after TTL eviction. Other anomaly types pass through.
   *
   * Side-effect free w.r.t. detection-stats so it can be called from both write
   * (processEvents, applyWatchdogVerdict) and read (getEventAnomaly) paths.
   * Write paths increment the suppression counter after observing a null result.
   */
  suppressIfRunning(
    anomaly: Anomaly | null,
    agentId: string,
    now: number = Date.now(),
  ): SuppressIfRunningResult {
    if (!anomaly || !SUBAGENT_SUPPRESSIBLE_TYPES.has(anomaly.type)) {
      return { anomaly, remaining: this.size(agentId), evicted: 0 };
    }
    const { remaining, evicted } = this.evictStale(agentId, now);
    return {
      anomaly: remaining > 0 ? null : anomaly,
      remaining,
      evicted,
    };
  }
}
