/**
 * Per-task change list for the reading pane's Changes tab (#4024 item 4,
 * design note docs/rfc/rfc-reading-pane-changes-tab.md).
 *
 * The server diffs the task's working directory against the branch it forked
 * from, uncommitted and new files included. These are the response shapes of
 * `GET /api/tasks/:id/changes` and `GET /api/tasks/:id/changes/file`.
 */

export type TaskChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface TaskChangedFile {
  /** Path relative to the repository root (the new path for a rename). */
  path: string;
  /** The path before a rename; set only when `status` is `renamed`. */
  oldPath?: string;
  status: TaskChangeStatus;
  /** Line counts; `null` for a binary file (or a new file too large to count). */
  added: number | null;
  removed: number | null;
}

/** Why the tab has no list to show. */
export type TaskChangesUnavailableReason =
  | 'no_cwd'
  | 'worktree_gone'
  | 'not_git'
  | 'no_base';

export type TaskChangesResponse =
  | {
      kind: 'ok';
      /** The ref the diff is against, e.g. `origin/staging`. */
      baseRef: string;
      /** The worktree's branch, or `null` on a detached HEAD. */
      branch: string | null;
      files: TaskChangedFile[];
      /** True when the list was cut at the server's file cap. */
      truncated: boolean;
    }
  | { kind: 'unavailable'; reason: TaskChangesUnavailableReason };

/** One hunk of a unified diff; the same shape the per-edit diff view renders. */
export interface TaskChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line keeps its leading marker: `+`, `-`, a space, or `\`. */
  lines: string[];
}

export type TaskChangeFileResponse =
  | { kind: 'patch'; path: string; hunks: TaskChangeHunk[] }
  | { kind: 'binary'; path: string }
  | { kind: 'too_large'; path: string }
  | { kind: 'unavailable'; reason: TaskChangesUnavailableReason };
