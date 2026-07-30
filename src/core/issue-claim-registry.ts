import { isTerminalStatus } from './task-status.js';
import {
  claimKeyString,
  type ClaimEvent,
  type ClaimKey,
  type ClaimOwnerRecord,
  type ClaimResult,
  type ClaimTaskPort,
  type ClaimTaskView,
} from './issue-claim-types.js';

/**
 * IssueClaimRegistry — single owner of authoritative issue-ownership state
 * (RFC: rfc-issue-ownership-lock).
 *
 * Modeled on {@link WorktreeLeaseService}: an in-memory Map is the live
 * authority (R2); `Task.issueClaim` is its durable projection, written only
 * through the injected port (R3). The whole `claim()` body is synchronous —
 * no await between check and set (R4) — which, combined with the single
 * server process (R27), makes the compare-and-set atomic by construction.
 *
 * Liveness/staleness is deliberately NOT consulted here: the only ownership
 * test is the synchronous store status (`isTerminalStatus`). Confirmed-dead
 * reclaim rides the reconcile-driven terminate → `releaseAllFor` (R12);
 * time-based staleness raises a coordinator finding elsewhere (R13).
 *
 * Every decision is emitted through the injected sink — the sink is the sole
 * audit author (R21); callers consume the structured return values instead of
 * re-deriving events.
 */
export class IssueClaimRegistry {
  /** key (claimKeyString) → owning taskId. The live authority. */
  private owners = new Map<string, string>();

  constructor(
    private readonly port: ClaimTaskPort,
    private readonly emit: (event: ClaimEvent) => void,
  ) {}

  /**
   * Rebuild the authority map from persisted `issueClaim` fields on
   * non-terminal tasks. Called once at boot, before the HTTP listener
   * serves requests (RFC §8 boot-ordering invariant).
   */
  rebuildFromTasks(): { owners: number; activeTasks: number; ignoredTerminalFields: number } {
    this.owners.clear();
    let ignoredTerminalFields = 0;
    const views = this.port.activeTaskViews();
    for (const view of views) {
      if (!view.issueClaim) continue;
      if (isTerminalStatus(view.status)) {
        ignoredTerminalFields++;
        continue;
      }
      const key = claimKeyString(view.issueClaim);
      // First non-terminal owner wins on (impossible-by-invariant) duplicates.
      if (!this.owners.has(key)) this.owners.set(key, view.id);
    }
    return { owners: this.owners.size, activeTasks: views.length, ignoredTerminalFields };
  }

  /**
   * Atomic claim. Fully synchronous (R4): the held-check reads the holder's
   * in-memory store status only — never an async liveness probe.
   *
   * Re-entrant for the owner (R6). With `force`, displaces a live holder,
   * recording the takeover (R17). A holder that is terminal or missing is
   * reclaimed inline (orphan reclaim, R11) — its release should already have
   * fired via the lifecycle wrappers; this is the self-healing backstop.
   */
  claim(
    key: ClaimKey,
    claimant: { taskId: string; sessionId?: string },
    opts: { force?: boolean } = {},
  ): ClaimResult {
    const k = claimKeyString(key);
    const holderId = this.owners.get(k);

    if (holderId !== undefined) {
      const holder = this.port.getTaskView(holderId);
      const holderLive = holder !== undefined && !isTerminalStatus(holder.status);

      if (holderLive && holderId === claimant.taskId) {
        // Refresh the designated session — after a crash-relaunch the task
        // re-claims from a NEW session, and the owner block's `doing` must
        // follow the live session, not the dead one.
        if (claimant.sessionId !== undefined && holder.issueClaim) {
          this.port.setIssueClaim(holderId, { ...holder.issueClaim, sessionId: claimant.sessionId });
        }
        this.emit({ decision: 'reentrant', ...key, requestingTaskId: claimant.taskId, requestingSessionId: claimant.sessionId });
        return { ok: true, reentrant: true };
      }

      if (holderLive && !opts.force) {
        this.emit({
          decision: 'denied', ...key,
          requestingTaskId: claimant.taskId,
          requestingSessionId: claimant.sessionId,
          priorOwnerTaskId: holderId,
        });
        return { ok: false, owner: this.toOwnerRecord(holder) };
      }

      if (holderLive && opts.force) {
        // CAS-guarded takeover (R17): still inside the synchronous section.
        const displaced = this.toOwnerRecord(holder);
        this.port.clearIssueClaim(holderId);
        this.owners.delete(k);
        this.grant(key, claimant, holderId);
        this.emit({
          decision: 'force', ...key,
          requestingTaskId: claimant.taskId,
          requestingSessionId: claimant.sessionId,
          priorOwnerTaskId: holderId,
          reason: `displaced owner status=${displaced.ownerStatus}`,
        });
        return { ok: true, reentrant: false, tookOver: displaced };
      }

      // Holder terminal or missing: stale map entry — reclaim and grant.
      this.owners.delete(k);
      if (holder) this.port.clearIssueClaim(holderId);
      this.emit({
        decision: 'orphan_reclaim', ...key,
        requestingTaskId: claimant.taskId,
        priorOwnerTaskId: holderId,
      });
    }

    this.grant(key, claimant);
    this.emit({ decision: 'granted', ...key, requestingTaskId: claimant.taskId, requestingSessionId: claimant.sessionId });
    return { ok: true, reentrant: false };
  }

