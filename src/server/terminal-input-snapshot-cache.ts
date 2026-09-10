/**
 * Bounded, generation-scoped cache of per-session input-readiness snapshots the
 * supervisor mirrors from the terminal-host child. The child re-broadcasts live
 * snapshots and stamps every message (stats and RPC responses alike) with a
 * globally monotonic version, so this cache uses version to keep the newest
 * state per session and to fence stale stragglers.
 *
 * Two entry kinds share the capacity:
 *   - live      `{ value: snapshot, version }`
 *   - tombstone `{ value: null, version }` — a session that was cleaned up,
 *     retained so a late lower-version message cannot resurrect it.
 *
 * Completed sessions must not permanently consume capacity (that silently broke
 * readiness for every session past the cap), so at capacity a live snapshot may
 * reclaim the oldest tombstone's slot. Reclaiming drops that id's per-id version
 * fence, so the highest reclaimed version becomes a floor: any (re)insertion for
 * an id no longer cached — live OR tombstone — must carry a version above the
 * floor. A stale straggler for a reclaimed id (its version is at or below the
 * tombstone that fenced it) is therefore rejected instead of resurrecting the
 * dead session and cascade-evicting a live one; a genuinely new or re-registered
 * id always carries a higher (later) version and is admitted. The floor is
 * per-generation: a restarted child restarts its version counter at 0, so a new
 * generation must reset it (resetGeneration) or every fresh snapshot would be
 * fenced by the previous generation's floor.
 */
export const TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY = 512;

export class TerminalInputSnapshotCache<T> {
  private readonly entries = new Map<string, { version: number; value: T | null }>();
  private reclaimedVersionFloor = -1;

  constructor(private readonly capacity: number = TERMINAL_INPUT_SNAPSHOT_CACHE_CAPACITY) {}

  get size(): number { return this.entries.size; }
  has(sessionId: string): boolean { return this.entries.has(sessionId); }
  /** The live snapshot for a session, or null for an unknown or completed one. */
  get(sessionId: string): T | null { return this.entries.get(sessionId)?.value ?? null; }
  delete(sessionId: string): void { this.entries.delete(sessionId); }
  clear(): void { this.entries.clear(); }
  /** Reset the reclaim floor for a fresh child generation (versions restart at 0). */
  resetGeneration(): void { this.reclaimedVersionFloor = -1; }

  /** Cache a session's latest live snapshot, reclaiming a completed slot if full. */
  admitLive(sessionId: string, value: T, version: number): void {
    if (this.staleForReclaimed(sessionId, version)) return;
    // Only a genuine live overload (every slot holds a live snapshot) rejects a
    // new id; otherwise a completed (tombstone) slot is reclaimed for it.
    if (this.entries.size >= this.capacity && !this.entries.has(sessionId) && !this.reclaimCompletedSlot()) return;
    if ((this.entries.get(sessionId)?.version ?? -1) <= version) this.entries.set(sessionId, { value, version });
  }

  /** Record that a session was cleaned up, so a late lower-version message cannot revive it. */
  admitTombstone(sessionId: string, version: number): void {
    if (this.staleForReclaimed(sessionId, version)) return; // already fenced (floor >= version)
    // A tombstone never reclaims a slot — it protects, it does not need room — so
    // at capacity it cannot be stored for an id that is not already cached. But
    // the cleanup's fence must NOT be lost: absorb its version into the reclaim
    // floor so a later stale straggler for this id (e.g. a delayed bulk capture
    // reply generated before cleanup) still cannot resurrect the completed
    // session. Without this, a dropped tombstone leaves the id unfenced.
    if (!(this.entries.size < this.capacity || this.entries.has(sessionId))) {
      if (version > this.reclaimedVersionFloor) this.reclaimedVersionFloor = version;
      return;
    }
    if ((this.entries.get(sessionId)?.version ?? -1) <= version) this.entries.set(sessionId, { value: null, version });
  }

  private staleForReclaimed(sessionId: string, version: number): boolean {
    return !this.entries.has(sessionId) && version <= this.reclaimedVersionFloor;
  }

  /** Evict the oldest completed (tombstone) entry, raising the reclaim floor to
   * its version. Returns false when every slot holds a live snapshot. */
  private reclaimCompletedSlot(): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.value === null) {
        if (entry.version > this.reclaimedVersionFloor) this.reclaimedVersionFloor = entry.version;
        this.entries.delete(id);
        return true;
      }
    }
    return false;
  }
}
