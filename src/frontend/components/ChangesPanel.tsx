import React, { useEffect, useState } from 'react';
import { getTaskChangeFile, getTaskChanges } from '../api/index.js';
import type {
  TaskChangeFileResponse,
  TaskChangedFile,
  TaskChangesResponse,
  TaskChangesUnavailableReason,
} from '../../shared/contracts/task-changes.js';
import { DiffHunks, DiffPane } from './DiffPane.js';

/**
 * The reading pane's Changes tab (#4024 item 4, variant A "inline accordion";
 * design note docs/rfc/rfc-reading-pane-changes-tab.md). Lists what the task
 * changed in its working directory against the branch it forked from; a row
 * opens that file's diff under it. Git runs on the server only when this tab
 * mounts or the operator presses Refresh, never on a timer.
 *
 * Slice 2: an Edit or Write row clicked in the conversation opens that one
 * edit's patch at the top of this tab, and the file's row is marked.
 */

/** One tool call's edit, opened from the conversation. */
export interface ChangesEdit {
  agentId: string;
  toolUseId: string;
  /** The path the tool wrote to, usually absolute. */
  filePath: string;
  /** Server start time when the edit was opened, to detect a restart. */
  openedAt: string | null;
}

/**
 * The change-list path an edit's file path refers to, or `null` when it lies
 * outside the repository. Exported for tests.
 */
