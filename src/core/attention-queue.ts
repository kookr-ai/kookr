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

export class AttentionQueue {
  private entries = new Map<string, QueueEntry>();
  private snoozed = new Map<string, { anomaly: Anomaly; expiresAt: number; reason?: string }>();
  /** Anomaly preserved from the last remove() call — fallback for snooze race. */
  private lastRemoved = new Map<string, Anomaly>();

  enqueue(agentId: string, anomaly: Anomaly): void {
    this.lastRemoved.delete(agentId); // New anomaly supersedes any stale removed one

    // If snoozed, update the snoozed entry but don't add to active queue
    if (this.snoozed.has(agentId)) {
      const snoozed = this.snoozed.get(agentId)!;
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

    this.snoozed.set(agentId, {
      anomaly,
      expiresAt: Date.now() + durationMs,
      reason,
    });
    this.entries.delete(agentId); // No-op if entry was already absent
    this.lastRemoved.delete(agentId); // Consumed — no longer needed
  }

  /** Cancel snooze — move agent from snoozed map back to active entries. Returns true if the agent was snoozed. */
  cancelSnooze(agentId: string): boolean {
    const snoozed = this.snoozed.get(agentId);
    if (!snoozed) return false;

    this.entries.set(agentId, {
      agentId,
      anomaly: snoozed.anomaly,
      skipped: false,
    });
    this.snoozed.delete(agentId);
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

  /** Purge from both entries and snoozed maps. Use for session cleanup / unregister. */
  purge(agentId: string): void {
    this.entries.delete(agentId);
    this.snoozed.delete(agentId);
    this.lastRemoved.delete(agentId);
  }

  /** Returns all snoozed entries (for persistence). */
  getSnoozed(): Array<{ agentId: string; anomaly: Anomaly; expiresAt: number; reason?: string }> {
    const result: Array<{ agentId: string; anomaly: Anomaly; expiresAt: number; reason?: string }> = [];
    for (const [agentId, entry] of this.snoozed) {
      result.push({ agentId, anomaly: entry.anomaly, expiresAt: entry.expiresAt, reason: entry.reason });
    }
    return result;
  }

  /** Import snoozed entries (from persistence). Clears any conflicting active entries. */
  importSnoozed(entries: Array<{ agentId: string; anomaly: Anomaly; expiresAt: number; reason?: string }>): void {
    for (const entry of entries) {
      this.snoozed.set(entry.agentId, {
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
    const entry = this.snoozed.get(agentId);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) return null; // expired
    return entry.expiresAt;
  }

  /** Get the stored anomaly for an agent (with persisted detectedAt), or null. */
  getAnomaly(agentId: string): Anomaly | null {
    return this.entries.get(agentId)?.anomaly
      ?? this.snoozed.get(agentId)?.anomaly
      ?? this.lastRemoved.get(agentId)
      ?? null;
  }

  /** Get the active or snoozed anomaly only; excludes lastRemoved fallback. */
  peek(agentId: string): Anomaly | null {
    return this.entries.get(agentId)?.anomaly
      ?? this.snoozed.get(agentId)?.anomaly
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
    for (const [agentId, snooze] of this.snoozed) {
      if (now >= snooze.expiresAt) {
        this.entries.set(agentId, {
          agentId,
          anomaly: snooze.anomaly,
          skipped: false,
        });
        this.snoozed.delete(agentId);
      }
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
