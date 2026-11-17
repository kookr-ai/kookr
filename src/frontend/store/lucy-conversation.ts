/**
 * The conversation thread in Lucy's column: everything said between the operator and her, in the order
 * it happened, in one list.
 *
 * An entry is one of:
 *  - something the operator typed, and Lucy's reply to it (`typed-you`, `typed-lucy`). While a reply is
 *    being prepared its entry also says what she is doing (`doing`) and how many things she looked at;
 *  - the operator's words and Lucy's words in a hands-free Talk exchange (`talk-you`, `talk-lucy`);
 *  - a message Lucy wrote on her own (`lucy`): a briefing, or the report of a task she started. It may
 *    carry the task it is about (an "Open task" button) and the spoken clip of the same sentence;
 *  - what became of a launch she proposed (`launch-outcome`): started, cancelled, timed out;
 *  - a notice about the connection (`notice`);
 *  - a message Lucy said aloud on her own: a task summary, a question, a permission notice (`clip`).
 *
 * Any of Lucy's own entries may carry `chips`: short sentences shown as buttons under it, which send
 * that sentence as a typed request.
 *
 * The list is bounded (the last {@link MAX_CONVERSATION_ENTRIES} entries) and kept in `localStorage`, so a
 * new tab or a browser restart shows the same conversation. Only text is stored, never audio: a spoken
 * message that has lost its audio stays in the thread as text.
 *
 * Several tabs share the one saved thread. A tab that hears (through the `storage` event) that another
 * tab saved takes the saved list, and keeps what only it knows: entries it added that the other tab's
 * save did not include yet, its own newer version of an entry (each change bumps the entry's `rev`; the
 * higher one wins), and the reply it is still receiving, whatever the other tab's copy of it says. Messages every tab receives (a launch outcome, a report) are
 * added with an id made from their subject, so two tabs add one entry, not two.
 *
 * What is NOT kept across a reload: a draft of the operator's speech that never became final, and an
 * answer that was still arriving (it is closed with a note that it was cut off), because nothing is
 * left to finish them. An answer another tab is still receiving is left alone: that tab finishes it.
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
/** The most suggestion buttons one entry shows, and the longest one. */
export const MAX_ENTRY_CHIPS = 6;
export const MAX_CHIP_CHARS = 80;

interface EntryBase {
  id: string;
  /** When it was added (epoch milliseconds). */
  at: number;
  /** How many times it was changed since it was added; decides which tab's version of an entry is newer. */
  rev?: number;
}

/** What any of Lucy's own entries may carry. */
interface LucyExtras {
  /** Short sentences offered as buttons under the entry; pressing one sends it as a typed request. */
  chips?: string[];
  /** The task the entry is about: it gets an "Open task" button. */
  taskId?: string;
  /** Set on a briefing: its signature, which changes only when what waits on the operator changes. */
  briefing?: string;
}

/** The spoken clip of an entry: who it was about and whether it is template wording. */
interface ClipFields {
  clipId: string;
  subject?: string;
  usedFallback?: boolean;
}

export type ConversationEntry =
  | (EntryBase & { kind: 'typed-you'; text: string })
  /**
   * `pending` until the reply has ended, `error` when `text` is the reason it failed. `doing` is what she
   * is looking up right now, in plain words; `looked` is how many look-ups have succeeded so far.
   */
  | (EntryBase & LucyExtras & { kind: 'typed-lucy'; text: string; status: 'pending' | 'done' | 'error'; doing?: string; looked?: number })
  | (EntryBase & { kind: 'talk-you'; text: string; final: boolean })
  | (EntryBase & LucyExtras & { kind: 'talk-lucy'; text: string })
  | (EntryBase & LucyExtras & Partial<ClipFields> & { kind: 'lucy'; text: string })
  /** `started` is true when a task was launched; `taskId` is that task. */
  | (EntryBase & { kind: 'launch-outcome'; text: string; started: boolean; taskId?: string })
  | (EntryBase & { kind: 'notice'; text: string })
  | (EntryBase & ClipFields & { kind: 'clip'; text: string });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller gives to {@link appendConversationEntry}: an entry without the fields the store fills in. */
export type NewConversationEntry = DistributiveOmit<ConversationEntry, 'id' | 'at' | 'rev'> & {
  at?: number;
  /** Given only for something every open tab is told about (a line from the server, a briefing), so the tabs agree on the id and the entry is added once. */
  id?: string;
};

