import type * as fs from 'node:fs/promises';

export interface CorpusConfig {
  enabled: boolean;
  directory: string;
  configId: string;
}

export interface CorpusMetadata {
  source: 'browser' | 'telegram';
  transcript: string | null;
  status: 'success' | 'error';
  model: Record<string, unknown>;
  language: string;
  startedAt: string;
  durationSeconds: number | null;
  elapsedMs: number;
  [key: string]: unknown;
}

export interface CorpusRecord {
  audio: Buffer;
  format: 'wav' | 'ogg' | 'mp3' | 'mp4' | 'm4a' | 'webm' | 'flac' | 'aac' | 'bin';
  metadata: CorpusMetadata;
  /** A reservation made by this writer before final transcription delivery. */
  id?: string;
  complete?: boolean;
}

export interface CorpusOwner {
  draftId: string;
  field: 'prompt' | 'criteria';
}

export interface CorpusIdentity {
  recordingId: string;
  ownerToken: string;
}

export interface CorpusView {
  schemaVersion: 1;
  id: string;
  recordedAt: string;
  metadata: CorpusMetadata | null;
  audio: { filename: string; bytes: number; sha256: string } | null;
  reference: null;
  owner: CorpusOwner | null;
  archive: { status: 'pending' | 'saved' | 'failed' | 'omitted'; complete: boolean; reason?: string };
  audioAvailable: boolean;
  annotations: Record<string, unknown>[];
  reviewRevision: number;
}

export interface CorpusApi {
  get(id: string): Promise<CorpusView>;
  list(options?: { offset?: number; limit?: number }): Promise<{ schemaVersion: 1; records: CorpusView[]; truncated: boolean }>;
  annotate(id: string, body: Record<string, unknown>): Promise<{ schemaVersion: 1; annotation: Record<string, unknown>; duplicate: boolean }>;
  remove(id: string): Promise<{ deleted: true }>;
  audio(id: string): Promise<{ bytes: Buffer; contentType: string }>;
  exportManifest(): Promise<{ schemaVersion: 1; exportedAt: string; verifiedPairs: Record<string, unknown>[]; candidates: CorpusView[] }>;
  handleHttp(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<boolean>;
}

export interface TranscriptionCorpus extends CorpusConfig {
  reserve(owner?: CorpusOwner | null): CorpusIdentity | null;
  api: CorpusApi;
  /** Return the saved record.json path, or null when capture is disabled or unsuccessful. */
  write(record: CorpusRecord): Promise<string | null>;
  /** Wait for all writes submitted before this call. */
  flush(): Promise<void>;
  stats(): { written: number; skipped: number; failed: number };
}

export interface CorpusOptions {
  env?: NodeJS.ProcessEnv;
  logger?: { warn(message: string): void };
  /** Filesystem boundary for deterministic disk and failure tests. */
  fileSystem?: CorpusFileSystem;
}

export type CorpusFileSystem = Partial<Pick<typeof fs, 'mkdir' | 'lstat' | 'statfs' | 'writeFile' | 'rename' | 'rm' | 'open' | 'readdir'>>;

export function getCorpusConfig(env?: NodeJS.ProcessEnv): CorpusConfig;
export function ensureCorpusDirectory(directory: string, options?: { fileSystem?: CorpusFileSystem }): Promise<void>;
export function createTranscriptionCorpus(options?: CorpusOptions): TranscriptionCorpus;
