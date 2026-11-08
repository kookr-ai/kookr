/**
 * On-disk record of a task supervision: `<dataDir>/supervisions/<id>/brief.md`
 * and `state.json`. Every write goes through a temp file plus rename so a
 * reader (or a crash) never sees a half-written file. The filesystem is
 * injected so tests can observe the write order without touching disk.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SupervisionTarget {
  taskId: string;
  name: string;
}

export type SupervisionHealth =
  | 'healthy'
  | 'degraded:undeliverable'
  | 'degraded:possibly-hung'
  | 'dead'
  | 'ended';
/**
 * `supervisor-finished`: the supervisor completed or signalled completion-ready.
 * `operator`: the operator ended it, or cancelled/terminated the supervisor task.
 * `launch-failed`: `kookr supervise` never produced a supervisor task.
 */
export type SupervisionEndedReason =
  | 'deadline'
  | 'targets-terminal'
  | 'operator'
  | 'supervisor-finished'
  | 'launch-failed';

/** One supervisor session that has served (part of) the mandate. */
export interface SupervisionEpisode {
  supervisorTaskId: string;
  startedAt: string;
}

/**
 * `state.json`. The first six fields are the P1 shape written by `kookr
 * supervise`; every later field is optional so a P1 file reads unchanged and
 * the P2a wake service fills them in. Timestamps are ISO-8601 strings.
 */
export interface SupervisionState {
  supervisionId: string;
  targets: SupervisionTarget[];
  goals: string[];
  deadlineAt: string;
  createdAt: string;
  supervisorTaskId: string | null;
  /** Next heartbeat wake. Absent on a fresh P1 file: derived as createdAt + heartbeat interval. */
  nextHeartbeatAt?: string;
  /** Set once the deadline wake was typed into the supervisor; the next tick then ends the mandate. */
  deadlineWakeDeliveredAt?: string;
  /**
   * Set BEFORE the deadline wake is typed and never cleared on an ambiguous
   * failure: a crash between send and persist must not deliver it twice ("at most
   * once"). Cleared only when the wake was definitely not sent (refused).
   */
  deadlineWakeAttemptedAt?: string;
  /** Set once the "targets finished" wake was typed; the next tick then ends the mandate. */
  finalWakeDeliveredAt?: string;
  health?: SupervisionHealth;
  /** Supervisor sessions in order, oldest first. */
  episodes?: SupervisionEpisode[];
  /** Fresh episodes started by the watchdog (including failed attempts). */
  restartCount?: number;
  lastRestartAt?: string;
  lastDeliveredAt?: string;
  endedAt?: string;
  endedReason?: SupervisionEndedReason;
  /** First tick of the current run of consecutive undeliverable ticks. */
  undeliverableSince?: string;
  /** Consecutive ticks on which a due wake could not be delivered. */
  undeliverableTicks?: number;
  /**
   * Idempotency key of a replacement supervisor launch that was started but not
   * yet recorded. A later tick adopts the task created under it instead of
   * launching another (crash between launch and persist).
   */
  pendingEpisodeKey?: string;
  /** Monotonic hook-event count of the supervisor session at `supervisorEventAt` (hung detection). */
  supervisorEventCount?: number;
  /** When `supervisorEventCount` last changed. */
  supervisorEventAt?: string;
  /** Last operator-alert reason; suppresses repeats until health recovers. */
  lastAlertReason?: string;
}

export interface SupervisionFs {
  mkdirSync(path: string, opts: { recursive: true }): unknown;
  writeFileSync(path: string, data: string): unknown;
  renameSync(from: string, to: string): unknown;
  rmSync(path: string, opts: { force: true }): unknown;
}

const nodeFs: SupervisionFs = { mkdirSync, writeFileSync, renameSync, rmSync };

const DEFAULT_PORT = 4800;

/**
 * Data directory of the server the CLI talked to, derived the way the server
 * and `resolveKookrDataDir` (kookr-maintenance) do: `~/.kookr` for the default
 * port 4800, `~/.kookr-<port>` otherwise. `KOOKR_DIR` is deliberately ignored
 * because the server ignores it, and the server-side service reads these files.
 * `baseUrl` is the resolved API base; when its port cannot be read (non-numeric
 * or absent) we fall back to `KOOKR_PORT`, then the default directory.
 */
export function resolveDataDir(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string = env.HOME ?? env.USERPROFILE ?? homedir(),
): string {
  let port: number | undefined;
  if (baseUrl) {
    try {
      const raw = new URL(baseUrl).port;
      port = raw === '' ? undefined : Number(raw);
    } catch {
      port = undefined;
    }
  }
  if (port === undefined) {
    const raw = env.KOOKR_PORT?.trim();
    port = raw ? Number(raw) : undefined;
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535 || port === DEFAULT_PORT) {
    return join(home, '.kookr');
  }
  return join(home, `.kookr-${port}`);
}

export function supervisionDir(dataDir: string, supervisionId: string): string {
  return join(dataDir, 'supervisions', supervisionId);
}

/** Write `content` to `path` via `<path>.tmp-<pid>` + rename; the temp file is removed on failure. */
export function writeFileAtomic(path: string, content: string, fs: SupervisionFs = nodeFs): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, path);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort; the original error is the one worth reporting
    }
    throw err;
  }
}

export function writeSupervisionFiles(
  dataDir: string,
  state: SupervisionState,
  brief: string | undefined,
  fs: SupervisionFs = nodeFs,
): string {
  const dir = supervisionDir(dataDir, state.supervisionId);
  fs.mkdirSync(dir, { recursive: true });
  if (brief !== undefined) writeFileAtomic(join(dir, 'brief.md'), brief, fs);
  writeFileAtomic(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, fs);
  return dir;
}

/** Overwrite only `state.json` (atomic). */
export function writeSupervisionState(dataDir: string, state: SupervisionState, fs: SupervisionFs = nodeFs): void {
  writeSupervisionFiles(dataDir, state, undefined, fs);
}

function isState(raw: unknown): raw is SupervisionState {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.supervisionId === 'string'
    && Array.isArray(o.targets)
    && typeof o.deadlineAt === 'string'
    && typeof o.createdAt === 'string';
}

/** Read one supervision's state; undefined when missing or unparseable (a half-written P1 dir is skipped, not fatal). */
export function readSupervisionState(dataDir: string, supervisionId: string): SupervisionState | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(supervisionId)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(supervisionDir(dataDir, supervisionId), 'state.json'), 'utf8'));
    if (!isState(parsed)) return undefined;
    return { ...parsed, supervisorTaskId: typeof parsed.supervisorTaskId === 'string' ? parsed.supervisorTaskId : null };
  } catch {
    return undefined;
  }
}

/** Every readable supervision under `<dataDir>/supervisions`, oldest first. */
export function listSupervisionStates(dataDir: string): SupervisionState[] {
  let names: string[];
  try {
    names = readdirSync(join(dataDir, 'supervisions'));
  } catch {
    return [];
  }
  const out: SupervisionState[] = [];
  for (const name of names) {
    const state = readSupervisionState(dataDir, name);
    if (state) out.push(state);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function readSupervisionBrief(dataDir: string, supervisionId: string): string | undefined {
  try {
    return readFileSync(join(supervisionDir(dataDir, supervisionId), 'brief.md'), 'utf8');
  } catch {
    return undefined;
  }
}

export function supervisionBriefPath(dataDir: string, supervisionId: string): string {
  return join(supervisionDir(dataDir, supervisionId), 'brief.md');
}
