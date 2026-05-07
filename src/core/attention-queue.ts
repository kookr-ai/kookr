import type { Anomaly, AnomalySeverity } from './types.js';

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

interface SnoozeEntry {
  /** Original agent/session ID passed at snooze time. Reported by getSnoozed. */
  agentId: string;
  /**
   * The map key under which this entry is stored. Either the resolved taskId
   * (snooze followed a real task) or `agentId` (orphan / no-resolver test).
   * Cached so cancelSnooze and purgeTask don't have to re-resolve through
   * a TaskStore that may have moved on.
   */
  key: string;
  anomaly: Anomaly;
  expiresAt: number;
  reason?: string;
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

  constructor(opts: AttentionQueueOpts = {}) {
    this.taskIdFor = opts.taskIdFor ?? (() => null);
  }

  /** Resolve the snooze map key for a given agent: taskId if available, else the agentId. */
  private snoozeKey(agentId: string): string {
    return this.taskIdFor(agentId) ?? agentId;
  }

  enqueue(agentId: string, anomaly: Anomaly): void {
    this.lastRemoved.delete(agentId); // New anomaly supersedes any stale removed one

    // If snoozed (by task or agent), update the snoozed entry but don't add to active queue
    const key = this.snoozeKey(agentId);
    const snoozed = this.snoozed.get(key);
    if (snoozed) {
      // Preserve original detectedAt when anomaly type hasn't changed
      if (snoozed.anomaly.type === anomaly.type) {
        anomaly = { ...anomaly, detectedAt: snoozed.anomaly.detectedAt };
      }
      snoozed.anomaly = anomaly;
      return;
    }

    // Preserve original detectedAt when re-enqueuing the same anomaly type
    const existing = this.entries.get(agentId);
    if (existing && existing.anomaly.type === anomaly.type) {
      existing.anomaly = { ...anomaly, detectedAt: existing.anomaly.detectedAt };
      return;
    }

    this.entries.set(agentId, { agentId, anomaly, skipped: false });
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

  snooze(agentId: string, durationMs: number, reason?: string, fallbackAnomaly?: Anomaly): void {
    const entry = this.entries.get(agentId);
    const anomaly = entry?.anomaly ?? fallbackAnomaly;
    if (!anomaly) return; // No anomaly anywhere — nothing to snooze

    const key = this.snoozeKey(agentId);
    this.snoozed.set(key, {
      agentId,
      key,
      anomaly,
      expiresAt: Date.now() + durationMs,
      reason,
    });
    this.entries.delete(agentId); // No-op if entry was already absent
    this.lastRemoved.delete(agentId); // Consumed — no longer needed
  }

  /** Cancel snooze — move agent from snoozed map back to active entries. Returns true if the agent was snoozed. */
  cancelSnooze(agentId: string): boolean {
    const key = this.snoozeKey(agentId);
    const snoozed = this.snoozed.get(key);
    if (!snoozed) return false;

    this.entries.set(agentId, {
      agentId,
      anomaly: snoozed.anomaly,
      skipped: false,
    });
    this.snoozed.delete(snoozed.key);
    return true;
  }

  /** Remove from active entries only — preserves snooze state. Use for anomaly resolution. */
  remove(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      this.lastRemoved.set(agentId, entry.anomaly);
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
  getSnoozed(): Array<{ agentId: string; key: string; anomaly: Anomaly; expiresAt: number; reason?: string }> {
    const result: Array<{ agentId: string; key: string; anomaly: Anomaly; expiresAt: number; reason?: string }> = [];
    for (const entry of this.snoozed.values()) {
      result.push({
        agentId: entry.agentId,
        key: entry.key,
        anomaly: entry.anomaly,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
      });
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
    entries: Array<{ agentId: string; key: string; anomaly: Anomaly; expiresAt: number; reason?: string }>,
  ): void {
    for (const entry of entries) {
      this.snoozed.set(entry.key, {
        agentId: entry.agentId,
        key: entry.key,
        anomaly: entry.anomaly,
        expiresAt: entry.expiresAt,
        reason: entry.reason,
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
    return this.entries.get(agentId)?.anomaly
      ?? this.snoozed.get(this.snoozeKey(agentId))?.anomaly
      ?? this.lastRemoved.get(agentId)
      ?? null;
  }

  /** Get the active or snoozed anomaly only; excludes lastRemoved fallback. */
  peek(agentId: string): Anomaly | null {
    return this.entries.get(agentId)?.anomaly
      ?? this.snoozed.get(this.snoozeKey(agentId))?.anomaly
      ?? null;
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

  private restoreExpiredSnoozes(): void {
    const now = Date.now();
    for (const [key, snooze] of this.snoozed) {
      if (now < snooze.expiresAt) continue;

      // When the snooze is keyed by agentId (no resolver / orphan), restore
      // the anomaly under that same agentId — preserves the legacy "snooze
      // expires, finding pops back" UX that callers and tests rely on.
      //
      // When the snooze is keyed by taskId, the recorded agentId may now be
      // a long-dead session. Putting it into `entries` would leave a ghost
      // finding the supervisor never overwrites (the next live enqueue uses
      // a different agentId). Drop instead and let the supervisor's next
      // tick re-detect on the current session if the anomaly still applies.
      const isAgentKeyed = key === snooze.agentId;
      if (isAgentKeyed) {
        this.entries.set(snooze.agentId, {
          agentId: snooze.agentId,
          anomaly: snooze.anomaly,
          skipped: false,
        });
      }
      this.snoozed.delete(key);
    }
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
}
