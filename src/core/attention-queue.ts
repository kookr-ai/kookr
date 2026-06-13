import type { Anomaly, AnomalySeverity } from './types.js';
import { anomalyFingerprint } from './anomaly-fingerprint.js';
import { SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS } from '../shared/contracts/messages.js';

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

interface QueueEntry {
  agentId: string;
  anomaly: Anomaly;
  skipped: boolean;
}

export type SnoozeKind = 'finding' | 'task';

export interface SnoozeEntry {
  /** Original agent/session ID passed at snooze time. Reported by getSnoozed. */
  agentId: string;
  /**
   * The map key under which this entry is stored. Either the resolved taskId
   * (snooze followed a real task) or `agentId` (orphan / no-resolver test).
   * Cached so cancelSnooze and purgeTask don't have to re-resolve through
   * a TaskStore that may have moved on.
   */
  key: string;
  kind: SnoozeKind;
  anomaly?: Anomaly;
  expiresAt: number;
  createdAt: number;
  expiredPendingRestore?: boolean;
  reason?: string;
  wakeOnChange?: boolean;
}

export interface AttentionQueueOpts {
  /**
   * Resolves a session/agent ID to its owning task ID. When provided, snoozes
   * are keyed internally by taskId so they survive session rotation (Ralph
   * iterations, crash-recovery launches, redeploys mid-gap between iterations).
   * When omitted, snoozes are keyed by the agentId — fine for tests that
   * exercise the queue without a TaskStore.
   */
  taskIdFor?: (agentId: string) => string | null;
}

export interface AttentionQueueAdmission {
  agentId: string;
  anomaly: Anomaly;
  fingerprint: string;
}

export interface AttentionQueueResolution {
  agentId: string;
  anomaly: Anomaly;
  fingerprint: string;
}

export interface AttentionQueueSuppression {
  agentId: string;
  anomaly: Anomaly;
  fingerprint: string;
  reason: 'queue_dedupe' | 'queue_snoozed';
}

export interface AttentionQueueObserver {
  admitted?(event: AttentionQueueAdmission): void;
  resolved?(event: AttentionQueueResolution): void;
  suppressed?(event: AttentionQueueSuppression): void;
}

export class AttentionQueue {
  private entries = new Map<string, QueueEntry>();
  /**
   * Snoozed map. Key is the taskId when a `taskIdFor` resolver is configured
   * AND the agent has an owning task; otherwise the agentId. Keying by taskId
   * lets a single snooze cover every session of the task (Ralph iterations,
   * crash-relaunched sessions, etc.).
   */
  private snoozed = new Map<string, SnoozeEntry>();
  /** Anomaly preserved from the last remove() call — fallback for snooze race. */
  private lastRemoved = new Map<string, Anomaly>();
  private taskIdFor: (agentId: string) => string | null;
  private observers = new Set<AttentionQueueObserver>();

  constructor(opts: AttentionQueueOpts = {}) {
    this.taskIdFor = opts.taskIdFor ?? (() => null);
  }

