import { postDictationAnnotation, getDictationCorpusRecord, getDictationCorpusRecordStatus, getDictationCorpusSubmissionTask, type CorpusUnavailableRecording } from '../api/dictation-corpus.js';

export type DictationField = 'prompt' | 'criteria';
export type CorpusStatus = 'pending' | 'saved' | 'failed' | 'omitted';
export interface DictationDelivery {
  deliveryId: string;
  recordingId: string | null;
  ownerToken?: string;
  complete: boolean;
  status: CorpusStatus;
  reason?: string;
}
export interface DictationOwner { draftId: string; field: DictationField; context: string }
export interface DictationLink extends DictationDelivery, DictationOwner {
  id: string;
  beforeText: string;
  deliveredText: string;
  createdAt: number;
  persisted: boolean;
}
interface ArchiveMembership { recordingIds: string[]; unavailableRecordings: CorpusUnavailableRecording[] }
interface SubmissionField {
  field: DictationField;
  submittedText: string;
  recordings: DictationLink[];
  /** Frozen before the first annotation write; later retries never change membership. */
  archiveMembership?: ArchiveMembership;
}
export interface DictationSubmission {
  id: string;
  draftId: string;
  fields: SubmissionField[];
  createdAt: number;
  status: CorpusStatus;
  reason?: string;
  persisted: boolean;
  taskId?: string;
  launchError?: string;
  associationError?: string;
}

const PREFIX = 'kookr:dictationCorpus:v1:';
export const CORPUS_RETRY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CORPUS_DRAFTS = 48;
export const MAX_CORPUS_FIELD_CHARS = 32_000;
export const MAX_CORPUS_RETRY_BYTES = 2 * 1024 * 1024;
const fallback = new Map<string, DictationLink | DictationSubmission | null>();
const listeners = new Set<() => void>();
let version = 0;
const inFlight = new Map<string, Promise<void>>();

function notify(): void { version++; for (const listener of listeners) listener(); }
export function subscribeDictationCorpus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function dictationCorpusVersion(): number { return version; }

