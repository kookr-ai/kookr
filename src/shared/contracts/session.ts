import type { AgentType } from './agent-types.js';
import type { CodexHookCapabilities } from './hook-events.js';
import type { AgentStatus } from './task-status.js';

export interface GitInfo {
  branch: string | null;
  commit: string | null;
  isWorktree: boolean;
  isDetached: boolean;
}

export type WorktreeHealth =
  | 'ok'
  | 'stale'
  | 'missing'
  | 'missing_unexpectedly'
  | 'cleaned_up';

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
  claudeSessionId?: string;
  transcriptPath?: string;
  childSessionIds?: Record<string, ChildSessionInfo>;
  codexHookCapabilities?: CodexHookCapabilities;
  lastStatus?: AgentStatus | 'completed' | 'aborted';
  lastEventAt?: number;
  gitBranch?: string;
  gitCommit?: string;
  gitIsWorktree?: boolean;
  gitIsDetached?: boolean;
  worktreeHealth?: WorktreeHealth;
  worktreeHealthObservedAt?: string;
  worktreeRegistryStale?: boolean;
  crashRecovered?: boolean;
  relaunchCount?: number;
  lastRelaunchedAt?: number;
  resumedFromCrash?: boolean;
}
