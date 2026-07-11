import type { Anomaly, AnomalyType } from './types.js';
import { stableAnomalyExplanation } from './anomaly-fingerprint.js';
import {
  findingFingerprint,
  findingLineageKey,
  normalizeFindingContext,
  type FindingFingerprintInput,
} from './finding-fingerprint.js';

/** Anomaly types that are suppressible (liveness category). */
const LIVENESS_ANOMALY_TYPES: ReadonlySet<AnomalyType> = new Set([
  'stale_agent',
  'hook_disconnected',
]);

/** Number of consecutive liveness snoozes before auto-suppression kicks in. */
export const SUPPRESSION_THRESHOLD = 3;

/** Per-agent suppression state. */
export interface SuppressionState {
  /** Number of consecutive liveness-category snoozes. */
  consecutiveCount: number;
  /** Whether monitoring is currently suppressed. */
  suppressed: boolean;
  /** The anomaly type that triggered suppression (for logging). */
  lastAnomalyType: AnomalyType;
}

/** Serialized suppression state for persistence in tasks.json. */
export interface PersistedSuppressionEntry {
  agentId: string;
  consecutiveCount: number;
  suppressed: boolean;
  lastAnomalyType: AnomalyType;
}

/**
 * Tracks consecutive liveness-category snoozes per agent and auto-suppresses
 * monitoring when the threshold is reached. This prevents "snooze storms"
 * where the same liveness finding keeps resurfacing after the user snoozes it.
 */
export class SnoozeSuppressionTracker {
  private state = new Map<string, SuppressionState>();

  /**
   * Record a snooze for the given agent and anomaly type.
   * Returns true if the threshold was just crossed (newly suppressed).
   * Non-liveness anomaly types are ignored (returns false, no state change).
   */
  recordSnooze(agentId: string, anomalyType: AnomalyType): boolean {
    if (!LIVENESS_ANOMALY_TYPES.has(anomalyType)) return false;

    const existing = this.state.get(agentId);
    const count = (existing?.consecutiveCount ?? 0) + 1;
    const wasSuppressed = existing?.suppressed ?? false;
    const nowSuppressed = count >= SUPPRESSION_THRESHOLD;

    this.state.set(agentId, {
      consecutiveCount: count,
      suppressed: nowSuppressed,
      lastAnomalyType: anomalyType,
    });

    // Return true only on the transition from not-suppressed to suppressed
    return nowSuppressed && !wasSuppressed;
  }

  /**
   * Record a user-reported false positive for a liveness finding.
   *
   * Unlike a snooze — a soft "not now" that only suppresses after
   * {@link SUPPRESSION_THRESHOLD} consecutive repeats — an explicit
   * false-positive flag is a decisive "this detector is wrong for this agent"
   * signal, so it suppresses the type immediately. This stops the re-flag storm
   * where a long-running background tool keeps re-crossing the stale threshold
   * and resurfacing the same finding after each dismissal (the user otherwise
   * has to flag it again every watchdog tick).
   *
   * Suppression is cleared by {@link reset} on respond / resumeMonitoring /
   * agent cleanup, so a genuine later hang still surfaces once the agent has
   * demonstrably done something.
   *
   * Returns true only on the transition into suppression. Non-liveness types
   * are ignored (returns false, no state change).
   */
  recordFalsePositive(agentId: string, anomalyType: AnomalyType): boolean {
    if (!LIVENESS_ANOMALY_TYPES.has(anomalyType)) return false;
    const wasSuppressed = this.state.get(agentId)?.suppressed ?? false;
    this.state.set(agentId, {
      consecutiveCount: SUPPRESSION_THRESHOLD,
      suppressed: true,
      lastAnomalyType: anomalyType,
    });
    return !wasSuppressed;
  }

  /**
   * Check whether a liveness anomaly should be suppressed (not enqueued).
   * Non-liveness anomaly types always return false (never suppressed).
   */
  shouldSuppress(agentId: string, anomalyType: AnomalyType): boolean {
    if (!LIVENESS_ANOMALY_TYPES.has(anomalyType)) return false;
    return this.state.get(agentId)?.suppressed ?? false;
  }

  /** Check whether an agent is currently suppressed (for UI visibility). */
  isSuppressed(agentId: string): boolean {
    return this.state.get(agentId)?.suppressed ?? false;
  }