  /**
   * Release every claim held by a task. Holder-checked by construction: only
   * map entries pointing at `taskId` are cleared, so a displaced-then-
   * terminal old owner cannot delete the new owner's claim (R10).
   */
  releaseAllFor(
    taskId: string,
    reason: 'released' | 'dead_reclaim' | 'orphan_reclaim' = 'released',
  ): ClaimKey[] {
    const released: ClaimKey[] = [];
    for (const [k, ownerId] of this.owners) {
      if (ownerId !== taskId) continue;
      this.owners.delete(k);
      const [repo, numberStr] = k.split('\t');
      const key: ClaimKey = { repo, number: Number(numberStr) };
      released.push(key);
      this.emit({ decision: reason, ...key, requestingTaskId: taskId, priorOwnerTaskId: taskId });
    }
    if (released.length > 0) this.port.clearIssueClaim(taskId);
    return released;
  }

  /**
   * Release wrapper for hot-path call sites (terminal wrappers, reconcile —
   * RFC R9b): NEVER throws, so a registry defect cannot abort task-completion
   * cleanup or a reconcile tick. A failure is not silent either — it logs at
   * error level and emits `release_failed`, because a swallowed release
   * failure is a leaked claim and R14's no-leak guarantee is unfalsifiable
   * without the signal.
   */
  safeReleaseAllFor(
    taskId: string,
    reason: 'released' | 'dead_reclaim' | 'orphan_reclaim' = 'released',
  ): ClaimKey[] {
    try {
      return this.releaseAllFor(taskId, reason);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[issue-claims] release failed for task ${taskId}: ${message}`);
      try {
        let repo = '';
        let number = 0;
        try {
          const claim = this.port.getTaskView(taskId)?.issueClaim;
          if (claim) ({ repo, number } = claim);
        } catch {
          // view lookup failed too — emit with empty key
        }
        this.emit({ decision: 'release_failed', repo, number, requestingTaskId: taskId, reason: message });
      } catch {
        // sink failure is already logged inside the sink; nothing else to do
      }
      return [];
    }
  }

  /** Bare ownership fact for one key, or null. Live decoration is server-side (R22). */
  ownerRecord(key: ClaimKey): ClaimOwnerRecord | null {
    const holderId = this.owners.get(claimKeyString(key));
    if (holderId === undefined) return null;
    const holder = this.port.getTaskView(holderId);
    if (!holder || isTerminalStatus(holder.status)) return null;
    return this.toOwnerRecord(holder);
  }

  /** All active claims, optionally filtered. */
  listRecords(filter: { repo?: string; number?: number } = {}): ClaimOwnerRecord[] {
    const records: ClaimOwnerRecord[] = [];
    for (const holderId of this.owners.values()) {
      const holder = this.port.getTaskView(holderId);
      if (!holder?.issueClaim || isTerminalStatus(holder.status)) continue;
      if (filter.repo !== undefined && holder.issueClaim.repo !== filter.repo) continue;
      if (filter.number !== undefined && holder.issueClaim.number !== filter.number) continue;
      records.push(this.toOwnerRecord(holder));
    }
    return records;
  }

  /**
   * Record that an automatic caller exhausted re-selection after exit-6
   * denials (RFC R16). Emits a single `exhausted` ClaimEvent so give-up is
   * observable in the audit log — callers also surface a coordinator finding.
   * Does not mutate ownership state.
   */
  recordExhausted(
    key: ClaimKey,
    opts: { requestingTaskId?: string; reason?: string } = {},
  ): void {
    this.emit({
      decision: 'exhausted',
      ...key,
      ...(opts.requestingTaskId !== undefined ? { requestingTaskId: opts.requestingTaskId } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }

  private grant(key: ClaimKey, claimant: { taskId: string; sessionId?: string }, takeoverOf?: string): void {
    // One claim per task (PR 1): a task claiming a new key releases its old one.
    this.releaseAllFor(claimant.taskId);
    this.owners.set(claimKeyString(key), claimant.taskId);
    this.port.setIssueClaim(claimant.taskId, {
      repo: key.repo,
      number: key.number,
      claimedAt: new Date().toISOString(),
      ...(claimant.sessionId !== undefined ? { sessionId: claimant.sessionId } : {}),
      ...(takeoverOf !== undefined ? { takeoverOf } : {}),
    });
  }

  private toOwnerRecord(view: ClaimTaskView): ClaimOwnerRecord {
    const claim = view.issueClaim;
    return {
      repo: claim?.repo ?? '',
      number: claim?.number ?? 0,
      taskId: view.id,
      claimedAt: claim?.claimedAt ?? '',
      ownerStatus: view.status,
      ...(claim?.sessionId !== undefined ? { sessionId: claim.sessionId } : {}),
      ...(claim?.takeoverOf !== undefined ? { takeoverOf: claim.takeoverOf } : {}),
      ...(view.name !== undefined ? { ownerName: view.name } : {}),
      ...(view.worktreePath !== undefined ? { worktreePath: view.worktreePath } : {}),
    };
  }
}