function write(kind: 'link' | 'submission', entry: DictationLink | DictationSubmission): void {
  const key = `${PREFIX}${kind}:${entry.id}`;
  const others = [...listDictationLinks(), ...listDictationSubmissions()].filter(item => item.id !== entry.id);
  const bytes = JSON.stringify([...others, entry]).length * 2;
  const overBudget = bytes > MAX_CORPUS_RETRY_BYTES || others.length >= MAX_CORPUS_DRAFTS * 2;
  const saved = overBudget
    ? { ...entry, ...('fields' in entry ? { fields: [] } : { beforeText: '', deliveredText: '' }), status: 'omitted' as const, reason: 'Local retry storage limit reached; this content was not retained.' }
    : entry;
  if (overBudget) {
    // A single overflow marker is enough to report a full queue without growing it.
    for (const [oldKey, value] of fallback) if (value?.reason?.startsWith('Local retry storage limit')) fallback.delete(oldKey);
    fallback.set(key, { ...saved, persisted: false });
  } else {
    try {
      localStorage.setItem(key, JSON.stringify({ ...saved, persisted: true }));
      fallback.delete(key);
    } catch { fallback.set(key, { ...saved, persisted: false }); }
  }
  notify();
}
function remove(key: string): void {
  try { localStorage.removeItem(key); fallback.delete(key); }
  catch { fallback.set(key, null); }
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function isText(value: unknown, limit = MAX_CORPUS_FIELD_CHARS): value is string { return typeof value === 'string' && value.length <= limit; }
function isBase(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isText(value.id, 128) && isText(value.draftId, 200)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt <= Date.now()
    && ['pending', 'saved', 'failed', 'omitted'].includes(String(value.status)) && typeof value.persisted === 'boolean';
}
function isLink(value: unknown): value is DictationLink {
  return isBase(value) && isText(value.deliveryId, 128) && (value.field === 'prompt' || value.field === 'criteria')
    && isText(value.context, 100_000) && isText(value.beforeText) && isText(value.deliveredText)
    && (value.recordingId === null || isText(value.recordingId, 128)) && typeof value.complete === 'boolean'
    && (value.ownerToken === undefined || isText(value.ownerToken, 256));
}
function isArchiveMembership(value: unknown): value is ArchiveMembership {
  if (!isRecord(value) || !Array.isArray(value.recordingIds) || !Array.isArray(value.unavailableRecordings)
    || value.recordingIds.length + value.unavailableRecordings.length > 32) return false;
  const recordingIds = value.recordingIds;
  return recordingIds.every(id => isText(id, 128))
    && new Set(recordingIds).size === recordingIds.length
    && value.unavailableRecordings.every((item, index, entries) => isRecord(item)
      && isText(item.recordingId, 128) && !recordingIds.includes(item.recordingId)
      && typeof item.position === 'number' && Number.isInteger(item.position) && item.position >= 0 && item.position < 32
      && (index === 0 || item.position > entries[index - 1].position)
      && typeof item.reason === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.reason));
}
function isSubmission(value: unknown): value is DictationSubmission {
  return isBase(value) && Array.isArray(value.fields) && value.fields.length <= 2
    && value.fields.every(field => isRecord(field) && (field.field === 'prompt' || field.field === 'criteria')
      && isText(field.submittedText) && Array.isArray(field.recordings) && field.recordings.length <= 32
      && field.recordings.every(link => isLink(link) && link.draftId === value.draftId && link.field === field.field)
      && (field.archiveMembership === undefined || isArchiveMembership(field.archiveMembership)))
    && (value.taskId === undefined || isText(value.taskId, 128)) && (value.launchError === undefined || isText(value.launchError, 1000));
}
function read<T extends DictationLink | DictationSubmission>(kind: 'link' | 'submission'): T[] {
  const prefix = `${PREFIX}${kind}:`;
  const entries = new Map<string, T>();
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix) || fallback.has(key)) continue;
      try {
        const raw = localStorage.getItem(key) ?? 'null';
        if (raw.length > MAX_CORPUS_RETRY_BYTES / 2) continue;
        const value: unknown = JSON.parse(raw);
        if (kind === 'link' ? isLink(value) : isSubmission(value)) entries.set(key, value as T);
      } catch { /* A malformed local retry draft is not sent to the archive. */ }
    }
  } catch { /* Memory fallback keeps this tab usable when storage is unavailable. */ }
  for (const [key, value] of fallback) if (key.startsWith(prefix) && value) entries.set(key, value as T);
  return [...entries].flatMap(([key, value]) => {
    if (Date.now() - value.createdAt >= CORPUS_RETRY_TTL_MS) { remove(key); return []; }
    return [value];
  }).sort((a, b) => a.createdAt - b.createdAt);
}
export function listDictationLinks(): DictationLink[] { return read<DictationLink>('link'); }
export function listDictationSubmissions(): DictationSubmission[] { return read<DictationSubmission>('submission'); }

/** Capture insertion facts once; editing the field never rewrites the prediction. */
export function retainDictation(owner: DictationOwner, beforeText: string, deliveredText: string, delivery: DictationDelivery): void {
  const existing = listDictationLinks();
  if (existing.some(entry => entry.id === delivery.deliveryId)) return;
  const captureUnavailable = delivery.recordingId === null || !delivery.ownerToken || delivery.status === 'omitted';
  const overLimit = existing.length >= MAX_CORPUS_DRAFTS || beforeText.length > MAX_CORPUS_FIELD_CHARS || deliveredText.length > MAX_CORPUS_FIELD_CHARS;
  const omitContent = captureUnavailable || overLimit;
  const entry: DictationLink = {
    ...owner, ...delivery, id: delivery.deliveryId,
    // Collection opt-in applies to browser corpus drafts too. Omitted captures
    // retain only a status marker; ordinary editor/recovery drafts are separate.
    context: captureUnavailable ? '' : owner.context,
    beforeText: omitContent ? '' : beforeText, deliveredText: omitContent ? '' : deliveredText,
    ...(captureUnavailable ? { ownerToken: undefined, status: 'omitted', reason: delivery.reason ?? 'This speech service does not provide corpus annotations.' } : {}),
    createdAt: Date.now(), persisted: true,
    ...(overLimit ? { status: 'omitted', reason: 'Local retry storage limit reached; this dictation was not retained.' } : {}),
  };
  // Keep one bounded status marker when full; never evict another pending correction.
  if (overLimit && existing.length >= MAX_CORPUS_DRAFTS) {
    for (const previous of existing) if (previous.status === 'omitted' && !previous.beforeText && !previous.deliveredText) remove(`${PREFIX}link:${previous.id}`);
  }
  write('link', entry);
}

