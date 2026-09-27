import { fetchResult, getJson, type ApiResult } from './client.js';

export type CorpusReviewStatus = 'candidate' | 'faithful' | 'reformulation' | 'excluded';
export interface CorpusCapabilities {
  schemaVersion: 1;
  supported: boolean;
  enabled: boolean;
  reason?: string;
}
interface AnnotationBase { operationId: string; revision: number; createdAt: string }
export interface CorpusReview extends AnnotationBase {
  kind: 'review';
  reviewRevision: number;
  correction: string;
  status: CorpusReviewStatus;
  listened: boolean;
}
export interface CorpusSubmission extends AnnotationBase {
  kind: 'submission';
  draftId: string;
  field: 'prompt' | 'criteria';
  submissionId: string;
  recordingIds: string[];
  beforeText: string;
  deliveredText: string;
  submittedText: string;
}
export interface CorpusTask extends AnnotationBase {
  kind: 'task';
  submissionId: string;
  taskId: string;
}
export type CorpusAnnotation = CorpusSubmission | CorpusTask | CorpusReview;
export interface CorpusRecord {
  schemaVersion: 1;
  id: string;
  recordedAt: string;
  metadata: {
    source: string;
    transcript: string | null;
    status: string;
    model: Record<string, unknown>;
    language: string;
    durationSeconds?: number | null;
    [key: string]: unknown;
  };
  audio: { filename: string; bytes: number; sha256: string } | null;
  reference: null;
  owner: { draftId: string; field: 'prompt' | 'criteria' } | null;
  archive: { status: 'pending' | 'saved' | 'failed' | 'omitted'; complete: boolean; reason?: string };
  audioAvailable: boolean;
  reviewRevision: number;
  annotations: CorpusAnnotation[];
}
export interface CorpusManifest {
  schemaVersion: 1;
  exportedAt: string;
  verifiedPairs: unknown[];
  candidates: unknown[];
}
export interface CorpusAnnotationResult {
  schemaVersion: 1;
  annotation: CorpusAnnotation;
  duplicate: boolean;
}
const BASE = '/api/stt/corpus';
const recordPath = (id: string) => `${BASE}/records/${encodeURIComponent(id)}`;

export function getDictationCorpusCapabilities(): Promise<CorpusCapabilities> {
  return getJson(`${BASE}/capabilities`);
}
export function getDictationCorpusRecords(offset = 0, limit = 20): Promise<{
  schemaVersion: 1; records: CorpusRecord[]; truncated: boolean;
}> {
  return getJson(`${BASE}/records?offset=${offset}&limit=${limit}`);
}
export function getDictationCorpusRecord(id: string): Promise<CorpusRecord> {
  return getJson(recordPath(id));
}
export function dictationCorpusAudioUrl(id: string): string {
  return `${recordPath(id)}/audio`;
}
export function postDictationAnnotation(
  id: string,
  annotation: object,
): Promise<ApiResult<CorpusAnnotationResult | { error: string } | null>> {
  return fetchResult(`${recordPath(id)}/annotations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotation),
  });
}
export function deleteDictationCorpusRecord(id: string): Promise<{ deleted: true }> {
  return getJson(recordPath(id), { method: 'DELETE' });
}
export function getDictationCorpusManifest(): Promise<CorpusManifest> {
  return getJson(`${BASE}/export`);
}
