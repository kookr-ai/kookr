import type { AgentType } from './agent-types.js';
import type { CodexHookCapabilities } from './hook-events.js';
import type { AgentStatus, TurnState } from './task-status.js';

// Git repository metadata (moved from adapters/git-info.ts to fix core->adapters dependency)
export interface GitInfo {
  branch: string | null;
  commit: string | null;
  /** Private Git administrative directory for a linked worktree, when known. */
  gitDir?: string;
  isWorktree: boolean;
  isDetached: boolean;
  /** Top-level working tree path for the repository that produced this metadata. */
  worktreeRoot?: string;
}

export type WorktreeHealth =
  | 'ok'
  | 'stale'
  /** Legacy value retained for persisted tasks from older builds. New unexpected misses use `missing_unexpectedly`. */
  | 'missing'
  | 'missing_unexpectedly'
  | 'cleaned_up';

/**
 * Per-Kookr-session record of a provider runtime session id that appeared on
 * the same hook file after the parent runtime session was established.
 */
export interface ChildSessionInfo {
  firstSeenAt: string;
  transcriptPath?: string;
  reason: 'subagent_hook' | 'inherited_settings' | 'unknown';
}

export interface SessionInfo {
  tmuxSession: string;
  agentType: AgentType;
  cwd: string;
  createdAt: Date;
  /**
   * Parent runtime session id. Set on the FIRST SessionStart hook for this
   * Kookr session and frozen thereafter; later distinct session_ids on the
   * same hook file are recorded under childSessionIds, not here.
   * Historical name: `claudeSessionId`, kept for persistence compatibility.
   */
  claudeSessionId?: string;
  /** Transcript for the parent runtime session. Frozen with parent. */
  transcriptPath?: string;
  /**
   * Runtime session ids that wrote to this Kookr session's hook file after
   * the parent was established.
   */
  childSessionIds?: Record<string, ChildSessionInfo>;
  codexHookCapabilities?: CodexHookCapabilities;
  lastStatus?: AgentStatus | 'completed' | 'aborted';
  /**
   * The agent's most recently observed {@link TurnState} for this session
   * (turn-state concept: #358), persisted from the event pipeline so it survives
   * monitor cleanup and server restarts. Never set to `'unknown'` (so a trailing
   * `session_end`, which derives `unknown`, cannot erase a prior `completed_turn`).
   * Reconciliation reads it to tell a graceful finish from a mid-turn crash when
   * the session dies — see `endedOnCleanTurn` in reconciliation.ts (#693).
   */
  lastTurnState?: TurnState;
  /** Last hook event timestamp (ms since epoch). Persisted for watchdog restart recovery. */
  lastEventAt?: number;
  gitBranch?: string;
  gitCommit?: string;
  /** Private Git administrative directory captured for worktree identity checks. */
  gitDir?: string;
  gitIsWorktree?: boolean;
  gitIsDetached?: boolean;
  worktreeHealth?: WorktreeHealth;
  worktreeHealthObservedAt?: string;
  worktreeRegistryStale?: boolean;
  /** Set to true when this session was terminated by a crash and a replacement was launched. */
  crashRecovered?: boolean;
  /** How many times this session chain has been relaunched (0 = original). */
  relaunchCount?: number;
  /** Timestamp (ms since epoch) when this session chain was last relaunched. */
  lastRelaunchedAt?: number;
  /**
   * Set to true on a NEW session that was launched via `claude --resume <id> --fork-session`
   * after a crash, vs a fresh launch from the original prompt. The dead predecessor
   * retains the existing `crashRecovered: true` flag. See docs/rfc/rfc-crash-recovery-resume.md.
   */
  resumedFromCrash?: boolean;
}
