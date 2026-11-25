import { isNonEmptyOperatorDraft } from '../../shared/operator-draft.js';

/**
 * Unsent terminal drafts, kept in this browser so a prompt the operator was
 * writing survives its task being closed.
 *
 * The draft is stored per task AND per terminal session. When a task is
 * closed and reopened, the reopened task runs in a new session, and the
 * draft typed in the old one becomes "recoverable": the terminal panel offers
 * to put it back. Typing in the new session writes the new session's own
 * entry, so it never overwrites the draft waiting to be recovered.
 *
 * Browser storage can be missing or throw (private window, blocked site
 * data); every access is guarded and the panel works without it.
 */

const KEY_PREFIX = 'kookr.unsentTerminalDraft.v1.';
/** Entries older than this are dropped on the next save. */
export const UNSENT_DRAFT_RETENTION_MS = 14 * 24 * 60 * 60_000;

export interface UnsentTerminalDraft {
  taskId: string;
  sessionName: string;
  text: string;
  savedAt: number;
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function keyFor(taskId: string, sessionName: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(taskId)}.${encodeURIComponent(sessionName)}`;
}

function parse(raw: string | null): UnsentTerminalDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UnsentTerminalDraft>;
    if (
      typeof value.taskId === 'string'
      && typeof value.sessionName === 'string'
      && typeof value.text === 'string'
      && typeof value.savedAt === 'number'
    ) {
      return value as UnsentTerminalDraft;
    }
  } catch {
    // Corrupt entry: treat as absent.
  }
  return null;
}

function allEntries(store: Storage): Array<{ key: string; draft: UnsentTerminalDraft | null }> {
  const out: Array<{ key: string; draft: UnsentTerminalDraft | null }> = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(KEY_PREFIX)) out.push({ key, draft: parse(store.getItem(key)) });
  }
  return out;
}

/**
 * Record the current draft of a task's terminal session. An empty draft (the
 * prompt was submitted or erased) removes that session's entry.
 */
export function saveUnsentTerminalDraft(
  taskId: string,
  sessionName: string,
  text: string,
  nowMs: number = Date.now(),
): void {
  const store = storage();
  if (!store) return;
  try {
    const key = keyFor(taskId, sessionName);
    if (!isNonEmptyOperatorDraft(text)) {
      store.removeItem(key);
      return;
    }
    for (const entry of allEntries(store)) {
      if (!entry.draft || nowMs - entry.draft.savedAt > UNSENT_DRAFT_RETENTION_MS) {
        store.removeItem(entry.key);
      }
    }
    const draft: UnsentTerminalDraft = { taskId, sessionName, text, savedAt: nowMs };
    store.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota or access error: the draft simply is not kept.
  }
}

/**
 * The most recent draft typed in an EARLIER session of this task (one that is
 * no longer the session on screen), or null. This is what a reopened task can
 * offer to restore.
 */
export function findRecoverableTerminalDraft(
  taskId: string,
  currentSessionName: string | null,
): UnsentTerminalDraft | null {
  const store = storage();
  if (!store) return null;
  try {
    let latest: UnsentTerminalDraft | null = null;
    for (const { draft } of allEntries(store)) {
      if (!draft || draft.taskId !== taskId || draft.sessionName === currentSessionName) continue;
      if (!isNonEmptyOperatorDraft(draft.text)) continue;
      if (!latest || draft.savedAt > latest.savedAt) latest = draft;
    }
    return latest;
  } catch {
    return null;
  }
}

/**
 * Drop every stored draft of this task's earlier sessions, once the operator
 * restored or dismissed the recovered one. The current session's entry stays.
 */
export function discardRecoverableTerminalDrafts(taskId: string, currentSessionName: string | null): void {
  const store = storage();
  if (!store) return;
  try {
    for (const { key, draft } of allEntries(store)) {
      if (draft && draft.taskId === taskId && draft.sessionName !== currentSessionName) {
        store.removeItem(key);
      }
    }
  } catch {
    // Nothing else to do.
  }
}
