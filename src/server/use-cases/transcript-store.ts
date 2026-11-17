/**
 * Durable, redacted transcript snapshots (RFC durable-transcript-capture, Phase 2).
 *
 * Layout under `transcriptsDir`:
 *   <taskId>/<sessionId>.jsonl.gz   gzip of newline-delimited TranscriptMessage JSON
 *   <taskId>/<sessionId>.meta.json  sidecar (see {@link SnapshotMeta})
 *
 * Privacy: tool-result bodies are never stored; every stored text/input string
 * is redacted. A snapshot is a full re-capture (never an append), so redacted
 * bytes never need to be compared with raw vendor bytes: completion is tracked
 * by the vendor fingerprint (size/mtime/inode) in the sidecar.
 *
 * Two sources: a vendor JSONL transcript (Claude Code), or, for an opencode task,
 * its per-task opencode sqlite DB (issue #3537). The opencode DB lives in a data
 * dir that a retention sweep deletes about a day after the task ends, so the
 * snapshot is what keeps that task's transcript readable afterwards.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { capMessagesKeepingTail, normalizeVendorLines } from '../../core/transcript-normalizer.js';
import { redactTranscriptLine, redactTranscriptText } from '../../core/redact-transcript-line.js';
import type { TranscriptMessage } from '../../shared/contracts/transcript.js';
import { readOpenCodeDbTranscript } from '../../adapters/opencode-transcript.js';
import { readVendorTranscript } from './transcript-read.js';
import { DEFAULT_TASK_ARCHIVE_RETENTION_DAYS } from './task-archive.js';

/** Aligned with the task archive retention so snapshots outlive neither. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = DEFAULT_TASK_ARCHIVE_RETENTION_DAYS;

/** Max chars of a tool_call input persisted. */
export const STORED_TOOL_INPUT_MAX_CHARS = 2000;
/** Max compressed bytes read back from a stored snapshot. */
/** Budget for stored message JSON; measured after tool-result bodies are omitted. */
const STORED_MAX_BYTES = 2_000_000;
const STORED_READ_MAX_BYTES = 16_000_000;
const STORED_INFLATE_MAX_BYTES = 32_000_000;

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const TOOL_RESULT_PLACEHOLDER = '[tool result omitted]';

export interface VendorFingerprint {
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
}

/** Size and mtime of an sqlite `-wal` file; null when it is absent or empty. */
export interface WalFingerprint {
  sizeBytes: number;
  mtimeMs: number;
}

export interface SnapshotMeta {
  schemaVersion: 1;
  complete: boolean;
  consumedVendorOffsetBytes: number;
  vendor: VendorFingerprint | null;
  /** Only for `source: 'opencode-db'`: the DB's `-wal` file, part of the fingerprint. */
  wal?: WalFingerprint | null;
  capturedAt: string;
  messageCount: number;
  /** `vendor`: a vendor JSONL file. `opencode-db`: an opencode task's sqlite DB. */
  source: 'vendor' | 'opencode-db';
}

export type CaptureOutcome =
  | { outcome: 'vendor_absent' }
  | { outcome: 'already_captured' }
  | { outcome: 'captured'; messageCount: number; bytes: number }
  | { outcome: 'invalid_id' };

export interface CaptureParams {
  transcriptsDir: string;
  taskId: string;
  sessionId: string;
  vendorTranscriptPath: string;
  now?: () => Date;
}

export interface OpenCodeCaptureParams {
  transcriptsDir: string;
  taskId: string;
  /** Kookr session key (the session's `tmuxSession`), the key the transcript route reads. */
  sessionId: string;
  /** The task's `opencode.db`. */
  dbPath: string;
  /** opencode's own session id (`ses_...`, the session's `claudeSessionId`), used to filter the DB. */
  opencodeSessionId?: string;
  now?: () => Date;
  /** Test seam; defaults to {@link readOpenCodeDbTranscript}. */
  readDb?: (dbPath: string, sessionId?: string) => Promise<TranscriptMessage[] | undefined>;
}

function safeIds(taskId: string, sessionId?: string): boolean {
  return SAFE_NAME.test(taskId) && taskId !== '.' && taskId !== '..' &&
    (sessionId === undefined || (SAFE_NAME.test(sessionId) && sessionId !== '.' && sessionId !== '..'));
}

