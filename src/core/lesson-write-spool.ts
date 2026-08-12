/**
 * Durable write-behind spool for agent-task-lessons when the KB write path
 * is degraded (issue #1519).
 *
 * Agents run `kb remember` (or `kookr lesson remember`). When the real write
 * fails for a runtime/provider reason, the lesson is appended to a JSONL
 * spool under `~/.kookr/playbook-state/lesson-write-spool/` so it survives
 * process restarts. A recovery drain replays pending entries idempotently
 * (dedupe by content hash) once KB is healthy again.
 *
 * Healthy-path behaviour is a pure pass-through: no spool I/O on success.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from './persistence-utils.js';

export const LESSON_WRITE_SPOOL_SCHEMA = 'lesson-write-spool.v1' as const;
export const DEFAULT_LESSON_KB = 'agent-task-lessons';
export const SPOOL_DIR_REL = join('playbook-state', 'lesson-write-spool');
export const PENDING_FILE = 'pending.jsonl';
export const STATE_FILE = 'state.json';

export interface LessonWriteEntry {
  schemaVersion: typeof LESSON_WRITE_SPOOL_SCHEMA;
  contentHash: string;
  kb: string;
  title: string;
  body: string;
  createdAt: string;
  taskId?: string;
  source: 'kb-remember' | 'kookr-lesson';
  lastError?: string;
}

export interface LessonSpoolState {
  schemaVersion: 'lesson-write-spool-state.v1';
  /** ISO timestamp when the KB dependency first became degraded in this streak. */
  kbDegradedSince: string | null;
  /** ISO timestamp when a prolonged-degradation alert was last fired for this streak. */
  alertFiredAt: string | null;
  lastProbeAt: string | null;
  lastProbeStatus: 'healthy' | 'degraded' | null;
  /** Pending entries observed at last drain attempt (for status). */
  lastPendingCount?: number;
}

export interface AppendLessonResult {
  appended: boolean;
  reason: 'appended' | 'duplicate';
  contentHash: string;
  path: string;
}

export interface DrainLessonResult {
  attempted: number;
  written: number;
  failed: number;
  skippedDuplicate: number;
  remaining: number;
  writtenHashes: string[];
  failedHashes: string[];
}

export type LessonWriteFn = (entry: Pick<LessonWriteEntry, 'kb' | 'title' | 'body'>) => Promise<{
  ok: boolean;
  error?: string;
}>;

