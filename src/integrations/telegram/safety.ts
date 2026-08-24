/**
 * Process-wide safety primitives for the Telegram integration:
 *
 *   - Token-bucket rate limiter (per-sender, in-memory, stateless across
 *     restart — round-2 N9 acceptable: per-minute caps don't need durability).
 *   - Rolling 24h spawn cap (persisted in state.json; counter is keyed by
 *     wall-clock timestamps so there's no UTC-midnight-reset attack window
 *     per round-2 N7).
 *   - Lockfile based on O_EXCL with pid liveness check (round-2 N11: avoid
 *     pid-check + unlink + create race; we use exclusive create and only
 *     replace on stale-pid AFTER reading current owner).
 *   - Pending confirmation store (one file per sha256 hash; consume = read +
 *     unlink + counter-record in one logical operation, best-effort across
 *     crashes — see round-3 V9 for the honest non-fs-atomic note).
 *   - Persistent offset (last update_id + 1).
 *   - Origin map (taskId → chatId for R16 routing).
 *
 * All persistence is in <dataDir>/telegram/.
 */

import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isAgentType, type AgentType } from '../../shared/contracts/agent-types.js';

// ---------------------------------------------------------------------------
// Token bucket (per-sender, in-memory, simple)
// ---------------------------------------------------------------------------

export interface RateLimiter {
  allow(senderId: number): boolean;
}

