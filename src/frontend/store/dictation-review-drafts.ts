import type { CorpusReviewStatus } from '../api/dictation-corpus.js';

export const REVIEW_DRAFT_PREFIX = 'kookr:dictationReviewRetry:v1:';
export const MAX_REVIEW_DRAFTS = 12;
export const MAX_REVIEW_CORRECTION_CHARS = 32_000;
export const REVIEW_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DictationReviewRequest {
  operationId: string;
  kind: 'review';
  expectedRevision: number;
  correction: string;
  status: CorpusReviewStatus;
  listened: boolean;
}
export interface DictationReviewDraft {
  recordingId: string;
  tabId: string;
  audioSha256: string | null;
  correction: string;
  status: CorpusReviewStatus;
  expectedRevision: number;
  played: boolean;
  confirmed: boolean;
  request: DictationReviewRequest | null;
  updatedAt: number;
  persisted: boolean;
}
type DraftInput = Omit<DictationReviewDraft, 'updatedAt' | 'persisted'>;
const fallback = new Map<string, DictationReviewDraft | null>();
const keyFor = (recordingId: string, tabId: string) => `${REVIEW_DRAFT_PREFIX}${encodeURIComponent(recordingId)}:${encodeURIComponent(tabId)}`;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const status = (value: unknown): value is CorpusReviewStatus => ['candidate', 'faithful', 'reformulation', 'excluded'].includes(String(value));
function validDraft(value: unknown): value is DictationReviewDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as DictationReviewDraft;
  const valid = identifier(d.recordingId) && identifier(d.tabId)
    && (d.audioSha256 === null || /^[a-f0-9]{64}$/.test(d.audioSha256))
    && typeof d.correction === 'string' && d.correction.length <= MAX_REVIEW_CORRECTION_CHARS
    && status(d.status) && Number.isSafeInteger(d.expectedRevision) && d.expectedRevision >= 0
    && typeof d.played === 'boolean' && typeof d.confirmed === 'boolean'
    && Number.isFinite(d.updatedAt) && d.updatedAt <= Date.now()
    && typeof d.persisted === 'boolean';
  if (!valid) return false;
  if (d.request === null) return true;
  const r = d.request;
  return !!r && typeof r === 'object' && identifier(r.operationId) && r.operationId.length <= 128
    && r.kind === 'review' && r.expectedRevision === d.expectedRevision
    && r.correction === d.correction && r.status === d.status && typeof r.listened === 'boolean'
    && (!r.listened || (d.played && d.confirmed && d.audioSha256 !== null));
}
function remove(key: string): void {
  try { localStorage.removeItem(key); fallback.delete(key); }
  catch { fallback.set(key, null); }
}
function read(): Map<string, DictationReviewDraft> {
  const entries = new Map<string, DictationReviewDraft>();
  try {
    // Snapshot keys before pruning: removing one must not skip the next entry.
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) {
      if (!key?.startsWith(REVIEW_DRAFT_PREFIX) || fallback.has(key)) continue;
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (validDraft(value) && key === keyFor(value.recordingId, value.tabId)) entries.set(key, value);
        else remove(key);
      } catch { remove(key); }
    }
  } catch { /* The same tab can still reopen an in-memory retry. */ }
  for (const [key, value] of fallback) if (value) entries.set(key, value);
  for (const [key, value] of entries) {
    if (Date.now() - value.updatedAt >= REVIEW_DRAFT_TTL_MS) { remove(key); entries.delete(key); }
  }
  return entries;
}

export function loadDictationReviewDraft(recordingId: string, tabId: string): DictationReviewDraft | null {
  return read().get(keyFor(recordingId, tabId)) ?? null;
}

/** Persist a Save attempt before HTTP; typing alone does not start a retry draft. */
export function retainDictationReviewDraft(input: DraftInput): { persisted: boolean; reason?: 'full' | 'storage' } {
  const key = keyFor(input.recordingId, input.tabId);
  const draft = { ...input, updatedAt: Date.now(), persisted: true };
  const entries = read();
  if (!validDraft(draft) || (!entries.has(key) && entries.size >= MAX_REVIEW_DRAFTS)) {
    return { persisted: false, reason: 'full' };
  }
  try { localStorage.setItem(key, JSON.stringify(draft)); fallback.delete(key); return { persisted: true }; }
  catch { fallback.set(key, { ...draft, persisted: false }); return { persisted: false, reason: 'storage' }; }
}

/** A late response must not erase a newer retry edited after the panel reopened. */
export function discardDictationReviewDraft(recordingId: string, tabId: string, expectedOperationId?: string): boolean {
  const key = keyFor(recordingId, tabId);
  if (expectedOperationId && read().get(key)?.request?.operationId !== expectedOperationId) return false;
  remove(key);
  return true;
}

/** Explicit example deletion removes every tab's review retry for that audio. */
export function forgetDictationReviewDrafts(recordingId: string): void {
  for (const [key, draft] of read()) if (draft.recordingId === recordingId) remove(key);
}