/** The fields {@link updateConversationEntry} can change. */
export interface ConversationEntryPatch {
  text?: string;
  final?: boolean;
  status?: 'pending' | 'done' | 'error';
  /** `null` takes the field away. */
  doing?: string | null;
  looked?: number;
  chips?: string[];
  clipId?: string;
  subject?: string;
  usedFallback?: boolean;
}

const EMPTY: readonly ConversationEntry[] = Object.freeze([]);
/** How long a burst of streamed text waits before it is written to storage. */
const SAVE_DELAY_MS = 300;
/** How many ids of removed entries are remembered, so another tab's older save cannot bring them back. */
const MAX_REMEMBERED_REMOVALS = 400;

/** Ids of the entries this tab added, since the page loaded. */
const addedHere = new Set<string>();
/** Ids of the entries this tab took out, since the page loaded. */
const removedHere = new Set<string>();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let idSeq = 0;

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function optional(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  return value === undefined || typeof value === type;
}

function validChips(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((chip) => typeof chip === 'string'));
}

function isEntry(value: unknown): value is ConversationEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || typeof entry.at !== 'number' || typeof entry.text !== 'string') return false;
  if (!optional(entry.rev, 'number')) return false;
  const lucyExtras = validChips(entry.chips) && optional(entry.taskId, 'string') && optional(entry.briefing, 'string');
  switch (entry.kind) {
    case 'typed-you':
    case 'notice':
      return true;
    case 'talk-lucy':
      return lucyExtras;
    case 'typed-lucy':
      return lucyExtras && (entry.status === 'pending' || entry.status === 'done' || entry.status === 'error')
        && optional(entry.doing, 'string') && optional(entry.looked, 'number');
    case 'lucy':
      return lucyExtras && optional(entry.clipId, 'string') && optional(entry.subject, 'string') && optional(entry.usedFallback, 'boolean');
    case 'launch-outcome':
      return typeof entry.started === 'boolean' && optional(entry.taskId, 'string');
    case 'talk-you':
      return typeof entry.final === 'boolean';
    case 'clip':
      return typeof entry.clipId === 'string';
    default:
      return false;
  }
}

/** The entries in a saved value, without the ones that are not entries. Never throws. */
function parseSaved(raw: string | null): ConversationEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A draft that never became final is never stored; one found anyway has nothing left to finish it.
    return parsed.filter(isEntry).filter((item) => !(item.kind === 'talk-you' && !item.final));
  } catch {
    return [];
  }
}

function freezeList(list: readonly ConversationEntry[]): readonly ConversationEntry[] {
  return list.length === 0 ? EMPTY : Object.freeze(list.slice(-MAX_CONVERSATION_ENTRIES));
}

/** The saved thread, repaired for what a reload cuts short. Never throws. */
function loadEntries(): readonly ConversationEntry[] {
  const storage = getStorage();
  if (!storage) return EMPTY;
  let raw: string | null = null;
  try { raw = storage.getItem(LUCY_CONVERSATION_KEY); } catch { return EMPTY; }
  return freezeList(parseSaved(raw).map((item) => (
    item.kind === 'typed-lucy' && item.status === 'pending'
      ? { ...item, status: 'error' as const, text: CUT_OFF_BY_RELOAD_TEXT, doing: undefined }
      : item
  )));
}