/** Save before sending Launch. Only fields with dictation contribute corpus data. */
export function submitDictationDraft(draftId: string, fields: Array<{ field: DictationField; text: string }>): string | undefined {
  const links = listDictationLinks();
  const included: SubmissionField[] = fields.flatMap(field => {
    // Completed text belongs to its draft and field. Changing launch settings
    // (for example CWD) does not remove those words from the visible field.
    // Keep the original insertion context as evidence, while partial recovery
    // continues to enforce its separate context-bound restore/cancel rules.
    const recordings = links.filter(link => link.draftId === draftId && link.field === field.field && link.status !== 'omitted' && link.recordingId && link.ownerToken);
    return recordings.length ? [{ field: field.field, submittedText: field.text, recordings }] : [];
  });
  if (!included.length) return undefined;
  // Correlation IDs remain UUIDs on non-secure LAN pages without randomUUID.
  // They are not authentication secrets (capture tokens come from the service).
  const id = globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 3) | 8).toString(16);
  });
  const overLimit = listDictationSubmissions().length >= MAX_CORPUS_DRAFTS || included.some(field => field.submittedText.length > MAX_CORPUS_FIELD_CHARS || field.recordings.length > 32);
  const entry: DictationSubmission = { id, draftId, fields: included, createdAt: Date.now(), status: overLimit ? 'omitted' : 'pending', persisted: true };
  if (overLimit) {
    // Do not silently truncate submitted text or stop task launch for archival limits.
    entry.fields = [];
    entry.reason = 'Local retry storage or field limit reached; submission was not retained.';
    for (const previous of listDictationSubmissions()) if (previous.status === 'omitted' && previous.fields.length === 0) remove(`${PREFIX}submission:${previous.id}`);
  }
  write('submission', entry);
  return id;
}

export function acknowledgeDictationLaunch(submissionId: string, taskId?: string, error?: string): void {
  const entry = listDictationSubmissions().find(item => item.id === submissionId);
  if (!entry || (entry.taskId && entry.taskId !== taskId)) return;
  const receiptFailure = error === 'corpus_task_receipt_pending' || error === 'corpus_receipt_queue_full' || error === 'corpus_task_receipt_limit';
  write('submission', { ...entry, ...(taskId ? { taskId, launchError: undefined, associationError: undefined, status: 'pending' } : receiptFailure ? { associationError: error, launchError: undefined } : { launchError: error }) });
  resumeDictationCorpusRetries();
}
export function dictationLaunchConfirmed(submissionId: string): boolean {
  return Boolean(listDictationSubmissions().find(entry => entry.id === submissionId)?.taskId);
}

