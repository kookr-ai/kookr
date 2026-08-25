/**
 * Durable terminal-tail storage for completed (and terminal) Kookr tasks.
 *
 * See docs/rfc/rfc-task-tail-retrieval.md. Captured just before session
 * teardown so GET /api/tasks/:id/tail and GET /api/capture/:sessionId can
 * still return output after the dtach ring is gone.
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const TASK_TAIL_SCHEMA_VERSION = 'task-tail.v1' as const;
export const DEFAULT_TASK_TAIL_RETENTION_DAYS = 7;
export const DEFAULT_TASK_TAIL_MAX_BYTES = 256 * 1024;
export const DEFAULT_TASK_TAIL_PURGE_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_TASK_TAIL_LINES = 80;
export const MAX_TASK_TAIL_LINES = 2000;
export const MIN_TASK_TAIL_LINES = 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const BY_SESSION_DIRNAME = 'by-session';

export interface TaskTailRecord {
  schemaVersion: typeof TASK_TAIL_SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  capturedAt: string;
  text: string;
  byteLength: number;
  truncated: boolean;
}

export interface TaskTailStoreOptions {
  /** Absolute path to the task-tails directory. */
  dir: string;
  /** Retention window in days. Defaults to {@link DEFAULT_TASK_TAIL_RETENTION_DAYS}. */
  retentionDays?: number;
  /** Max UTF-8 bytes kept per tail (suffix-truncated). Defaults to {@link DEFAULT_TASK_TAIL_MAX_BYTES}. */
  maxBytes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface SaveTaskTailInput {
  taskId: string;
  sessionId: string;
  text: string;
  capturedAt?: Date;
}

export interface BoundTailText {
  text: string;
  totalLines: number;
  shownLines: number;
}

export function readTaskTailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  kookrDir: string,
): {
  dir: string;
  retentionDays: number;
  maxBytes: number;
  purgeIntervalMs: number;
} {
  const dirRaw = env.KOOKR_TASK_TAIL_DIR?.trim();
  const dir = dirRaw && dirRaw.length > 0 ? dirRaw : join(kookrDir, 'task-tails');

  const retentionDays = parsePositiveNumber(
    env.KOOKR_TASK_TAIL_RETENTION_DAYS,
    DEFAULT_TASK_TAIL_RETENTION_DAYS,
  );
  const maxBytes = parsePositiveInt(env.KOOKR_TASK_TAIL_MAX_BYTES, DEFAULT_TASK_TAIL_MAX_BYTES);

  const purgeRaw = env.KOOKR_TASK_TAIL_PURGE_INTERVAL_MS;
  let purgeIntervalMs = DEFAULT_TASK_TAIL_PURGE_INTERVAL_MS;
  if (purgeRaw !== undefined && purgeRaw.trim() !== '') {
    const n = Number(purgeRaw);
    if (Number.isFinite(n) && n >= 0) purgeIntervalMs = Math.floor(n);
  }

  return { dir, retentionDays, maxBytes, purgeIntervalMs };
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/** Clamp `lines` query to [MIN, MAX]; returns Error for non-integer garbage. */
export function parseTailLinesQuery(raw: string | undefined): number | Error {
  if (raw === undefined || raw === '') return DEFAULT_TASK_TAIL_LINES;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return new Error(`lines must be an integer between ${MIN_TASK_TAIL_LINES} and ${MAX_TASK_TAIL_LINES}`);
  }
  if (n < MIN_TASK_TAIL_LINES || n > MAX_TASK_TAIL_LINES) {
    return new Error(`lines must be an integer between ${MIN_TASK_TAIL_LINES} and ${MAX_TASK_TAIL_LINES}`);
  }
  return n;
}

/** Keep the last `maxLines` lines of `text` (split on `\n`). */
export function boundTailText(text: string, maxLines: number): BoundTailText {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Drop trailing empty lines the way terminal captures often pad.
  const all = normalized.split('\n');
  while (all.length > 0 && all[all.length - 1] === '') all.pop();
  const totalLines = all.length;
  if (totalLines <= maxLines) {
    return { text: all.join('\n'), totalLines, shownLines: totalLines };
  }
  const slice = all.slice(totalLines - maxLines);
  return { text: slice.join('\n'), totalLines, shownLines: slice.length };
}

