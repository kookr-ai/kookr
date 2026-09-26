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
}

export interface TranscriptionCorpus extends CorpusConfig {
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

export type CorpusFileSystem = Partial<Pick<typeof fs, 'mkdir' | 'lstat' | 'statfs' | 'writeFile' | 'rename' | 'rm'>>;

export function getCorpusConfig(env?: NodeJS.ProcessEnv): CorpusConfig;
export function ensureCorpusDirectory(directory: string, options?: { fileSystem?: CorpusFileSystem }): Promise<void>;
export function createTranscriptionCorpus(options?: CorpusOptions): TranscriptionCorpus;