function errorReason(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  return `Archive request failed (${status})`;
}
async function retrySubmission(initial: DictationSubmission): Promise<void> {
  const current = () => listDictationSubmissions().find(item => item.id === initial.id);
  let entry = current();
  if (!entry || entry.status === 'omitted') return;
  let pending = false;
  let retained = 0;
  let associated = 0;
  const failures: string[] = [];
  if (!entry.taskId && !entry.launchError) {
    try {
      const receipt = await getDictationCorpusSubmissionTask(entry.id);
      const latest = current();
      if (!latest) return;
      entry = latest;
      if (receipt.ok && receipt.body?.taskId) {
        entry = { ...latest, taskId: latest.taskId ?? receipt.body.taskId };
        write('submission', entry);
      } else if (!receipt.ok) pending = true;
    } catch { pending = true; }
  }
  // One failed audio write or annotation must not suppress a different clip or field.
  for (const originalField of entry.fields) {
    if (!current()) return;
    let field = originalField;
    if (!field.archiveMembership) {
      const membership: ArchiveMembership = { recordingIds: [], unavailableRecordings: [] };
      let fieldPending = false;
      let fieldFailed = false;
      for (const [position, link] of field.recordings.entries()) {
        if (!current()) return;
        if (!link.recordingId || !link.ownerToken) continue;
        try {
          const result = await getDictationCorpusRecordStatus(link.recordingId);
          if (!current()) return;
          const archive = result.ok && result.body && 'archive' in result.body ? result.body.archive : null;
          let unavailable: string | undefined;
          if (result.status === 404 || result.status === 410) unavailable = result.status === 404 ? 'corpus_not_found' : 'corpus_gone';
          else if (!result.ok) {
            const reason = errorReason(result.body, result.status);
            if (reason === 'corpus_pending') fieldPending = true;
            else { failures.push(reason); fieldFailed = true; }
          } else if (archive?.status === 'pending') fieldPending = true;
          else if (archive?.status === 'failed' || archive?.status === 'omitted') unavailable = `corpus_archive_${archive.status}`;
          else if (archive?.status === 'saved') {
            if (result.body && 'audioAvailable' in result.body && result.body.audioAvailable === false) unavailable = 'corpus_audio_unavailable';
            else membership.recordingIds.push(link.recordingId);
          } else { failures.push('Archive status unavailable'); fieldFailed = true; }
          if (unavailable) membership.unavailableRecordings.push({ recordingId: link.recordingId, position, reason: unavailable });
        } catch (error) {
          if (!current()) return;
          fieldFailed = true;
          failures.push(error instanceof Error ? error.message : 'Archive unavailable');
        }
      }
      if (fieldPending || fieldFailed) { pending ||= fieldPending; continue; }
      const latest = current();
      if (!latest) return;
      const latestField = latest.fields.find(item => item.field === field.field);
      if (!latestField) return;
      // Another tab may have frozen the same submission while status requests ran.
      // Keep that persisted body so every operation ID has one immutable payload.
      if (!latestField.archiveMembership) {
        write('submission', { ...latest, fields: latest.fields.map(item => item.field === field.field ? { ...item, archiveMembership: membership } : item) });
      }
      field = current()?.fields.find(item => item.field === field.field) ?? field;
      if (!field.archiveMembership || !current()) return;
    }
    const membership = field.archiveMembership;
    if (membership.unavailableRecordings.length) failures.push(`${membership.unavailableRecordings.length} recording(s) unavailable; retained recordings are saved independently.`);
    for (const link of field.recordings) {
      if (!current()) return;
      if (!link.recordingId || !link.ownerToken || !membership.recordingIds.includes(link.recordingId)) continue;
      const common = { ownerToken: link.ownerToken, draftId: link.draftId, field: link.field, submissionId: entry.id };
      try {
        const result = await postDictationAnnotation(link.recordingId, {
          ...common, operationId: `${entry.id}:${link.recordingId}:submission`, kind: 'submission',
          recordingIds: membership.recordingIds,
          ...(membership.unavailableRecordings.length ? { unavailableRecordings: membership.unavailableRecordings } : {}),
          beforeText: link.beforeText, deliveredText: link.deliveredText, submittedText: field.submittedText,
        });
        if (!current()) return;
        if (!result.ok) {
          const reason = errorReason(result.body, result.status);
          if (reason === 'corpus_pending') pending = true;
          else failures.push(reason);
          continue;
        }
        retained++;
        const taskId = current()?.taskId;
        if (taskId) {
          const result = await postDictationAnnotation(link.recordingId, { ...common, operationId: `${entry.id}:${link.recordingId}:task`, kind: 'task', taskId });
          if (!current()) return;
          if (result.ok) associated++;
          else failures.push(errorReason(result.body, result.status));
        }
      } catch (error) {
        if (!current()) return;
        failures.push(error instanceof Error ? error.message : 'Archive unavailable');
      }
    }
  }
  const latest = current();
  if (!latest) return;
  const needsTaskAssociation = Boolean(latest.taskId && associated < retained);
  write('submission', {
    ...latest, status: failures.length ? 'failed' : pending || needsTaskAssociation ? 'pending' : retained ? 'saved' : 'omitted',
    reason: failures[0] ?? (pending ? 'Audio persistence or task association is still pending.' : undefined),
  });
}
async function retryLink(link: DictationLink): Promise<void> {
  if (!link.recordingId || link.status === 'omitted' || !listDictationLinks().some(item => item.id === link.id)) return;
  try {
    const record = await getDictationCorpusRecord(link.recordingId);
    if (!record.archive) throw new Error('Archive status unavailable');
    if (listDictationLinks().some(item => item.id === link.id)) write('link', { ...link, ...record.archive });
  } catch (error) {
    if (listDictationLinks().some(item => item.id === link.id)) write('link', { ...link, status: 'failed', reason: error instanceof Error ? error.message : 'Archive unavailable' });
  }
}
export async function retryDictationCorpus(id?: string): Promise<void> {
  const entries = [...listDictationLinks().filter(link => link.status !== 'saved'), ...listDictationSubmissions().filter(entry => entry.status !== 'saved' || (!entry.taskId && !entry.launchError))];
  for (const entry of entries) {
    if (id && entry.id !== id) continue;
    const existing = inFlight.get(entry.id);
    if (existing) { await existing; continue; }
    const work = 'fields' in entry ? retrySubmission(entry) : retryLink(entry);
    inFlight.set(entry.id, work);
    await work;
    inFlight.delete(entry.id);
  }
}
/** Discard only the local retry draft. Deleting retained audio is a separate review action. */
export function discardDictationCorpusEntry(id: string): void {
  remove(`${PREFIX}link:${id}`);
  remove(`${PREFIX}submission:${id}`);
  notify();
}
export function discardDictationDraftLinks(draftId: string): void {
  for (const link of listDictationLinks()) if (link.draftId === draftId) remove(`${PREFIX}link:${link.id}`);
  notify();
}