  addObserver(observer: AttentionQueueObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  /** Resolve the snooze map key for a given agent: taskId if available, else the agentId. */
  private snoozeKey(agentId: string): string {
    return this.taskIdFor(agentId) ?? agentId;
  }

  enqueue(agentId: string, anomaly: Anomaly): void {
    this.lastRemoved.delete(agentId); // New anomaly supersedes any stale removed one

    const key = this.snoozeKey(agentId);
    this.dropExpiredForKey(key);

    // If snoozed (by task or agent), update the snoozed entry but don't add to active queue.
    // Expired entries are dropped when a fresh anomaly arrives; the fresh
    // signal is a better source of truth than a stale hidden anomaly waiting
    // for the server expiry timer.
    const snoozed = this.snoozed.get(key);
    if (snoozed && Date.now() < snoozed.expiresAt) {
      if (this.shouldWakeSnooze(snoozed, anomaly)) {
        this.snoozed.delete(key);
        this.entries.set(agentId, { agentId, anomaly, skipped: false });
        this.notifyAdmitted(agentId, anomaly);
        return;
      }
      // Preserve original detectedAt only while the same finding remains hidden.
      if (hasSameFingerprint(snoozed.anomaly, anomaly)) {
        anomaly = { ...anomaly, detectedAt: snoozed.anomaly.detectedAt };
      }
      snoozed.anomaly = anomaly;
      this.notifySuppressed(agentId, anomaly, 'queue_snoozed');
      return;
    }

    // Preserve original detectedAt when re-enqueuing the same finding.
    const existing = this.entries.get(agentId);
    if (existing && anomalyFingerprint(existing.anomaly) === anomalyFingerprint(anomaly)) {
      existing.anomaly = { ...anomaly, detectedAt: existing.anomaly.detectedAt };
      this.notifySuppressed(agentId, existing.anomaly, 'queue_dedupe');
      return;
    }

    this.entries.set(agentId, { agentId, anomaly, skipped: false });
    this.notifyAdmitted(agentId, anomaly);
  }

  next(): { agentId: string; anomaly: Anomaly } | null {
    this.restoreExpiredSnoozes();
    const sorted = this.getSorted();
    if (sorted.length === 0) return null;
    return { agentId: sorted[0].agentId, anomaly: sorted[0].anomaly };
  }

  skip(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      entry.skipped = true;
    }
  }

  snooze(agentId: string, durationMs: number, reason?: string, fallbackAnomaly?: Anomaly): SnoozeEntry | null {
    const entry = this.entries.get(agentId);
    const anomaly = entry?.anomaly ?? fallbackAnomaly;
    const key = this.snoozeKey(agentId);
    const isTaskKeyed = key !== agentId;
    if (!anomaly && !isTaskKeyed) return null; // No anomaly and no durable task identity — nothing to snooze

    const now = Date.now();
    const snooze: SnoozeEntry = {
      agentId,
      key,
      kind: anomaly ? 'finding' : 'task',
      expiresAt: now + durationMs,
      createdAt: now,
      reason,
      wakeOnChange: durationMs >= SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS,
    };
    if (anomaly) {
      snooze.anomaly = anomaly;
    }
    this.snoozed.set(key, snooze);
    this.entries.delete(agentId); // No-op if entry was already absent
    this.lastRemoved.delete(agentId); // Consumed — no longer needed
    return snooze;
  }

  /** Cancel snooze — move agent from snoozed map back to active entries. Returns true if the agent was snoozed. */
  cancelSnooze(agentId: string, restoreAgentId = agentId): boolean {
    const key = this.snoozeKey(agentId);
    const snoozed = this.snoozed.get(key);
    if (!snoozed) return false;

    if (snoozed.anomaly) {
      this.entries.set(restoreAgentId, {
        agentId: restoreAgentId,
        anomaly: { ...snoozed.anomaly, agentId: restoreAgentId },
        skipped: false,
      });
    }
    this.snoozed.delete(snoozed.key);
    return true;
  }