  /** Reset suppression state for an agent (on respond or agent cleanup). */
  reset(agentId: string): void {
    this.state.delete(agentId);
  }

  /** Get all suppressed agent IDs. */
  getSuppressedAgents(): string[] {
    const result: string[] = [];
    for (const [agentId, s] of this.state) {
      if (s.suppressed) result.push(agentId);
    }
    return result;
  }

  /** Export state for persistence. */
  export(): PersistedSuppressionEntry[] {
    const result: PersistedSuppressionEntry[] = [];
    for (const [agentId, s] of this.state) {
      result.push({
        agentId,
        consecutiveCount: s.consecutiveCount,
        suppressed: s.suppressed,
        lastAnomalyType: s.lastAnomalyType,
      });
    }
    return result;
  }

  /** Import state from persistence. */
  import(entries: PersistedSuppressionEntry[]): void {
    for (const entry of entries) {
      this.state.set(entry.agentId, {
        consecutiveCount: entry.consecutiveCount,
        suppressed: entry.suppressed,
        lastAnomalyType: entry.lastAnomalyType,
      });
    }
  }
}

/** Check whether an anomaly type is in the liveness category (suppressible). */
export function isLivenessAnomaly(type: AnomalyType): boolean {
  return LIVENESS_ANOMALY_TYPES.has(type);
}

// ---------------------------------------------------------------------------
// Finding deduplication + supersession (#1326)
// ---------------------------------------------------------------------------

/** Why a prior fingerprint left the active slot of its lineage. */
export type FindingHistoryReason = 'superseded' | 'resolved';

/** An earlier state of a finding, preserved as an audit trail. */
export interface FindingHistoryEntry {
  fingerprint: string;
  /** Normalized question/context that was active for this fingerprint. */
  context: string;
  /** Equivalent detections that had folded into this fingerprint. */
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Snooze-until in force when this state ended, preserved for the audit trail. */
  snoozeUntil: number | null;
  reason: FindingHistoryReason;
  endedAt: number;
}

/** The single live finding for a lineage (task + anomaly type). */
export interface FindingRecord {
  /**
   * Stable id for the logical finding across BOTH dedupe and supersede — equal to
   * the lineage key, so lineage survives a changed question.
   */
  findingId: string;
  taskId: string;
  type: AnomalyType;
  subType?: string;
  /** Current fingerprint. */
  fingerprint: string;
  /** Current normalized question/context. */
  context: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Count of equivalent detections folded into the current fingerprint. */
  occurrences: number;
  /** Active snooze-until (ms epoch), or null when not snoozed. */
  snoozeUntil: number | null;
  /** Superseded / resolved predecessors, oldest first. */
  history: FindingHistoryEntry[];
}

/** Outcome of {@link FindingDeduplicator.record}. */
export type FindingDisposition = 'created' | 'deduplicated' | 'superseded';

export interface RecordFindingResult {
  disposition: FindingDisposition;
  /** Snapshot of the finding after recording (safe to retain — not shared state). */
  record: FindingRecord;
}

function cloneRecord(record: FindingRecord): FindingRecord {
  return { ...record, history: record.history.map((entry) => ({ ...entry })) };
}

/**
 * Deduplicates and supersedes repeated findings so snoozing the same unresolved
 * question does not regenerate equivalent alerts across supervision sweeps
 * (#1326).
 *
 * One {@link FindingRecord} is kept per lineage (task + anomaly type):
 * - Equivalent detections (matching {@link findingFingerprint}) fold into the
 *   existing record — one logical finding, snooze-until preserved.
 * - A materially-changed question (same lineage, new fingerprint) *supersedes*
 *   the record: the prior state is pushed to `history` and the finding resurfaces
 *   (snooze cleared) rather than being hidden behind a stale snooze.
 *
 * This is separate from #1291 (worktree-sweep dispositions); it concerns
 * supervisor findings attached to an agent/task question.
 */
export class FindingDeduplicator {
  private byLineage = new Map<string, FindingRecord>();

  /**
   * Record a detection. Returns the disposition (`created` / `deduplicated` /
   * `superseded`) and a snapshot of the resulting finding.
   */
  record(anomaly: Anomaly, input: FindingFingerprintInput = {}, now = Date.now()): RecordFindingResult {
    const findingId = findingLineageKey(anomaly, input);
    const fingerprint = findingFingerprint(anomaly, input);
    const context = normalizeFindingContext(stableAnomalyExplanation(anomaly));
    const existing = this.byLineage.get(findingId);