let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryPasses = 0;
/** Resume a bounded background retry cycle; the durable draft outlives its launcher. */
export function resumeDictationCorpusRetries(): void {
  if (retryTimer) return;
  retryPasses = 0;
  const run = async () => {
    await retryDictationCorpus();
    retryPasses++;
    const unfinished = listDictationLinks().some(link => link.status === 'pending') || listDictationSubmissions().some(entry => entry.status === 'pending' || (entry.status === 'saved' && !entry.taskId && !entry.launchError));
    retryTimer = unfinished && retryPasses < 10 ? setTimeout(() => { void run(); }, 3000) : undefined;
  };
  retryTimer = setTimeout(() => { void run(); }, 0);
}

/** Removing retained audio also removes its local retries; other clips keep their own facts. */
export function forgetDictationCorpusRecording(recordingId: string): void {
  for (const link of listDictationLinks()) if (link.recordingId === recordingId) remove(`${PREFIX}link:${link.id}`);
  for (const entry of listDictationSubmissions()) {
    if (entry.fields.some(field => field.recordings.some(link => link.recordingId === recordingId))) {
      // Submitted membership is immutable. Drop this retry instead of resending
      // its operation with a changed recording list after an explicit deletion.
      remove(`${PREFIX}submission:${entry.id}`);
    }
  }
  notify();
}