function paths(transcriptsDir: string, taskId: string, sessionId: string) {
  const dir = join(transcriptsDir, taskId);
  return { dir, data: join(dir, `${sessionId}.jsonl.gz`), meta: join(dir, `${sessionId}.meta.json`) };
}

/** Apply the storage privacy rule: drop tool results, redact + truncate the rest. */
export function toStoredMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((m): TranscriptMessage => {
    switch (m.kind) {
      case 'text':
        return { kind: 'text', role: m.role, text: redactTranscriptText(m.text), ...(m.timestamp ? { timestamp: m.timestamp } : {}) };
      case 'tool_call':
        return {
          kind: 'tool_call',
          name: m.name,
          ...(m.input !== undefined
            ? { input: redactTranscriptLine(m.input.slice(0, STORED_TOOL_INPUT_MAX_CHARS)) }
            : {}),
          ...(m.timestamp ? { timestamp: m.timestamp } : {}),
        };
      case 'tool_result':
        return { kind: 'tool_result', ...(m.name ? { name: m.name } : {}), text: TOOL_RESULT_PLACEHOLDER, truncated: true, ...(m.timestamp ? { timestamp: m.timestamp } : {}) };
      case 'truncation_marker':
        return { kind: 'truncation_marker', note: redactTranscriptLine(m.note) };
    }
  });
}

async function writeFileAtomic(path: string, data: Buffer | string): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

function fingerprintEqual(a: VendorFingerprint | null, b: VendorFingerprint): boolean {
  return !!a && a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

function walFingerprintEqual(a: WalFingerprint | null | undefined, b: WalFingerprint | null): boolean {
  if (!a || !b) return !a && !b;
  return a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs;
}

/** Write the gzip data, then the sidecar (data first: a crash between them leaves no `complete` claim). */
async function writeSnapshot(
  transcriptsDir: string,
  taskId: string,
  sessionId: string,
  messages: TranscriptMessage[],
  meta: SnapshotMeta,
): Promise<number> {
  const p = paths(transcriptsDir, taskId, sessionId);
  const gz = gzipSync(Buffer.from(messages.map((m) => JSON.stringify(m)).join('\n'), 'utf8'));
  await mkdir(p.dir, { recursive: true });
  await writeFileAtomic(p.data, gz);
  await writeFileAtomic(p.meta, JSON.stringify(meta));
  return gz.length;
}

/**
 * Snapshot an opencode task's conversation from its per-task sqlite DB (issue #3537),
 * with the same privacy rule as vendor captures. The fingerprint is the DB file's
 * size/mtime/inode plus its `-wal` file's size/mtime: opencode runs the DB in WAL
 * mode, so recent writes may sit in the `-wal` while the main file is unchanged.
 * Writes nothing when the DB is absent or yields no messages, so the route keeps
 * falling back to the live DB and the hook ledger.
 */
export async function captureOpenCodeTaskTranscript(params: OpenCodeCaptureParams): Promise<CaptureOutcome> {
  const { transcriptsDir, taskId, sessionId, dbPath } = params;
  if (!safeIds(taskId, sessionId)) return { outcome: 'invalid_id' };

  let st;
  try {
    st = await stat(dbPath);
  } catch {
    return { outcome: 'vendor_absent' };
  }
  const fingerprint: VendorFingerprint = { sizeBytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino };
  let wal: WalFingerprint | null = null;
  try {
    const w = await stat(`${dbPath}-wal`);
    // An empty -wal is what a clean checkpoint leaves behind: no data beyond the main file.
    if (w.size > 0) wal = { sizeBytes: w.size, mtimeMs: w.mtimeMs };
  } catch {
    // no -wal: the normal state after opencode exits cleanly
  }

  const existing = await readSnapshotMeta(transcriptsDir, taskId, sessionId);
  if (existing?.complete && fingerprintEqual(existing.vendor, fingerprint) && walFingerprintEqual(existing.wal, wal)) {
    return { outcome: 'already_captured' };
  }

  const read = params.readDb ?? readOpenCodeDbTranscript;
  const raw = await read(dbPath, params.opencodeSessionId);
  if (!raw || raw.length === 0) return { outcome: 'vendor_absent' };

  const messages = capMessagesKeepingTail(toStoredMessages(raw), STORED_MAX_BYTES);
  const meta: SnapshotMeta = {
    schemaVersion: 1,
    complete: true,
    consumedVendorOffsetBytes: st.size,
    vendor: fingerprint,
    wal,
    capturedAt: (params.now?.() ?? new Date()).toISOString(),
    messageCount: messages.length,
    source: 'opencode-db',
  };
  const bytes = await writeSnapshot(transcriptsDir, taskId, sessionId, messages, meta);
  return { outcome: 'captured', messageCount: messages.length, bytes };
}

export async function captureTaskTranscript(params: CaptureParams): Promise<CaptureOutcome> {
  const { transcriptsDir, taskId, sessionId, vendorTranscriptPath } = params;
  if (!safeIds(taskId, sessionId)) return { outcome: 'invalid_id' };

  let st;
  try {
    st = await stat(vendorTranscriptPath);
  } catch {
    return { outcome: 'vendor_absent' };
  }
  const fingerprint: VendorFingerprint = { sizeBytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino };

  const existing = await readSnapshotMeta(transcriptsDir, taskId, sessionId);
  if (existing?.complete && fingerprintEqual(existing.vendor, fingerprint)) {
    return { outcome: 'already_captured' };
  }

  const lines = await readVendorTranscript(vendorTranscriptPath);
  if (lines === undefined) return { outcome: 'vendor_absent' };

  const messages = capMessagesKeepingTail(toStoredMessages(normalizeVendorLines(lines)), STORED_MAX_BYTES);
  const meta: SnapshotMeta = {
    schemaVersion: 1,
    complete: true,
    consumedVendorOffsetBytes: st.size,
    vendor: fingerprint,
    capturedAt: (params.now?.() ?? new Date()).toISOString(),
    messageCount: messages.length,
    source: 'vendor',
  };
  const bytes = await writeSnapshot(transcriptsDir, taskId, sessionId, messages, meta);
  return { outcome: 'captured', messageCount: messages.length, bytes };
}

export async function readStoredTranscript(
  transcriptsDir: string,
  taskId: string,
  sessionId: string,
): Promise<TranscriptMessage[] | undefined> {
  if (!safeIds(taskId, sessionId)) return undefined;
  try {
    const { data } = paths(transcriptsDir, taskId, sessionId);
    const st = await stat(data);
    if (st.size > STORED_READ_MAX_BYTES) return undefined;
    const raw = gunzipSync(await readFile(data), { maxOutputLength: STORED_INFLATE_MAX_BYTES }).toString('utf8');
    const out: TranscriptMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      out.push(JSON.parse(line) as TranscriptMessage);
    }
    return out;
  } catch {
    return undefined;
  }
}

