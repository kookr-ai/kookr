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

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from './persistence-utils.js';

export const LESSON_WRITE_SPOOL_SCHEMA = 'lesson-write-spool.v1' as const;
export const DEFAULT_LESSON_KB = 'agent-task-lessons';
export const SPOOL_DIR_REL = join('playbook-state', 'lesson-write-spool');
export const PENDING_FILE = 'pending.jsonl';
export const DEAD_LETTER_FILE = 'dead-letter.jsonl';
export const STATE_FILE = 'state.json';
export const MAX_LESSON_DRAIN_ATTEMPTS = 5;
const DRAIN_LOCK_DIR = 'drain.lock';
const MUTATION_LOCK_DIR = 'mutation.lock';
const MUTATION_LOCK_WAIT_MS = 5_000;

interface SpoolLockHolder {
  pid: number;
  generation: string;
}

export interface LessonWriteEntry {
  schemaVersion: typeof LESSON_WRITE_SPOOL_SCHEMA;
  contentHash: string;
  kb: string;
  title: string;
  body: string;
  createdAt: string;
  taskId?: string;
  source: 'kb-remember' | 'kookr-lesson';
  /** Reserved replay attempts. Missing on entries written before retry bounding. */
  attempts?: number;
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
  deadLettered: number;
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

export function deadLetterPath(spoolDir: string): string {
  return join(spoolDir, DEAD_LETTER_FILE);
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
  const release = await acquireSpoolLock(join(spoolDir, MUTATION_LOCK_DIR), MUTATION_LOCK_WAIT_MS);
  if (!release) throw new Error('lesson spool mutation lock remained busy');
  try {
    await mkdir(spoolDir, { recursive: true });
    const path = pendingPath(spoolDir);
    const existing = await readPendingLessons(spoolDir);
    if (existing.some((e) => e.contentHash === entry.contentHash)) {
      return { appended: false, reason: 'duplicate', contentHash: entry.contentHash, path };
    }
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return { appended: true, reason: 'appended', contentHash: entry.contentHash, path };
  } finally {
    await release();
  }
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
 * written entries are removed. Failures stay pending until the retry cap,
 * then move to the dead-letter file. Re-running an empty spool is a no-op.
 */
export async function drainLessonSpool(opts: {
  spoolDir: string;
  write: LessonWriteFn;
}): Promise<DrainLessonResult> {
  const observed = await readPendingLessons(opts.spoolDir);
  if (observed.length === 0) return emptyDrainResult();

  const release = await acquireSpoolLock(join(opts.spoolDir, DRAIN_LOCK_DIR), 0);
  if (!release) return emptyDrainResult(observed.length);
  try {
    return await drainLessonSpoolLocked(opts);
  } finally {
    await release();
  }
}

async function drainLessonSpoolLocked(opts: {
  spoolDir: string;
  write: LessonWriteFn;
}): Promise<DrainLessonResult> {
  const pending = await readPendingLessons(opts.spoolDir);
  if (pending.length === 0) return emptyDrainResult();

  const remaining: LessonWriteEntry[] = [];
  const deadLetterEntries: LessonWriteEntry[] = [];
  const deadLetterHashes = await readDeadLetterHashes(opts.spoolDir);
  const writtenHashes: string[] = [];
  const failedHashes: string[] = [];
  let written = 0;
  let failed = 0;
  let alreadyDeadLettered = 0;

  for (const entry of pending) {
    // A prior drain may have durably appended the dead letter but crashed
    // before removing the active copy. Retire it without another provider call.
    if (deadLetterHashes.has(entry.contentHash)) {
      alreadyDeadLettered += 1;
      continue;
    }
    const reservation = await reserveLessonAttempt(opts.spoolDir, entry.contentHash);
    if (!reservation) continue;
    if (!reservation.invokeWrite) {
      deadLetterEntries.push(reservation.entry);
      continue;
    }
    const reservedEntry = reservation.entry;
    const result = await opts.write({
      kb: reservedEntry.kb,
      title: reservedEntry.title,
      body: reservedEntry.body,
    });
    if (result.ok) {
      written += 1;
      writtenHashes.push(reservedEntry.contentHash);
    } else {
      failed += 1;
      failedHashes.push(reservedEntry.contentHash);
      const failedEntry: LessonWriteEntry = {
        ...reservedEntry,
        lastError: result.error?.slice(0, 500) ?? reservedEntry.lastError,
      };
      if ((reservedEntry.attempts ?? 0) >= MAX_LESSON_DRAIN_ATTEMPTS) {
        deadLetterEntries.push(failedEntry);
      } else {
        remaining.push(failedEntry);
      }
    }
  }

  const snapshotHashes = new Set(pending.map((entry) => entry.contentHash));
  const remainingByHash = new Map(remaining.map((entry) => [entry.contentHash, entry]));
  const releaseMutation = await acquireSpoolLock(
    join(opts.spoolDir, MUTATION_LOCK_DIR),
    MUTATION_LOCK_WAIT_MS,
  );
  if (!releaseMutation) throw new Error('lesson spool mutation lock remained busy');
  let finalRemaining = 0;
  try {
    // The append is fsynced before active entries are removed. If the pending
    // rewrite later fails, the next drain reconciles the durable hash above.
    await appendDeadLetters(opts.spoolDir, deadLetterEntries, deadLetterHashes);
    const current = await readPendingLessons(opts.spoolDir);
    const merged = current.flatMap((entry) => {
      if (!snapshotHashes.has(entry.contentHash)) return [entry];
      const retained = remainingByHash.get(entry.contentHash);
      return retained ? [retained] : [];
    });
    await rewritePending(opts.spoolDir, merged);
    finalRemaining = merged.length;
  } finally {
    await releaseMutation();
  }

  return {
    attempted: pending.length,
    written,
    failed,
    deadLettered: deadLetterEntries.length + alreadyDeadLettered,
    skippedDuplicate: 0,
    remaining: finalRemaining,
    writtenHashes,
    failedHashes,
  };
}

async function reserveLessonAttempt(
  spoolDir: string,
  contentHash: string,
): Promise<{ entry: LessonWriteEntry; invokeWrite: boolean } | null> {
  const release = await acquireSpoolLock(join(spoolDir, MUTATION_LOCK_DIR), MUTATION_LOCK_WAIT_MS);
  if (!release) throw new Error('lesson spool mutation lock remained busy');
  try {
    const current = await readPendingLessons(spoolDir);
    const index = current.findIndex((entry) => entry.contentHash === contentHash);
    if (index < 0) return null;
    const entry = current[index]!;
    const previousAttempts = Number.isInteger(entry.attempts) && (entry.attempts ?? 0) >= 0
      ? entry.attempts ?? 0
      : 0;
    if (previousAttempts >= MAX_LESSON_DRAIN_ATTEMPTS) {
      return { entry, invokeWrite: false };
    }
    const reserved = { ...entry, attempts: previousAttempts + 1 };
    current[index] = reserved;
    await rewritePending(spoolDir, current);
    return { entry: reserved, invokeWrite: true };
  } finally {
    await release();
  }
}

async function appendDeadLetters(
  spoolDir: string,
  entries: LessonWriteEntry[],
  existingHashes: ReadonlySet<string>,
): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(spoolDir, { recursive: true });
  const path = deadLetterPath(spoolDir);
  const newEntries = entries.filter((entry) => !existingHashes.has(entry.contentHash));
  if (newEntries.length === 0) return;
  let created = false;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'ax', 0o600);
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    handle = await open(path, 'a', 0o600);
  }
  try {
    let prefix = '';
    if (!created) {
      const existing = await readFile(path, 'utf8');
      if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n';
    }
    await handle.writeFile(
      `${prefix}${newEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (created) {
    await syncDirectory(spoolDir);
  }
}

async function readDeadLetterHashes(spoolDir: string): Promise<Set<string>> {
  const hashes = new Set<string>();
  let existing: string;
  try {
    const handle = await open(deadLetterPath(spoolDir), 'r+');
    try {
      // A prior process may have completed a record write but stopped before
      // fsync. Make any parseable record durable before trusting its hash to
      // retire the active copy.
      await handle.sync();
      existing = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    await syncDirectory(spoolDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return hashes;
    throw err;
  }
  for (const line of existing.split('\n')) {
    try {
      const parsed = JSON.parse(line) as { contentHash?: unknown };
      if (typeof parsed.contentHash === 'string') hashes.add(parsed.contentHash);
    } catch {
      // Preserve malformed append-only records; they do not block quarantine.
    }
  }
  return hashes;
}

function emptyDrainResult(remaining = 0): DrainLessonResult {
  return {
    attempted: 0,
    written: 0,
    failed: 0,
    deadLettered: 0,
    skippedDuplicate: 0,
    remaining,
    writtenHashes: [],
    failedHashes: [],
  };
}

type ReleaseSpoolLock = () => Promise<void>;
const heldLocalSpoolLocks = new Set<string>();

async function acquireSpoolLock(lockPath: string, waitMs: number): Promise<ReleaseSpoolLock | null> {
  const deadline = Date.now() + waitMs;
  const releaseLocal = await acquireLocalSpoolLock(lockPath, deadline);
  if (!releaseLocal) return null;
  try {
    do {
      const releaseCrossProcess = await tryAcquireSpoolLock(lockPath);
      if (releaseCrossProcess) {
        return async () => {
          try {
            await releaseCrossProcess();
          } finally {
            await releaseLocal();
          }
        };
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        await releaseLocal();
        return null;
      }
      // Contending processes that published candidates together should not
      // wake in the same fixed cadence and repeatedly withdraw in lockstep.
      const backoffMs = Math.min(remainingMs, 10 + Math.floor(Math.random() * 21));
      await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
    } while (true);
  } catch (err) {
    await releaseLocal();
    throw err;
  }
}

async function acquireLocalSpoolLock(
  lockPath: string,
  deadline: number,
): Promise<ReleaseSpoolLock | null> {
  do {
    if (!heldLocalSpoolLocks.has(lockPath)) {
      heldLocalSpoolLocks.add(lockPath);
      return async () => {
        heldLocalSpoolLocks.delete(lockPath);
      };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remainingMs, 10)));
  } while (true);
}

async function tryAcquireSpoolLock(lockPath: string): Promise<ReleaseSpoolLock | null> {
  await mkdir(lockPath, { recursive: true });
  const generation = await processGeneration(process.pid);
  if (generation == null) {
    throw new Error(`lesson spool could not identify lock holder process ${process.pid}`);
  }
  const claimPath = join(lockPath, `${process.pid}-${randomUUID()}.claim`);
  // Each holder owns only its immutable claim. This avoids a stale-reclaimer
  // deleting a new holder's canonical lock between an ownership check and rm.
  await symlink(JSON.stringify({ pid: process.pid, generation }), claimPath);
  let acquired = false;
  try {
    let busy = false;
    for (const name of await readdir(lockPath)) {
      const otherClaim = join(lockPath, name);
      if (otherClaim === claimPath) continue;
      const holder = await readSpoolLockHolder(otherClaim);
      if (holder == null || !(await isSpoolClaimLive(holder))) {
        // Claims are unique and published atomically, so an invalid or dead
        // claimant can be removed without touching any replacement owner.
        await rm(otherClaim, { force: true });
      } else {
        busy = true;
      }
    }
    if (busy) return null;
    acquired = true;
    return async () => {
      await rm(claimPath, { force: true });
    };
  } finally {
    if (!acquired) await rm(claimPath, { force: true });
  }
}

async function isSpoolClaimLive(holder: SpoolLockHolder): Promise<boolean> {
  if (!isProcessAlive(holder.pid)) return false;
  const currentGeneration = await processGeneration(holder.pid);
  // If the platform probe fails for a process that is demonstrably live, fail
  // closed instead of risking concurrent owners.
  return currentGeneration == null || currentGeneration === holder.generation;
}

async function readSpoolLockHolder(lockPath: string): Promise<SpoolLockHolder | null> {
  try {
    const parsed = JSON.parse(await readlink(lockPath)) as Partial<SpoolLockHolder>;
    return typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && parsed.pid > 0
      && typeof parsed.generation === 'string'
      && parsed.generation.length > 0
      ? { pid: parsed.pid, generation: parsed.generation }
      : null;
  } catch {
    return null;
  }
}

let linuxBootId: string | undefined;

async function processGeneration(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return linuxProcessGeneration(pid);
  }
  return posixProcessGeneration(pid);
}

async function linuxProcessGeneration(pid: number): Promise<string | null> {
  try {
    linuxBootId ??= (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    // Fields after the command begin at process state (field 3); starttime is
    // field 22, hence index 19 in this suffix.
    const startTime = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
    return linuxBootId && startTime && /^\d+$/.test(startTime)
      ? `linux:${linuxBootId}:${startTime}`
      : null;
  } catch {
    return null;
  }
}

async function posixProcessGeneration(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-p', String(pid), '-o', 'lstart='],
      {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        maxBuffer: 4_096,
        timeout: 2_000,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const startedAt = stdout.trim().replace(/\s+/g, ' ');
        resolve(startedAt ? `${process.platform}:${startedAt}` : null);
      },
    );
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function rewritePending(spoolDir: string, entries: LessonWriteEntry[]): Promise<void> {
  await mkdir(spoolDir, { recursive: true });
  const path = pendingPath(spoolDir);
  const body = entries.length === 0
    ? ''
    : `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
  // atomicWriteFile: write temp → fsync → rename (parity with other durable paths).
  await atomicWriteFile(path, body);
  await syncDirectory(spoolDir);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
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