// Read once when the page loads. Kept below everything the reading uses: a helper not yet defined when this
// line runs would throw inside the fail-soft parsing above and silently give an empty thread.
let entries: readonly ConversationEntry[] = loadEntries();

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
    if (stored.length === 0) {
      storage.removeItem(LUCY_CONVERSATION_KEY);
      return;
    }
    const json = JSON.stringify(stored);
    // Writing what is already there would only wake the other tabs for nothing.
    if (storage.getItem(LUCY_CONVERSATION_KEY) !== json) storage.setItem(LUCY_CONVERSATION_KEY, json);
  } catch {
    // Storage full or refused: the thread still works for this page.
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function saveSoon(): void {
  if (saveTimer === null) saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function commit(next: readonly ConversationEntry[], saveNow: boolean): void {
  entries = freezeList(next);
  if (saveNow) save();
  else saveSoon();
  emit();
}

/**
 * Another tab saved the thread: take its list, and keep what only this tab knows (see the header).
 * Writes back, a moment later, only when this tab holds something the saved list lacks.
 */
function mergeSaved(raw: string | null): void {
  const saved = parseSaved(raw);
  const savedIds = new Set(saved.map((entry) => entry.id));
  const mine = new Map(entries.map((entry) => [entry.id, entry]));
  let ahead = false;
  const next: ConversationEntry[] = [];
  for (const item of saved) {
    if (removedHere.has(item.id)) {
      ahead = true;
      continue;
    }
    const own = mine.get(item.id);
    // A reply this tab is still receiving is this tab's to finish, whatever the other copy says: a tab opened
    // meanwhile has closed its own copy as "cut off", at the same revision, and may save it.
    const receiving = own !== undefined && own.kind === 'typed-lucy' && own.status === 'pending' && addedHere.has(own.id);
    if (own && (receiving || (own.rev ?? 0) > (item.rev ?? 0))) {
      next.push(own);
      ahead = true;
    } else {
      next.push(item);
    }
  }
  // A full saved list has dropped its oldest entries: one of ours older than its first entry fell off, it was not missed.
  const droppedBefore = saved.length >= MAX_CONVERSATION_ENTRIES ? saved[0].at : -Infinity;
  for (const entry of entries) {
    if (savedIds.has(entry.id) || !addedHere.has(entry.id) || entry.at < droppedBefore) continue;
    next.push(entry);
    // A draft is never saved, so holding one is not a reason to write.
    if (!(entry.kind === 'talk-you' && !entry.final)) ahead = true;
  }
  entries = freezeList(next);
  if (ahead) saveSoon();
  emit();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Text still arriving when the page goes away is written out at once.
  window.addEventListener('pagehide', () => { if (saveTimer !== null) save(); });
  // Another tab saved the thread (or cleared the storage: then `key` is null).
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === LUCY_CONVERSATION_KEY) {
      mergeSaved(event.newValue);
    } else if (event.key === null) {
      let raw: string | null = null;
      try { raw = getStorage()?.getItem(LUCY_CONVERSATION_KEY) ?? null; } catch { /* unreadable: as if nothing is saved */ }
      mergeSaved(raw);
    }
  });
}

function newId(): string {
  idSeq += 1;
  return `${Date.now().toString(36)}-${idSeq}-${Math.random().toString(36).slice(2, 7)}`;
}

function cleanChips(chips: readonly string[]): string[] {
  return chips.map((chip) => chip.trim().slice(0, MAX_CHIP_CHARS)).filter(Boolean).slice(0, MAX_ENTRY_CHIPS);
}

/**
 * Add an entry at the bottom of the thread and return its id. With `options.id` the entry is added only
 * if no entry has that id yet: for a message every open tab receives, so the shared thread gets it once.
 */
export function appendConversationEntry(entry: NewConversationEntry, options: { id?: string } = {}): string {
  const givenId = options.id ?? entry.id;
  if (givenId !== undefined && entries.some((existing) => existing.id === givenId)) return givenId;
  const id = givenId ?? newId();
  const added = { ...entry, id, at: entry.at ?? Date.now() } as ConversationEntry;
  if ('chips' in added && added.chips) added.chips = cleanChips(added.chips);
  addedHere.add(id);
  removedHere.delete(id);
  commit([...entries, added], true);
  return id;
}

/**
 * Change an entry (more streamed text, a draft that became final). The write to storage is delayed a
 * moment, so a long answer arriving word by word is not written word by word. An unknown id is ignored.
 */
export function updateConversationEntry(id: string, patch: ConversationEntryPatch): void {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return;
  const current = entries[index];
  const changed: Record<string, unknown> = { ...current, ...patch, rev: (current.rev ?? 0) + 1 };
  if (patch.doing === null) delete changed.doing;
  if (patch.chips) changed.chips = cleanChips(patch.chips);
  const next = entries.slice();
  next[index] = changed as unknown as ConversationEntry;
  commit(next, false);
}

/** Take entries out of the thread, e.g. a typed request when the feature turns out to be switched off. */
export function removeConversationEntries(ids: readonly string[]): void {
  if (!entries.some((entry) => ids.includes(entry.id))) return;
  if (removedHere.size > MAX_REMEMBERED_REMOVALS) removedHere.clear();
  for (const id of ids) {
    removedHere.add(id);
    addedHere.delete(id);
  }
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
  addedHere.clear();
  removedHere.clear();
  idSeq = 0;
  try { getStorage()?.removeItem(LUCY_CONVERSATION_KEY); } catch { /* nothing to remove */ }
}

/** Read the saved thread again, as a fresh page load would (tests only). */
export function __reloadLucyConversationForTests(): void {
  if (saveTimer !== null) save();
  addedHere.clear();
  removedHere.clear();
  entries = loadEntries();
  emit();
}