export function editPathInRepo(filePath: string, repoRoot: string): string | null {
  if (!filePath.startsWith('/')) return filePath.replace(/^\.\//, '');
  const root = repoRoot.endsWith('/') ? repoRoot : `${repoRoot}/`;
  return filePath.startsWith(root) ? filePath.slice(root.length) : null;
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ok'; body: Extract<TaskChangesResponse, { kind: 'ok' }> }
  | { kind: 'unavailable'; reason: TaskChangesUnavailableReason }
  | { kind: 'err' };

type FileState =
  | { kind: 'loading' }
  | { kind: 'ok'; body: TaskChangeFileResponse }
  | { kind: 'err'; message: string };

const UNAVAILABLE_TEXT: Record<TaskChangesUnavailableReason, string> = {
  no_cwd: 'No working directory is recorded for this task.',
  worktree_gone: "This task's worktree was removed. Its pull request shows what was pushed.",
  not_git: 'This task does not run in a git repository.',
  no_base: 'No base branch to compare against (no origin/main, origin/staging or origin/master).',
};

const STATUS_LETTER: Record<TaskChangedFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

interface ChangesPanelProps {
  /** The task whose changes to list; an agent with no task shows only `edit`. */
  taskId?: string;
  edit?: ChangesEdit | null;
  onCloseEdit?: () => void;
}

export function ChangesPanel({ taskId, edit = null, onCloseEdit }: ChangesPanelProps) {
  const editCard = edit ? (
    <div className="changes-edit" data-testid="changes-edit">
      <DiffPane
        agentId={edit.agentId}
        toolUseId={edit.toolUseId}
        filePath={edit.filePath}
        openedAt={edit.openedAt}
        onClose={() => onCloseEdit?.()}
      />
    </div>
  ) : null;
  if (!taskId) {
    return <div className="changes-panel" data-testid="changes-panel">{editCard}</div>;
  }
  return <TaskChangeList taskId={taskId} edit={edit} editCard={editCard} />;
}

function TaskChangeList({ taskId, edit, editCard }: { taskId: string; edit: ChangesEdit | null; editCard: React.ReactNode }) {
  const [list, setList] = useState<ListState>({ kind: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const ac = new AbortController();
    setList((prev) => (prev.kind === 'ok' ? prev : { kind: 'loading' }));
    getTaskChanges<TaskChangesResponse>(taskId, ac.signal)
      .then(({ ok, body }) => {
        if (ac.signal.aborted) return;
        if (!ok || !body) setList({ kind: 'err' });
        else if (body.kind === 'ok') setList({ kind: 'ok', body });
        else setList({ kind: 'unavailable', reason: body.reason });
      })
      .catch(() => {
        if (!ac.signal.aborted) setList({ kind: 'err' });
      });
    return () => ac.abort();
  }, [taskId, refreshKey]);

  function toggle(filePath: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }

  const refreshButton = (
    <button
      type="button"
      className="changes-refresh"
      data-testid="changes-refresh"
      onClick={() => setRefreshKey((k) => k + 1)}
    >
      Refresh
    </button>
  );

  if (list.kind === 'loading') {
    return <div className="changes-panel" data-testid="changes-panel">{editCard}<div className="changes-note">Loading changes…</div></div>;
  }
  if (list.kind === 'err' || list.kind === 'unavailable') {
    return (
      <div className="changes-panel" data-testid="changes-panel">
        {editCard}
        <div className="changes-head">
          <span className="changes-note" data-testid="changes-empty">
            {list.kind === 'err' ? 'Could not load the changes. Check the server log.' : UNAVAILABLE_TEXT[list.reason]}
          </span>
          {refreshButton}
        </div>
      </div>
    );
  }

  const { baseRef, branch, files, truncated, repoRoot } = list.body;
  const editPath = edit ? editPathInRepo(edit.filePath, repoRoot) : null;
  const totalAdded = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const totalRemoved = files.reduce((n, f) => n + (f.removed ?? 0), 0);

  return (
    <div className="changes-panel" data-testid="changes-panel">
      {editCard}
      <div className="changes-head">
        <span className="changes-summary" data-testid="changes-summary">
          {files.length === 0 ? 'No changes' : `${files.length} file${files.length === 1 ? '' : 's'}`}
          {' against '}<code>{baseRef}</code>
          {branch && <>{' on '}<code>{branch}</code></>}
        </span>
        {files.length > 0 && (
          <span className="changes-counts">
            <span className="changes-add">+{totalAdded}</span>{' '}
            <span className="changes-del">{'−'}{totalRemoved}</span>
          </span>
        )}
        {refreshButton}
      </div>
      {truncated && <div className="changes-note">Only the first {files.length} files are listed.</div>}
      <ul className="changes-list">
        {files.map((file) => {
          const open = expanded.has(file.path);
          const editTarget = editPath === file.path;
          const slash = file.path.lastIndexOf('/');
          return (
            <li key={file.path} className="changes-item">
              <button
                type="button"
                className={`changes-row${open ? ' is-open' : ''}${editTarget ? ' is-edit-target' : ''}`}
                data-edit-target={editTarget ? 'true' : undefined}
                aria-expanded={open}
                data-testid="changes-row"
                onClick={() => toggle(file.path)}
                title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              >
                <span className="changes-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                <span className={`changes-status changes-status-${file.status}`} title={file.status}>
                  {STATUS_LETTER[file.status]}
                </span>
                <span className="changes-path">
                  {slash >= 0 && <span className="changes-dir">{file.path.slice(0, slash + 1)}</span>}
                  <span className="changes-name">{file.path.slice(slash + 1)}</span>
                </span>
                {editTarget && <span className="changes-edit-mark">opened edit</span>}
                {file.added === null ? (
                  <span className="changes-note">binary</span>
                ) : (
                  <span className="changes-counts">
                    <span className="changes-add">+{file.added}</span>{' '}
                    <span className="changes-del">{'−'}{file.removed ?? 0}</span>
                  </span>
                )}
              </button>
              {open && <ChangeFileDiff taskId={taskId} filePath={file.path} refreshKey={refreshKey} renamed={file.status === 'renamed'} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChangeFileDiff({ taskId, filePath, refreshKey, renamed }: { taskId: string; filePath: string; refreshKey: number; renamed: boolean }) {
  const [state, setState] = useState<FileState>({ kind: 'loading' });

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: 'loading' });
    getTaskChangeFile<TaskChangeFileResponse>(taskId, filePath, ac.signal)
      .then(({ ok, status, body }) => {
        if (ac.signal.aborted) return;
        if (ok && body) setState({ kind: 'ok', body });
        else if (status === 404) setState({ kind: 'err', message: 'This file is no longer in the change list. Press Refresh.' });
        else setState({ kind: 'err', message: 'Could not load the diff. Check the server log.' });
      })
      .catch(() => {
        if (!ac.signal.aborted) setState({ kind: 'err', message: 'Could not load the diff. Check the server log.' });
      });
    return () => ac.abort();
  }, [taskId, filePath, refreshKey]);

  let content: React.ReactNode;
  if (state.kind === 'loading') content = <div className="changes-note">Loading diff…</div>;
  else if (state.kind === 'err') content = <div className="changes-note">{state.message}</div>;
  else if (state.body.kind === 'binary') content = <div className="changes-note">Binary file; no text diff.</div>;
  else if (state.body.kind === 'too_large') content = <div className="changes-note">This diff is over 1 MB; open it in the terminal.</div>;
  else if (state.body.kind === 'unavailable') content = <div className="changes-note">{UNAVAILABLE_TEXT[state.body.reason]}</div>;
  else if (state.body.hunks.length === 0) {
    content = <div className="changes-note">{renamed ? 'Renamed; the content is unchanged.' : 'No line changes.'}</div>;
  } else content = <DiffHunks hunks={state.body.hunks} />;

  return <div className="changes-diff" data-testid="changes-diff">{content}</div>;
}