    if (!existing) {
      const created: FindingRecord = {
        findingId,
        taskId: input.taskId ?? anomaly.agentId,
        type: anomaly.type,
        subType: anomaly.subType,
        fingerprint,
        context,
        firstSeenAt: now,
        lastSeenAt: now,
        occurrences: 1,
        snoozeUntil: null,
        history: [],
      };
      this.byLineage.set(findingId, created);
      return { disposition: 'created', record: cloneRecord(created) };
    }

    if (existing.fingerprint === fingerprint) {
      existing.occurrences += 1;
      existing.lastSeenAt = now;
      return { disposition: 'deduplicated', record: cloneRecord(existing) };
    }

    // Material change: retire the prior fingerprint to the audit trail and let
    // the finding resurface. A changed question must not stay hidden behind a
    // snooze that was for the old question.
    existing.history.push({
      fingerprint: existing.fingerprint,
      context: existing.context,
      occurrences: existing.occurrences,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: existing.lastSeenAt,
      snoozeUntil: existing.snoozeUntil,
      reason: 'superseded',
      endedAt: now,
    });
    existing.fingerprint = fingerprint;
    existing.context = context;
    existing.subType = anomaly.subType;
    existing.lastSeenAt = now;
    existing.occurrences = 1;
    existing.snoozeUntil = null;
    return { disposition: 'superseded', record: cloneRecord(existing) };
  }

  /**
   * Snooze the current finding of a lineage until `until` (ms epoch). The
   * snooze-until is preserved across later equivalent detections, so a sweep
   * re-detecting the same question keeps it hidden until expiry or a material
   * change. Returns the updated snapshot, or null if no such finding exists.
   */
  snooze(anomaly: Anomaly, input: FindingFingerprintInput = {}, until: number, now = Date.now()): FindingRecord | null {
    const existing = this.byLineage.get(findingLineageKey(anomaly, input));
    if (!existing) return null;
    existing.snoozeUntil = until;
    existing.lastSeenAt = now;
    return cloneRecord(existing);
  }

  /** Whether the current finding for this anomaly is actively snoozed at `now`. */
  isSnoozed(anomaly: Anomaly, input: FindingFingerprintInput = {}, now = Date.now()): boolean {
    const record = this.byLineage.get(findingLineageKey(anomaly, input));
    return record?.snoozeUntil != null && now < record.snoozeUntil;
  }

  /**
   * Mark the current finding resolved: append the resolved state to the audit
   * trail and drop the live slot, so a later equivalent detection opens a fresh
   * finding. Returns the final snapshot (including the appended `resolved`
   * history entry, so callers can persist the audit trail), or null if there was
   * no live finding.
   */
  resolve(anomaly: Anomaly, input: FindingFingerprintInput = {}, now = Date.now()): FindingRecord | null {
    const findingId = findingLineageKey(anomaly, input);
    const existing = this.byLineage.get(findingId);
    if (!existing) return null;
    existing.history.push({
      fingerprint: existing.fingerprint,
      context: existing.context,
      occurrences: existing.occurrences,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: existing.lastSeenAt,
      snoozeUntil: existing.snoozeUntil,
      reason: 'resolved',
      endedAt: now,
    });
    const resolved = cloneRecord(existing);
    this.byLineage.delete(findingId);
    return resolved;
  }

  /** Get a snapshot of the current finding for this anomaly, or null. */
  get(anomaly: Anomaly, input: FindingFingerprintInput = {}): FindingRecord | null {
    const record = this.byLineage.get(findingLineageKey(anomaly, input));
    return record ? cloneRecord(record) : null;
  }

  /** Get a snapshot of a finding by its stable id, or null. */
  getByFindingId(findingId: string): FindingRecord | null {
    const record = this.byLineage.get(findingId);
    return record ? cloneRecord(record) : null;
  }

  /** All live findings (snapshots) — for UI/API exposure of lineage + snooze state. */
  snapshot(): FindingRecord[] {
    return Array.from(this.byLineage.values(), cloneRecord);
  }

  /** Drop the live finding for a lineage without recording resolution. */
  forget(findingId: string): void {
    this.byLineage.delete(findingId);
  }

  /** Remove all findings. */
  clear(): void {
    this.byLineage.clear();
  }
}
