/**
 * The conversation thread in Lucy's column: everything said between the operator and her, in the order
 * it happened, in one list.
 *
 * An entry is one of:
 *  - something the operator typed, and Lucy's reply to it (`typed-you`, `typed-lucy`);
 *  - the operator's words and Lucy's words in a hands-free Talk exchange (`talk-you`, `talk-lucy`);
 *  - a notice about the connection (`notice`);
 *  - a message Lucy said aloud on her own: a task summary, a question, a permission notice (`clip`).
 *
 * The list is bounded (the last {@link MAX_CONVERSATION_ENTRIES} entries) and kept in `sessionStorage`,
 * so a page reload in the same tab keeps the thread but a new tab starts with an empty one. Only text is
 * stored, never audio: a spoken message that has lost its audio stays in the thread as text.
 *
 * What is NOT kept across a reload: a draft of the operator's speech that never became final, and an
 * answer that was still arriving (it is closed with a note that it was cut off), because nothing is
 * left to finish them.
 *
 * The recording of Talk exchanges and spoken clips into this store is done by `avatar/useThreadSync.ts`
 * from the dock, which stays mounted while the panel is minimised; this file only holds the list.
 */
import { useSyncExternalStore } from 'react';

/** How many entries are kept; older ones fall off the top of the thread. */
export const MAX_CONVERSATION_ENTRIES = 200;
export const LUCY_CONVERSATION_KEY = 'kookr:lucyConversation';
/** What an answer that was still arriving when the page reloaded says instead of its missing end. */
export const CUT_OFF_BY_RELOAD_TEXT = 'This answer was cut off when the page reloaded.';

interface EntryBase {
  id: string;
  /** When it was added (epoch milliseconds). */
  at: number;
}

export type ConversationEntry =
  | (EntryBase & { kind: 'typed-you'; text: string })
  /** `pending` until the first text arrives, `error` when `text` is the reason it failed. */
  | (EntryBase & { kind: 'typed-lucy'; text: string; status: 'pending' | 'done' | 'error' })
  | (EntryBase & { kind: 'talk-you'; text: string; final: boolean })
  | (EntryBase & { kind: 'talk-lucy'; text: string })
  | (EntryBase & { kind: 'notice'; text: string })
  | (EntryBase & { kind: 'clip'; clipId: string; text: string; subject?: string; usedFallback?: boolean });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller gives to {@link appendConversationEntry}: an entry without the fields the store fills in. */
export type NewConversationEntry = DistributiveOmit<ConversationEntry, 'id' | 'at'> & { at?: number };

const EMPTY: readonly ConversationEntry[] = Object.freeze([]);
/** How long a burst of streamed text waits before it is written to storage. */
const SAVE_DELAY_MS = 300;

let entries: readonly ConversationEntry[] = loadEntries();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idSeq = 0;

function getStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is ConversationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.at !== 'number' || typeof entry.text !== 'string') return false;
  switch (entry.kind) {
    case 'typed-you':
    case 'talk-lucy':
    case 'notice':
      return true;
    case 'typed-lucy':
      return entry.status === 'pending' || entry.status === 'done' || entry.status === 'error';
    case 'talk-you':
      return typeof entry.final === 'boolean';
    case 'clip':
      return typeof entry.clipId === 'string';
    default:
      return false;
  }
}

/** The thread saved by this tab, repaired for what a reload cuts short. Never throws. */
function loadEntries(): readonly ConversationEntry[] {
  const storage = getStorage();
  if (!storage) return EMPTY;
  try {
    const raw = storage.getItem(LUCY_CONVERSATION_KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    const restored: ConversationEntry[] = [];
    for (const item of parsed) {
      if (!isEntry(item)) continue;
      // A draft that never became final has nothing left to finish it.
      if (item.kind === 'talk-you' && !item.final) continue;
      if (item.kind === 'typed-lucy' && item.status === 'pending') {
        restored.push({ ...item, status: 'error', text: CUT_OFF_BY_RELOAD_TEXT });
      } else {
        restored.push(item);
      }
    }
    return restored.length === 0 ? EMPTY : Object.freeze(restored.slice(-MAX_CONVERSATION_ENTRIES));
  } catch {
    return EMPTY;
  }
}

function save(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const storage = getStorage();
  if (!storage) return;
  try {
    // Drafts are never stored: see the header.
    const stored = entries.filter((entry) => !(entry.kind === 'talk-you' && !entry.final));
    if (stored.length === 0) storage.removeItem(LUCY_CONVERSATION_KEY);
    else storage.setItem(LUCY_CONVERSATION_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or refused: the thread still works for this page.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(next: readonly ConversationEntry[], saveNow: boolean): void {
  entries = next.length === 0 ? EMPTY : Object.freeze(next.slice(-MAX_CONVERSATION_ENTRIES));
  if (saveNow) save();
  else if (saveTimer === null) saveTimer = setTimeout(save, SAVE_DELAY_MS);
  emit();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Text still arriving when the page goes away is written out at once.
  window.addEventListener('pagehide', () => { if (saveTimer !== null) save(); });
}

function newId(): string {
  idSeq += 1;
  return `${Date.now().toString(36)}-${idSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Add an entry at the bottom of the thread and return its id. */
export function appendConversationEntry(entry: NewConversationEntry): string {
  const id = newId();
  commit([...entries, { ...entry, id, at: entry.at ?? Date.now() } as ConversationEntry], true);
  return id;
}

/**
 * Change an entry (more streamed text, a draft that became final). The write to storage is delayed a
 * moment, so a long answer arriving word by word is not written word by word. An unknown id is ignored.
 */
export function updateConversationEntry(id: string, patch: { text?: string; final?: boolean; status?: 'pending' | 'done' | 'error' }): void {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const next = entries.slice();
  next[index] = { ...entries[index], ...patch } as ConversationEntry;
  commit(next, false);
}

/** Take entries out of the thread, e.g. a typed request when the feature turns out to be switched off. */
export function removeConversationEntries(ids: readonly string[]): void {
  if (!entries.some((entry) => ids.includes(entry.id))) return;
  commit(entries.filter((entry) => !ids.includes(entry.id)), true);
}

export function getConversationEntries(): readonly ConversationEntry[] {
  return entries;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** React binding: the thread, oldest first. */
export function useLucyConversation(): readonly ConversationEntry[] {
  return useSyncExternalStore(subscribe, getConversationEntries, () => EMPTY);
}

/** Forget the thread and what is saved of it (tests only). */
export function __resetLucyConversationForTests(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  entries = EMPTY;
  listeners.clear();
  idSeq = 0;
  try { getStorage()?.removeItem(LUCY_CONVERSATION_KEY); } catch { /* nothing to remove */ }
}

/** Read the saved thread again, as a fresh page load would (tests only). */
export function __reloadLucyConversationForTests(): void {
  if (saveTimer !== null) save();
  entries = loadEntries();
  emit();
}
