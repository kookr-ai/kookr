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
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { capMessagesKeepingTail, normalizeVendorLines } from '../../core/transcript-normalizer.js';
import { redactTranscriptLine, redactTranscriptText } from '../../core/redact-transcript-line.js';
import type { TranscriptMessage } from '../../shared/contracts/transcript.js';
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

export interface SnapshotMeta {
  schemaVersion: 1;
  complete: boolean;
  consumedVendorOffsetBytes: number;
  vendor: VendorFingerprint | null;
  capturedAt: string;
  messageCount: number;
  source: 'vendor';
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
        return { kind: 'text', role: m.role, text: redactTranscriptText(m.text) };
      case 'tool_call':
        return {
          kind: 'tool_call',
          name: m.name,
          ...(m.input !== undefined
            ? { input: redactTranscriptLine(m.input.slice(0, STORED_TOOL_INPUT_MAX_CHARS)) }
            : {}),
        };
      case 'tool_result':
        return { kind: 'tool_result', ...(m.name ? { name: m.name } : {}), text: TOOL_RESULT_PLACEHOLDER, truncated: true };
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

  const p = paths(transcriptsDir, taskId, sessionId);
  const existing = await readSnapshotMeta(transcriptsDir, taskId, sessionId);
  if (existing?.complete && fingerprintEqual(existing.vendor, fingerprint)) {
    return { outcome: 'already_captured' };
  }

  const lines = await readVendorTranscript(vendorTranscriptPath);
  if (lines === undefined) return { outcome: 'vendor_absent' };

  const messages = capMessagesKeepingTail(toStoredMessages(normalizeVendorLines(lines)), STORED_MAX_BYTES);
  const gz = gzipSync(Buffer.from(messages.map((m) => JSON.stringify(m)).join('\n'), 'utf8'));
  const meta: SnapshotMeta = {
    schemaVersion: 1,
    complete: true,
    consumedVendorOffsetBytes: st.size,
    vendor: fingerprint,
    capturedAt: (params.now?.() ?? new Date()).toISOString(),
    messageCount: messages.length,
    source: 'vendor',
  };

  await mkdir(p.dir, { recursive: true });
  // Data first, sidecar last: a crash between them leaves no `complete` claim
  // for the new data, so the next sweep simply re-captures.
  await writeFileAtomic(p.data, gz);
  await writeFileAtomic(p.meta, JSON.stringify(meta));
  return { outcome: 'captured', messageCount: messages.length, bytes: gz.length };
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