/** Keep only the last `maxBytes` UTF-8 bytes of `text`. */
export function truncateTextToMaxBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // Walk back to a code-point boundary so we never split a multi-byte char.
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return { text: buf.subarray(start).toString('utf8'), truncated: true };
}

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid ${label} for task-tail store: ${JSON.stringify(id)}`);
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(filePath), `.tmp-${randomUUID()}`);
  // Compact JSON: tails are machine-only (up to ~256 KiB) and always JSON.parse'd;
  // pretty-print wastes CPU/disk on every completion write (issue #2176).
  const body = JSON.stringify(value);
  let renamed = false;
  try {
    await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await unlink(tmp); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function isTaskTailRecord(value: unknown): value is TaskTailRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    r.schemaVersion === TASK_TAIL_SCHEMA_VERSION
    && typeof r.taskId === 'string'
    && typeof r.sessionId === 'string'
    && typeof r.capturedAt === 'string'
    && typeof r.text === 'string'
    && typeof r.byteLength === 'number'
    && typeof r.truncated === 'boolean'
  );
}

export class TaskTailStore {
  private readonly dir: string;
  private readonly bySessionDir: string;
  private readonly retentionDays: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private dirEnsured = false;

  constructor(options: TaskTailStoreOptions) {
    this.dir = options.dir;
    this.bySessionDir = join(options.dir, BY_SESSION_DIRNAME);
    this.retentionDays = options.retentionDays ?? DEFAULT_TASK_TAIL_RETENTION_DAYS;
    this.maxBytes = options.maxBytes ?? DEFAULT_TASK_TAIL_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  get retentionMs(): number {
    return this.retentionDays * MS_PER_DAY;
  }

  retentionExpiresAt(capturedAt: string | Date): string {
    const t = typeof capturedAt === 'string' ? Date.parse(capturedAt) : capturedAt.getTime();
    return new Date(t + this.retentionMs).toISOString();
  }

  private taskPath(taskId: string): string {
    return join(this.dir, `${taskId}.json`);
  }

  private sessionPath(sessionId: string): string {
    return join(this.bySessionDir, `${sessionId}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(this.bySessionDir, { recursive: true, mode: 0o700 });
    this.dirEnsured = true;
  }

  private isExpired(record: TaskTailRecord, nowMs: number = this.now()): boolean {
    const captured = Date.parse(record.capturedAt);
    if (!Number.isFinite(captured)) return true;
    return nowMs - captured > this.retentionMs;
  }

  /**
   * Persist (or overwrite) the terminal tail for a task. Best-effort callers
   * should catch; this throws on path/id safety failures.
   */
  async save(input: SaveTaskTailInput): Promise<TaskTailRecord> {
    assertSafeId(input.taskId, 'taskId');
    assertSafeId(input.sessionId, 'sessionId');
    await this.ensureDir();

    const { text, truncated } = truncateTextToMaxBytes(input.text, this.maxBytes);
    const record: TaskTailRecord = {
      schemaVersion: TASK_TAIL_SCHEMA_VERSION,
      taskId: input.taskId,
      sessionId: input.sessionId,
      capturedAt: (input.capturedAt ?? new Date(this.now())).toISOString(),
      text,
      byteLength: Buffer.byteLength(text, 'utf8'),
      truncated,
    };

    await atomicWriteJson(this.taskPath(input.taskId), record);
    await atomicWriteJson(this.sessionPath(input.sessionId), record);
    return record;
  }

  async getByTaskId(taskId: string): Promise<TaskTailRecord | null> {
    if (!SAFE_ID_RE.test(taskId)) return null;
    return this.readAndMaybeExpire(this.taskPath(taskId));
  }

  async getBySessionId(sessionId: string): Promise<TaskTailRecord | null> {
    if (!SAFE_ID_RE.test(sessionId)) return null;
    return this.readAndMaybeExpire(this.sessionPath(sessionId));
  }

  private async readAndMaybeExpire(path: string): Promise<TaskTailRecord | null> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.safeUnlink(path);
      return null;
    }
    if (!isTaskTailRecord(parsed)) {
      await this.safeUnlink(path);
      return null;
    }
    if (this.isExpired(parsed)) {
      await this.removeRecord(parsed);
      return null;
    }
    return parsed;
  }

  async removeByTaskId(taskId: string): Promise<void> {
    if (!SAFE_ID_RE.test(taskId)) return;
    const record = await this.readRaw(this.taskPath(taskId));
    if (record) {
      await this.removeRecord(record);
      return;
    }
    await this.safeUnlink(this.taskPath(taskId));
  }

  private async readRaw(path: string): Promise<TaskTailRecord | null> {
    try {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isTaskTailRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async removeRecord(record: TaskTailRecord): Promise<void> {
    await this.safeUnlink(this.taskPath(record.taskId));
    await this.safeUnlink(this.sessionPath(record.sessionId));
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Best-effort cleanup — surface nothing to callers.
      }
    }
  }

  /**
   * Delete every expired primary task-tail file (and its session index).
   * Returns the number of primary records removed.
   */
  async purgeExpired(): Promise<number> {
    await this.ensureDir();
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }

    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir, name);
      const record = await this.readRaw(path);
      if (!record) continue;
      if (this.isExpired(record)) {
        await this.removeRecord(record);
        removed += 1;
      }
    }
    return removed;
  }
}