/** Canonical content hash — stable across restarts and re-drains. */
export function contentHashFor(kb: string, title: string, body: string): string {
  const canonical = `${kb.trim()}\n${title.trim()}\n${normalizeBody(body)}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function normalizeBody(body: string): string {
  // Normalize trailing whitespace / final newline so re-pipes don't re-hash.
  return body.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n';
}

export function defaultSpoolDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return join(home, '.kookr', SPOOL_DIR_REL);
}

export function pendingPath(spoolDir: string): string {
  return join(spoolDir, PENDING_FILE);
}

export function statePath(spoolDir: string): string {
  return join(spoolDir, STATE_FILE);
}

export function buildLessonEntry(input: {
  kb?: string;
  title: string;
  body: string;
  createdAt?: string;
  taskId?: string;
  source?: LessonWriteEntry['source'];
  lastError?: string;
}): LessonWriteEntry {
  const kb = (input.kb?.trim() || DEFAULT_LESSON_KB);
  const title = input.title.trim();
  const body = normalizeBody(input.body);
  return {
    schemaVersion: LESSON_WRITE_SPOOL_SCHEMA,
    contentHash: contentHashFor(kb, title, body),
    kb,
    title,
    body,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    source: input.source ?? 'kb-remember',
    ...(input.lastError ? { lastError: input.lastError.slice(0, 500) } : {}),
  };
}

/**
 * Append a lesson to the durable spool. Duplicate content hashes are skipped
 * so concurrent/retry writes never double-queue the same lesson.
 */
export async function appendLessonWrite(
  spoolDir: string,
  entry: LessonWriteEntry,
): Promise<AppendLessonResult> {
  await mkdir(spoolDir, { recursive: true });
  const path = pendingPath(spoolDir);
  const existing = await readPendingLessons(spoolDir);
  if (existing.some((e) => e.contentHash === entry.contentHash)) {
    return { appended: false, reason: 'duplicate', contentHash: entry.contentHash, path };
  }
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return { appended: true, reason: 'appended', contentHash: entry.contentHash, path };
}

/** Read and parse the pending spool; malformed lines are skipped. */
export async function readPendingLessons(spoolDir: string): Promise<LessonWriteEntry[]> {
  const path = pendingPath(spoolDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const byHash = new Map<string, LessonWriteEntry>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<LessonWriteEntry>;
      if (
        parsed.schemaVersion === LESSON_WRITE_SPOOL_SCHEMA
        && typeof parsed.contentHash === 'string'
        && typeof parsed.kb === 'string'
        && typeof parsed.title === 'string'
        && typeof parsed.body === 'string'
        && typeof parsed.createdAt === 'string'
      ) {
        byHash.set(parsed.contentHash, parsed as LessonWriteEntry);
      }
    } catch {
      // tolerate corrupt lines
    }
  }
  return Array.from(byHash.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Drain the spool by writing each pending entry via `write`. Successfully
 * written entries are removed. Failures stay for a later drain. Re-running
 * against an empty or fully-written spool is a no-op.
 */
export async function drainLessonSpool(opts: {
  spoolDir: string;
  write: LessonWriteFn;
}): Promise<DrainLessonResult> {
  const pending = await readPendingLessons(opts.spoolDir);
  if (pending.length === 0) {
    return {
      attempted: 0,
      written: 0,
      failed: 0,
      skippedDuplicate: 0,
      remaining: 0,
      writtenHashes: [],
      failedHashes: [],
    };
  }

  const remaining: LessonWriteEntry[] = [];
  const writtenHashes: string[] = [];
  const failedHashes: string[] = [];
  let written = 0;
  let failed = 0;

  for (const entry of pending) {
    const result = await opts.write({ kb: entry.kb, title: entry.title, body: entry.body });
    if (result.ok) {
      written += 1;
      writtenHashes.push(entry.contentHash);
    } else {
      failed += 1;
      failedHashes.push(entry.contentHash);
      remaining.push({
        ...entry,
        lastError: result.error?.slice(0, 500) ?? entry.lastError,
      });
    }
  }

  await rewritePending(opts.spoolDir, remaining);

  return {
    attempted: pending.length,
    written,
    failed,
    skippedDuplicate: 0,
    remaining: remaining.length,
    writtenHashes,
    failedHashes,
  };
}

async function rewritePending(spoolDir: string, entries: LessonWriteEntry[]): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = pendingPath(spoolDir);
  const body = entries.length === 0
    ? ''
    : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  // atomicWriteFile: write temp → fsync → rename (parity with other durable paths).
  await atomicWriteFile(path, body);
}

export function emptySpoolState(): LessonSpoolState {
  return {
    schemaVersion: 'lesson-write-spool-state.v1',
    kbDegradedSince: null,
    alertFiredAt: null,
    lastProbeAt: null,
    lastProbeStatus: null,
  };
}

export async function readSpoolState(spoolDir: string): Promise<LessonSpoolState> {
  const path = statePath(spoolDir);
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<LessonSpoolState>;
    if (parsed.schemaVersion !== 'lesson-write-spool-state.v1') return emptySpoolState();
    return {
      schemaVersion: 'lesson-write-spool-state.v1',
      kbDegradedSince: typeof parsed.kbDegradedSince === 'string' ? parsed.kbDegradedSince : null,
      alertFiredAt: typeof parsed.alertFiredAt === 'string' ? parsed.alertFiredAt : null,
      lastProbeAt: typeof parsed.lastProbeAt === 'string' ? parsed.lastProbeAt : null,
      lastProbeStatus:
        parsed.lastProbeStatus === 'healthy' || parsed.lastProbeStatus === 'degraded'
          ? parsed.lastProbeStatus
          : null,
      ...(typeof parsed.lastPendingCount === 'number'
        ? { lastPendingCount: parsed.lastPendingCount }
        : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return emptySpoolState();
    // Corrupt state — start fresh rather than block recovery.
    return emptySpoolState();
  }
}

export async function writeSpoolState(spoolDir: string, state: LessonSpoolState): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = statePath(spoolDir);
  // atomicWriteFile: write temp → fsync → rename (parity with other durable paths).
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Default prolonged-degradation threshold: 2 hours (issue #1519). */
export const DEFAULT_DEGRADED_ALERT_THRESHOLD_MS = 2 * 60 * 60 * 1000;

export type DegradationProbeStatus = 'healthy' | 'degraded';

export interface DegradationTickResult {
  state: LessonSpoolState;
  /** Fire a prolonged-degradation alert once for this streak. */
  shouldFireAlert: boolean;
  /** KB just recovered — drain the spool. */
  shouldDrain: boolean;
  /** Duration of current degraded streak in ms, or 0 when healthy. */
  degradedForMs: number;
}

/**
 * Pure transition for the KB degradation streak + alert edge-trigger.
 * Durable state is persisted by the caller.
 */
export function applyDegradationProbe(opts: {
  previous: LessonSpoolState;
  status: DegradationProbeStatus;
  now: Date;
  thresholdMs?: number;
}): DegradationTickResult {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_DEGRADED_ALERT_THRESHOLD_MS;
  const nowIso = opts.now.toISOString();
  const nowMs = opts.now.getTime();

  if (opts.status === 'healthy') {
    const recovered = opts.previous.lastProbeStatus === 'degraded'
      || opts.previous.kbDegradedSince != null
      || (opts.previous.lastPendingCount ?? 0) > 0;
    const state: LessonSpoolState = {
      schemaVersion: 'lesson-write-spool-state.v1',
      kbDegradedSince: null,
      alertFiredAt: null,
      lastProbeAt: nowIso,
      lastProbeStatus: 'healthy',
      lastPendingCount: opts.previous.lastPendingCount,
    };
    return {
      state,
      shouldFireAlert: false,
      shouldDrain: recovered || (opts.previous.lastPendingCount ?? 0) > 0,
      degradedForMs: 0,
    };
  }

  // degraded
  const degradedSince = opts.previous.kbDegradedSince ?? nowIso;
  const degradedForMs = Math.max(0, nowMs - Date.parse(degradedSince));
  const alreadyFired = opts.previous.alertFiredAt != null;
  const shouldFireAlert = !alreadyFired && degradedForMs >= thresholdMs;
  const state: LessonSpoolState = {
    schemaVersion: 'lesson-write-spool-state.v1',
    kbDegradedSince: degradedSince,
    alertFiredAt: shouldFireAlert ? nowIso : opts.previous.alertFiredAt,
    lastProbeAt: nowIso,
    lastProbeStatus: 'degraded',
    lastPendingCount: opts.previous.lastPendingCount,
  };
  return {
    state,
    shouldFireAlert,
    shouldDrain: false,
    degradedForMs,
  };
}

/** True when a `kb remember` argv targets the lesson shelf (or --lesson). */
export function isLessonRememberArgv(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  if (argv[0] !== 'remember') return false;
  if (argv.includes('--lesson')) return true;
  for (const arg of argv) {
    if (arg === `--kb=${DEFAULT_LESSON_KB}` || arg === `--kb=${DEFAULT_LESSON_KB}/`) return true;
    if (arg.startsWith('--kb=') && arg.slice(5) === DEFAULT_LESSON_KB) return true;
  }
  // `--kb agent-task-lessons` two-token form
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--kb' && argv[i + 1] === DEFAULT_LESSON_KB) return true;
  }
  return false;
}

/** Extract `--title=` (or two-token) from remember argv. */
export function extractRememberTitle(argv: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('--title=')) {
      const v = arg.slice('--title='.length);
      return v.length > 0 ? v : undefined;
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--title' && argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
      return argv[i + 1];
    }
  }
  return undefined;
}

export function extractRememberKb(argv: readonly string[]): string {
  if (argv.includes('--lesson')) return DEFAULT_LESSON_KB;
  for (const arg of argv) {
    if (arg.startsWith('--kb=')) {
      const v = arg.slice(5).replace(/\/$/, '');
      if (v) return v;
    }
  }
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === '--kb' && argv[i + 1] && !argv[i + 1]!.startsWith('-')) {
      return argv[i + 1]!;
    }
  }
  return DEFAULT_LESSON_KB;
}