export function createTokenBucket(perMinute: number): RateLimiter {
  const refillIntervalMs = (60_000 / perMinute);
  const capacity = perMinute;
  const buckets = new Map<number, { tokens: number; lastRefillAt: number }>();
  return {
    allow(senderId: number): boolean {
      const now = Date.now();
      const b = buckets.get(senderId);
      if (!b) {
        buckets.set(senderId, { tokens: capacity - 1, lastRefillAt: now });
        return true;
      }
      const elapsed = now - b.lastRefillAt;
      const refilled = Math.floor(elapsed / refillIntervalMs);
      if (refilled > 0) {
        b.tokens = Math.min(capacity, b.tokens + refilled);
        b.lastRefillAt += refilled * refillIntervalMs;
      }
      if (b.tokens <= 0) return false;
      b.tokens -= 1;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Lockfile (O_EXCL with pid-staleness fallback)
// ---------------------------------------------------------------------------

export interface LockHandle {
  release(): Promise<void>;
}

export class LockBusyError extends Error {
  constructor(public readonly holderPid: number) {
    super(`Telegram lock held by PID ${holderPid} (set KOOKR_TELEGRAM_BOT_TOKEN in only one worktree's .env)`);
    this.name = 'LockBusyError';
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we can't signal — alive.
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export async function acquireLockOrFail(path: string): Promise<LockHandle> {
  const ourPid = process.pid;
  const tryAcquire = async (): Promise<boolean> => {
    try {
      // O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail.
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.write(JSON.stringify({ pid: ourPid, startedAt: new Date().toISOString() }));
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (await tryAcquire()) return makeLockHandle(path);

  // Existing lock — read pid, check liveness.
  let holderPid: number;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as { pid?: number };
    holderPid = typeof parsed.pid === 'number' ? parsed.pid : -1;
  } catch {
    holderPid = -1;
  }
  if (holderPid > 0 && isProcessAlive(holderPid)) {
    throw new LockBusyError(holderPid);
  }
  // Stale lock — replace it. Race window is small: O_EXCL retry once.
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (await tryAcquire()) return makeLockHandle(path);
  throw new LockBusyError(holderPid > 0 ? holderPid : -1);
}

function makeLockHandle(path: string): LockHandle {
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await unlink(path);
    } catch {
      // Best effort — already gone is fine.
    }
  };
  // No process.once('exit', ...) here intentionally: in test environments many
  // lockfiles can be created+released in one process, and exit-listener leaks
  // produce noisy warnings. If a process dies without calling release(), the
  // stale-pid takeover path in acquireLockOrFail() handles recovery on next
  // startup. The startup pid-liveness check IS the cleanup mechanism.
  return { release };
}

// ---------------------------------------------------------------------------
// State.json — atomic write of small persisted state (round-3 boundary fix:
// collapse offset.json + daily-counter.json + origin-map.json into one file).
// ---------------------------------------------------------------------------

export interface IntegrationState {
  /** Next getUpdates offset = last_update_id + 1. */
  offset: number;
  /** Rolling 24h spawn timestamps (ms epoch). */
  spawnsByMs: number[];
  /** taskId → chatId for R16 block-alert routing. */
  origin: Record<string, number>;
  /** Telegram sender id string → default agent for future task confirmations. */
  agentDefaultsByUser: Record<string, AgentType>;
}

function emptyState(): IntegrationState {
  return { offset: 0, spawnsByMs: [], origin: {}, agentDefaultsByUser: {} };
}

export class StateStore {
  private state: IntegrationState;
  constructor(private readonly path: string, initial: IntegrationState) {
    this.state = initial;
  }
  static async open(path: string): Promise<StateStore> {
    let initial: IntegrationState = emptyState();
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IntegrationState>;
      initial = {
        offset: typeof parsed.offset === 'number' ? parsed.offset : 0,
        spawnsByMs: Array.isArray(parsed.spawnsByMs) ? parsed.spawnsByMs.filter((n) => typeof n === 'number') : [],
        origin: typeof parsed.origin === 'object' && parsed.origin !== null ? parsed.origin as Record<string, number> : {},
        agentDefaultsByUser: Object.fromEntries(
          Object.entries(
            typeof parsed.agentDefaultsByUser === 'object' && parsed.agentDefaultsByUser !== null
              ? parsed.agentDefaultsByUser as Record<string, unknown>
              : {},
          ).filter(([, value]) => isAgentType(value)),
        ) as Record<string, AgentType>,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Corrupted state.json — start fresh, log a warning.
        console.warn(`[telegram] state.json unreadable (${code ?? 'parse error'}); starting from empty state`);
      }
    }
    return new StateStore(path, initial);
  }
  get(): Readonly<IntegrationState> {
    return this.state;
  }
  async update(mut: (s: IntegrationState) => void): Promise<void> {
    mut(this.state);
    await this.persist();
  }
  private async persist(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

// ---------------------------------------------------------------------------
// Daily cap (rolling 24h)
// ---------------------------------------------------------------------------

export interface DailyCapView {
  spawnsLast24h: number;
}

export interface SpawnCapResult {
  allowed: boolean;
  usage: DailyCapView;
}

export class DailyCap {
  constructor(private readonly maxSpawnsPerDay: number, private readonly state: StateStore) {}

  view(now = Date.now()): DailyCapView {
    const cutoff = now - 24 * 60 * 60 * 1000;
    return { spawnsLast24h: this.state.get().spawnsByMs.filter((t) => t >= cutoff).length };
  }

  /** Atomic: prune stale entries, check cap, append new entry, persist. */
  async checkAndReserveSpawn(now = Date.now()): Promise<SpawnCapResult> {
    const cutoff = now - 24 * 60 * 60 * 1000;
    let allowed = false;
    let usage: DailyCapView = { spawnsLast24h: 0 };
    await this.state.update((s) => {
      s.spawnsByMs = s.spawnsByMs.filter((t) => t >= cutoff);
      if (s.spawnsByMs.length >= this.maxSpawnsPerDay) {
        usage = { spawnsLast24h: s.spawnsByMs.length };
        return;
      }
      s.spawnsByMs.push(now);
      allowed = true;
      usage = { spawnsLast24h: s.spawnsByMs.length };
    });
    return { allowed, usage };
  }
}

// ---------------------------------------------------------------------------
// Pending confirmation store — one JSON file per sha256 hash of the spec.
// ---------------------------------------------------------------------------

export interface PendingSpec {
  /** ms epoch */ createdAt: number;
  /** pre-validated spec */ spec: { prompt: string; cwd: string; agentType: AgentType; suggestedBranch?: string; effort?: string; model?: string };
  /** chat that created this draft */ chatId: number;
}

export class PendingStore {
  constructor(private readonly dir: string) {}
  static async open(dir: string): Promise<PendingStore> {
    await mkdir(dir, { recursive: true });
    return new PendingStore(dir);
  }
  async write(hash: string, pending: PendingSpec): Promise<void> {
    const p = join(this.dir, `${hash}.json`);
    await writeFile(p, JSON.stringify(pending), { mode: 0o600 });
  }
  /** Read + delete in one logical step. Crash between read and unlink is bounded
   *  by the daily cap; a duplicate-spawn from a re-read after crash counts twice
   *  against the cap, which is acceptable for V1 (round-3 V9 honest acknowledgement). */
  async consume(hash: string): Promise<PendingSpec | null> {
    const p = join(this.dir, `${hash}.json`);
    let raw: string;
    try {
      raw = await readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: PendingSpec;
    try {
      parsed = JSON.parse(raw) as PendingSpec;
    } catch {
      // Corrupted pending file — remove it, treat as miss.
      await unlink(p).catch(() => undefined);
      return null;
    }
    await unlink(p).catch(() => undefined);
    return parsed;
  }
  /** GC entries older than maxAgeMs. Called once on startup and on a 1h timer. */
  async gc(maxAgeMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const p = join(this.dir, name);
      try {
        const s = await stat(p);
        if (now - s.mtimeMs > maxAgeMs) {
          await unlink(p);
          removed += 1;
        }
      } catch {
        // ignore
      }
    }
    return removed;
  }
}

// ---------------------------------------------------------------------------
// Helper to set up directory layout under <dataDir>/telegram/.
// ---------------------------------------------------------------------------

export interface IntegrationPaths {
  dir: string;
  lock: string;
  state: string;
  audit: string;
  pendingDir: string;
}

export function integrationPaths(dataDir: string): IntegrationPaths {
  const dir = join(dataDir, 'telegram');
  return {
    dir,
    lock: join(dir, 'lock'),
    state: join(dir, 'state.json'),
    audit: join(dir, 'audit.jsonl'),
    pendingDir: join(dir, 'pending'),
  };
}

export async function ensureIntegrationDir(dataDir: string): Promise<IntegrationPaths> {
  const paths = integrationPaths(dataDir);
  await mkdir(paths.dir, { recursive: true });
  return paths;
}
