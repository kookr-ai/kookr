import type { TaskStatus } from './task-status.js';

/**
 * Issue-ownership claim types (RFC: rfc-issue-ownership-lock).
 *
 * A claim records that one task owns one GitHub issue. The live authority is
 * the in-memory map inside {@link IssueClaimRegistry}; `Task.issueClaim` is
 * its durable projection, written only via `TaskStore.setIssueClaim` /
 * `clearIssueClaim` (RFC R2/R3).
 */

/** Durable projection stored on the owning Task. */
export interface IssueClaim {
  /** Canonical home repo of the issue, e.g. "github.com/owner/repo" (upstream for forks). */
  repo: string;
  /** GitHub issue number. */
  number: number;
  /** The designated live session for the owning task, when known. */
  sessionId?: string;
  /** ISO timestamp of the grant. */
  claimedAt: string;
  /** Task id this claim forcibly displaced via --force, if any. */
  takeoverOf?: string;
}

/** The identity a claim locks on. */
export interface ClaimKey {
  repo: string;
  number: number;
}

/** Canonical string form of a claim key (map key). */
export function claimKeyString(key: ClaimKey): string {
  return `${key.repo}\t${key.number}`;
}

/**
 * Every claim decision flows through the registry's injected sink as one of
 * these (RFC R21). `release_failed` exists so a swallowed release error is a
 * recorded leak, not an invisible one (R9b); `exhausted` records a caller
 * giving up re-selection (R16).
 */
export type ClaimDecision =
  | 'granted'
  | 'reentrant'
  | 'denied'
  | 'released'
  | 'dead_reclaim'
  | 'orphan_reclaim'
  | 'force'
  | 'release_failed'
  | 'exhausted';

export interface ClaimEvent {
  decision: ClaimDecision;
  repo: string;
  number: number;
  requestingTaskId?: string;
  requestingSessionId?: string;
  priorOwnerTaskId?: string;
  reason?: string;
}

/**
 * Bare ownership fact returned by the registry. Live fields (`doing`,
 * `lastActivityAt`, `ageMs`) are added by the server-side decorator (RFC R22)
 * — never computed in core.
 */
export interface ClaimOwnerRecord {
  repo: string;
  number: number;
  taskId: string;
  sessionId?: string;
  claimedAt: string;
  takeoverOf?: string;
  /** Owner task status at read time (synchronous store status). */
  ownerStatus: TaskStatus;
  /** Owner task name, for the refusal block (RFC R15). */
  ownerName?: string;
  /** Owner worktree path, when known. */
  worktreePath?: string;
}

export type ClaimResult =
  | { ok: true; reentrant: boolean; tookOver?: ClaimOwnerRecord }
  | { ok: false; owner: ClaimOwnerRecord };

/**
 * Narrow projection of Task the registry reads — deliberately not the full
 * Task shape (RFC §3: narrow port, no `Monitor`/`TerminalBackend`/server
 * imports in core).
 */
export interface ClaimTaskView {
  id: string;
  status: TaskStatus;
  name?: string;
  issueClaim?: IssueClaim;
  /** cwd of the most recent session, when available (owner block display). */
  worktreePath?: string;
}

/**
 * Port the registry depends on. `setIssueClaim` is a synchronous in-memory
 * field write (like `TaskStore.setProjectId`); durability flushing is the
 * caller's concern (server wiring awaits the save scheduler after a grant,
 * RFC R5) so the registry's critical section stays yield-free (R4).
 */
export interface ClaimTaskPort {
  activeTaskViews(): ClaimTaskView[];
  getTaskView(taskId: string): ClaimTaskView | undefined;
  setIssueClaim(taskId: string, claim: IssueClaim): void;
  clearIssueClaim(taskId: string): void;
}