  /** Remove from active entries only — preserves snooze state. Use for anomaly resolution. */
  remove(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      this.lastRemoved.set(agentId, entry.anomaly);
      this.notifyResolved(agentId, entry.anomaly);
    }
    this.entries.delete(agentId);
  }

  /**
   * Drop this agent's active entry and lastRemoved fallback. Use for session
   * cleanup. Snooze state is intentionally preserved — a snooze must survive
   * session rotation (Ralph iterations, crash-recovery relaunches). Use
   * `purgeTask(taskId)` when the entire task is going away.
   */
  purge(agentId: string): void {
    this.entries.delete(agentId);
    this.lastRemoved.delete(agentId);
  }

  /** Clear the snooze for a task (or, for tests/orphans, an agentId acting as the snooze key). */
  purgeTask(taskIdOrKey: string): void {
    this.snoozed.delete(taskIdOrKey);
  }

  /**
   * Returns all snoozed entries (for persistence).
   *
   * Each entry's `key` is the snooze map key — taskId in production, agentId
   * in resolver-less tests. Persistence layers should use that key directly
   * rather than re-deriving it from agentId, so a stored snooze always
   * round-trips back to the same map slot.
   */
  getSnoozed(): SnoozeEntry[] {
    const result: SnoozeEntry[] = [];
    for (const entry of this.snoozed.values()) {
      result.push({ ...entry });
    }
    return result;
  }

  /**
   * Import snoozed entries from persistence. Each entry carries an explicit
   * `key` (taskId in production, agentId for orphans) so the import never has
   * to re-derive the map slot through the resolver — that protects the fix's
   * correctness from future TaskStore changes (e.g. session pruning).
   */
  importSnoozed(
    entries: Array<{
      agentId: string;
      key: string;
      kind?: SnoozeKind;
      anomaly?: Anomaly;
      expiresAt: number;
      createdAt?: number;
      expiredPendingRestore?: boolean;
      reason?: string;
      wakeOnChange?: boolean;
    }>,
  ): void {
    for (const entry of entries) {
      const createdAt = entry.createdAt ?? Date.now();
      this.snoozed.set(entry.key, {
        agentId: entry.agentId,
        key: entry.key,
        kind: entry.kind ?? (entry.anomaly ? 'finding' : 'task'),
        anomaly: entry.anomaly,
        expiresAt: entry.expiresAt,
        createdAt,
        expiredPendingRestore: entry.expiredPendingRestore,
        reason: entry.reason,
        wakeOnChange: entry.wakeOnChange ?? entry.expiresAt - createdAt >= SNOOZE_UNTIL_NEXT_CHANGE_DURATION_MS,
      });
      // Remove from active entries to avoid duplicates (race: events arrived before import)
      this.entries.delete(entry.agentId);
    }
  }

  /** Returns the snooze expiration timestamp (ms since epoch) if the agent is actively snoozed, null otherwise. */
  getSnoozedUntil(agentId: string): number | null {
    const entry = this.snoozed.get(this.snoozeKey(agentId));
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) return null; // expired
    return entry.expiresAt;
  }

  /** Get the stored anomaly for an agent (with persisted detectedAt), or null. */
  getAnomaly(agentId: string): Anomaly | null {
    const snoozed = this.snoozed.get(this.snoozeKey(agentId));
    return this.entries.get(agentId)?.anomaly
      ?? (snoozed && Date.now() < snoozed.expiresAt ? snoozed.anomaly : undefined)
      ?? this.lastRemoved.get(agentId)
      ?? null;
  }

  /** Get the active or snoozed anomaly only; excludes lastRemoved fallback. */
  peek(agentId: string): Anomaly | null {
    const snoozed = this.snoozed.get(this.snoozeKey(agentId));
    return this.entries.get(agentId)?.anomaly
      ?? (snoozed && Date.now() < snoozed.expiresAt ? snoozed.anomaly : undefined)
      ?? null;
  }

  /**
   * Get the currently-*active* (non-snoozed, non-removed) anomaly for this
   * agent, or null. Used by the achievement watcher's recordResolution helper
   * to identify which anomaly the user is intervening on.
   *
   * Calls restoreExpiredSnoozes() so that an anomaly whose snooze just expired
   * is correctly observable as active. Mirrors the side-effect of next() /
   * getAll() / isAllClear().
   */
  getActiveAnomaly(agentId: string): Anomaly | null {
    this.restoreExpiredSnoozes();
    return this.entries.get(agentId)?.anomaly ?? null;
  }

  /** Backdate an anomaly's detectedAt (for testing). */
  backdateAnomaly(agentId: string, detectedAt: Date): boolean {
    const entry = this.entries.get(agentId);
    if (entry) {
      entry.anomaly = { ...entry.anomaly, detectedAt };
      return true;
    }
    return false;
  }

  respondAndAdvance(agentId: string): { agentId: string; anomaly: Anomaly } | null {
    const entry = this.entries.get(agentId);
    if (entry) {
      this.notifyResolved(agentId, entry.anomaly);
    }
    this.entries.delete(agentId);
    return this.next();
  }

  getAll(): Array<{ agentId: string; anomaly: Anomaly }> {
    this.restoreExpiredSnoozes();
    return this.getSorted().map((e) => ({
      agentId: e.agentId,
      anomaly: e.anomaly,
    }));
  }

  /** Read active queue entries without restoring expired snoozes or changing ordering state. */
  inspectActive(): Array<{ agentId: string; anomaly: Anomaly }> {
    return this.getSorted().map((e) => ({
      agentId: e.agentId,
      anomaly: e.anomaly,
    }));
  }

  /** Remove all entries, snoozed, and lastRemoved state. Used by test reset. */
  clear(): void {
    this.entries.clear();
    this.snoozed.clear();
    this.lastRemoved.clear();
  }

  isAllClear(): boolean {
    this.restoreExpiredSnoozes();
    return this.entries.size === 0;
  }

  expireDue(now = Date.now()): SnoozeEntry[] {
    const expired: SnoozeEntry[] = [];
    for (const [key, snooze] of this.snoozed) {
      if (now < snooze.expiresAt) continue;
      this.snoozed.delete(key);
      expired.push({ ...snooze });
    }
    return expired;
  }

  private dropExpiredForKey(key: string): void {
    const snooze = this.snoozed.get(key);
    if (!snooze || Date.now() < snooze.expiresAt) return;
    this.snoozed.delete(key);
  }

  private restoreExpiredSnoozes(): void {
    const now = Date.now();
    for (const [key, snooze] of this.snoozed) {
      if (now < snooze.expiresAt) continue;
      if (!snooze.anomaly) {
        this.snoozed.delete(key);
        continue;
      }

      // When the snooze is keyed by agentId (no resolver / orphan), restore
      // the anomaly under that same agentId — preserves the legacy "snooze
      // expires, finding pops back" UX that callers and tests rely on.
      //
      // When the snooze is keyed by taskId, the recorded agentId may now be
      // a long-dead session. The server expiry path owns live-session
      // restoration, so the queue leaves task-keyed hidden anomalies pending.
      const isAgentKeyed = snooze.key === snooze.agentId;
      if (isAgentKeyed) {
        this.entries.set(snooze.agentId, {
          agentId: snooze.agentId,
          anomaly: snooze.anomaly,
          skipped: false,
        });
        this.snoozed.delete(key);
      }
    }
  }

  private shouldWakeSnooze(snoozed: SnoozeEntry, anomaly: Anomaly): boolean {
    if (!snoozed.anomaly) return snoozed.wakeOnChange === true;

    const sameFingerprint = hasSameFingerprint(snoozed.anomaly, anomaly);
    const severityEscalated = SEVERITY_ORDER[anomaly.severity] < SEVERITY_ORDER[snoozed.anomaly.severity];

    if (snoozed.wakeOnChange) {
      return !sameFingerprint || severityEscalated;
    }

    return severityEscalated || (anomaly.severity === 'critical' && !sameFingerprint);
  }

  private getSorted(): QueueEntry[] {
    const all = Array.from(this.entries.values());
    return all.sort((a, b) => {
      // Non-skipped first
      if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
      // Then by severity
      return SEVERITY_ORDER[a.anomaly.severity] - SEVERITY_ORDER[b.anomaly.severity];
    });
  }

  private notifyAdmitted(agentId: string, anomaly: Anomaly): void {
    if (this.observers.size === 0) return;
    const event = { agentId, anomaly, fingerprint: anomalyFingerprint(anomaly) };
    for (const observer of this.observers) {
      observer.admitted?.(event);
    }
  }

  private notifyResolved(agentId: string, anomaly: Anomaly): void {
    if (this.observers.size === 0) return;
    const event = { agentId, anomaly, fingerprint: anomalyFingerprint(anomaly) };
    for (const observer of this.observers) {
      observer.resolved?.(event);
    }
  }

  private notifySuppressed(agentId: string, anomaly: Anomaly, reason: AttentionQueueSuppression['reason']): void {
    if (this.observers.size === 0) return;
    const event = { agentId, anomaly, fingerprint: anomalyFingerprint(anomaly), reason };
    for (const observer of this.observers) {
      observer.suppressed?.(event);
    }
  }
}

function hasSameFingerprint(previous: Anomaly | undefined, next: Anomaly): previous is Anomaly {
  return previous !== undefined && anomalyFingerprint(previous) === anomalyFingerprint(next);
}