export async function readSnapshotMeta(
  transcriptsDir: string,
  taskId: string,
  sessionId: string,
): Promise<SnapshotMeta | undefined> {
  if (!safeIds(taskId, sessionId)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(paths(transcriptsDir, taskId, sessionId).meta, 'utf8')) as SnapshotMeta;
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function hasCompleteSnapshot(
  transcriptsDir: string,
  taskId: string,
  sessionId: string,
): Promise<boolean> {
  return (await readSnapshotMeta(transcriptsDir, taskId, sessionId))?.complete === true;
}

export async function deleteTaskTranscripts(transcriptsDir: string, taskId: string): Promise<void> {
  if (!safeIds(taskId)) return;
  await rm(join(transcriptsDir, taskId), { recursive: true, force: true }).catch(() => undefined);
}

/**
 * TaskIds whose newest snapshot is older than `retentionDays`. Age uses the
 * latest sidecar `capturedAt` in the directory, falling back to dir mtime.
 */
export async function selectExpiredTranscriptTaskDirs(
  transcriptsDir: string,
  retentionDays: number,
  now: Date,
): Promise<string[]> {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const expired: string[] = [];
  try {
    for (const taskId of await readdir(transcriptsDir)) {
      if (!safeIds(taskId)) continue;
      try {
        const dir = join(transcriptsDir, taskId);
        let newest = -Infinity;
        for (const f of await readdir(dir)) {
          if (!f.endsWith('.meta.json')) continue;
          const meta = await readSnapshotMeta(transcriptsDir, taskId, f.slice(0, -'.meta.json'.length));
          const t = meta ? Date.parse(meta.capturedAt) : NaN;
          if (Number.isFinite(t) && t > newest) newest = t;
        }
        if (!Number.isFinite(newest)) newest = (await stat(dir)).mtimeMs;
        if (newest < cutoff) expired.push(taskId);
      } catch {
        // skip unreadable entry
      }
    }
  } catch {
    return [];
  }
  return expired.sort();
}
