/** Text only: recovery never saves microphone audio or enables the opt-in corpus. */
export const DICTATION_RECOVERY_KEY = 'kookr:dictationRecovery:v1';
export const DICTATION_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DICTATION_RECOVERIES = 12;
export const MAX_DICTATION_RECOVERY_CHARS = 100_000;

export interface DictationRecovery {
  id: string;
  owner: string;
  capturedAt: number;
  text: string;
  truncated: boolean;
  /** False means this tab can recover it, but a reload cannot be guaranteed. */
  persisted: boolean;
}

// If storage fails, keep the complete latest snapshot in this tab. In particular,
// a failed deletion must not resurrect an older on-disk draft on the next read.
let fallback: DictationRecovery[] | null = null;
const activeReservations = new Map<string, DictationRecovery>();

function write(entries: DictationRecovery[]): DictationRecovery[] {
  try {
    const persisted = entries.map(entry => ({ ...entry, persisted: true }));
    localStorage.setItem(DICTATION_RECOVERY_KEY, JSON.stringify(persisted.filter(entry => entry.text.trim())));
    fallback = null;
    return persisted;
  } catch {
    fallback = entries.map(entry => ({ ...entry, persisted: false }));
    return fallback;
  }
}

function read(now = Date.now()): DictationRecovery[] {
  let entries: unknown = fallback;
  if (!entries) {
    try { entries = JSON.parse(localStorage.getItem(DICTATION_RECOVERY_KEY) ?? '[]'); }
    catch { entries = []; }
  }
  if (!Array.isArray(entries)) entries = [];
  const storedEntries = entries as unknown[];
  const valid = storedEntries.filter((entry): entry is DictationRecovery => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Partial<DictationRecovery>;
    return typeof value.id === 'string' && typeof value.owner === 'string'
      && typeof value.text === 'string' && value.text.length <= MAX_DICTATION_RECOVERY_CHARS
      && typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt)
      && value.capturedAt <= now && now - value.capturedAt < DICTATION_RECOVERY_TTL_MS
      && typeof value.truncated === 'boolean' && typeof value.persisted === 'boolean'
      && value.text.trim().length > 0;
  }).slice(0, MAX_DICTATION_RECOVERIES);
  const saved = valid.length === storedEntries.length ? valid : write(valid);
  for (const entry of activeReservations.values()) {
    if (!saved.some(item => item.owner === entry.owner) && now - entry.capturedAt < DICTATION_RECOVERY_TTL_MS) saved.push(entry);
  }
  return saved;
}

export function loadDictationRecovery(owner: string): DictationRecovery | null {
  return read().find(entry => entry.owner === owner && entry.text.trim()) ?? null;
}

/** Submission must resolve every recording belonging to a draft, including a previous directory. */
export function hasPendingDictation(ownerPrefix: string): boolean {
  return read().some(entry => entry.owner.startsWith(ownerPrefix));
}

/** Used only by the explicit whole-draft discard action, including hidden contexts. */
export function discardDictationRecoveries(ownerPrefix: string): void {
  const entries = read();
  for (const entry of entries) {
    if (entry.owner.startsWith(ownerPrefix)) activeReservations.delete(entry.id);
  }
  write(entries.filter(entry => !entry.owner.startsWith(ownerPrefix)));
}

/** Input ownership is not an authentication token; also support non-secure LAN pages. */
export function createDictationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Reserve space before capture; never evict or replace unresolved speech. */
export function beginDictationRecovery(owner: string): DictationRecovery | null {
  const entries = read();
  if (entries.some(entry => entry.owner === owner) || entries.length >= MAX_DICTATION_RECOVERIES) return null;
  const draft: DictationRecovery = {
    id: createDictationId(), owner, capturedAt: Date.now(), text: '', truncated: false, persisted: true,
  };
  activeReservations.set(draft.id, draft);
  return draft;
}

export function saveDictationPartial(draft: DictationRecovery, text: string): DictationRecovery | null {
  if (!text.trim()) return loadDictationRecovery(draft.owner);
  const entries = read();
  const index = entries.findIndex(entry => entry.owner === draft.owner && entry.id === draft.id);
  if (index < 0) return null;
  entries[index] = { ...entries[index], text: text.slice(0, MAX_DICTATION_RECOVERY_CHARS), truncated: text.length > MAX_DICTATION_RECOVERY_CHARS };
  return write(entries)[index];
}

/** Identity guards make late completion/discard unable to delete a newer draft. */
export function discardDictationRecovery(owner: string, id: string): void {
  const entries = read();
  activeReservations.delete(id);
  if (entries.some(entry => entry.owner === owner && entry.id === id && entry.text.trim())) {
    write(entries.filter(entry => entry.owner !== owner || entry.id !== id));
  }
}

/** A stopped/unmounted capture releases capacity; saved words remain available. */
export function releaseDictationReservation(id: string): void {
  activeReservations.delete(id);
}
