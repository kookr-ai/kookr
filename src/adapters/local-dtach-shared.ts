/**
 * Shared constants, types, and pure helpers for LocalDtachBackend.
 *
 * Split from local-dtach-backend.ts (kookr-ai/kookr#1465).
 */
import type { IPty } from 'node-pty';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import type { SessionId } from './terminal-backend.js';
import type { DtachRingState } from './dtach-ring-store.js';

export const PENDING_TTL_MS = 10_000;
/**
 * Caps session-ID length so the resulting socket path stays within the
 * platform's `sun_path` limit (108 bytes on Linux, 104 on macOS — both
 * including the trailing NUL, so 107 / 103 usable). The default base path
 * is `/tmp/kookr-dtach/<uid>/<instanceId>/`, which on a typical install is
 * ~31 chars, leaving ~72 / ~68 characters for the session ID — far above
 * 40 even on macOS.
 */
export const DEFAULT_MAX_SESSION_ID_LEN = 40;
/** Bytes available in `sun_path` (excluding NUL) per platform. */
export const SUN_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;
export const KILL_WAIT_SECONDS = 10;
export const DEFAULT_WRITE_TIMEOUT_MS = 2_000;
export const REATTACH_WINDOW_MS = 60_000;
export const REATTACH_CAP = 3;
/**
 * Reconnect-transport policy (kookr-ai/kookr#1347). A manual transport repair
 * is rarer than a crash re-attach, so the window/cap are separate from the
 * lazy-reattach ones above. `COOLDOWN` rejects rapid double-clicks that slip
 * past in-flight collapse (a click after the prior attempt already resolved);
 * `CAP` per `WINDOW` rejects a storm.
 */
export const DEFAULT_RECONNECT_LIVENESS_TIMEOUT_MS = 1_500;
export const RECONNECT_COOLDOWN_MS = 2_000;
export const RECONNECT_WINDOW_MS = 60_000;
export const RECONNECT_CAP = 3;
/** Default hard cap for a secondary-attach current-frame snapshot. */
export const DEFAULT_FRAME_SNAPSHOT_TIMEOUT_MS = 800;
/** Quiet period after the last byte that ends a frame snapshot. */
export const DEFAULT_FRAME_SNAPSHOT_QUIET_MS = 40;
/**
 * Minimum time to keep collecting after the first byte. Prevents finishing on
 * dtach's leading `ESC[H ESC[J` chunk before the rest of the screen dump arrives.
 */
export const DEFAULT_FRAME_SNAPSHOT_MIN_HOLD_MS = 120;
/**
 * Post-restart recovery policy (kookr-ai/kookr#1345).
 *
 * `GRACE_WINDOW` is how long a recovered session is observed for a fresh byte
 * before it is classified. It is deliberately longer than the reconnect
 * liveness timeout: a mid-turn agent may pause briefly between tool calls, and
 * the false-healthy state this guards against is silence measured in seconds,
 * not sub-second gaps. `MAX_REPAIRS` bounds the internal-attach recycles per
 * verification so a permanently-wedged transport cannot spin an attach storm —
 * one initial attach plus at most this many fresh attaches, then the session is
 * surfaced as `recovered-unverified` instead of being retried forever.
 */
export const DEFAULT_RECOVERY_GRACE_WINDOW_MS = 1_500;
export const DEFAULT_RECOVERY_MAX_REPAIRS = 2;
/**
 * On attach, dtach replays its saved screen buffer to the new client — a
 * one-shot burst that is NOT evidence the hosted agent is making progress. If
 * that redraw were counted as liveness, a freshly-opened (or fresh-but-wedged)
 * attach that only replays its stale screen would be misclassified live and the
 * false-healthy state this feature targets would go undetected. So the recovery
 * probe lets the redraw flush for this settle window, snapshots the ring head,
 * then measures whether *new* bytes keep arriving — genuine agent progress —
 * over the grace window. Bounded well under the grace window.
 */
export const DEFAULT_RECOVERY_SETTLE_MS = 250;
/**
 * How often to persist each session's ring buffer to disk. The periodic flush
 * is the primary mechanism that lets a restarted Kookr rebuild the scrollback
 * for sessions whose dtach master survived the restart (most commonly after
 * `pnpm prod:update` / `pnpm prod:restart`). On startup the master is still
 * running and its hosted TUI is idle, so no new bytes arrive to repopulate the
 * ring — without persistence, browser attach sees a blank viewport.
 */
export const RINGS_DIRNAME = 'rings';

/** Per-session in-memory state owned by the backend. */
export interface AttachedSession extends DtachRingState {
  sock: string;
  /** Current attach child; null while transiently detached after a crash. */
  pty: IPty | null;
  /** Byte subscribers. */
  dataSubscribers: Set<(data: Uint8Array, source?: TerminalSessionDataSource) => void>;
  /** Writer-mutex tail — chained Promise that sequences write/writeSequence. */
  writeMutex: Promise<void>;
  /** Count of callers currently queued or executing under `writeMutex`. */
  pendingWriters: number;
  /** Timestamps of recent re-attach attempts, used to enforce the 3-per-60s cap. */
  reattachWindow: number[];
  /** Cumulative count of re-attaches since session creation. */
  reattachCount: number;
  /**
   * Last known PTY size. Remembered so the backend can reapply it when the
   * attach child is respawned after a crash, keeping the TUI viewport stable
   * instead of snapping back to the 80x24 node-pty default. `null` until the
   * first create or resize supplies one.
   */
  currentSize: { cols: number; rows: number } | null;
  /** Timestamp when the current attach generation was opened. */
  lastAttachAt: number | null;
  /** Ignore the one-shot dtach redraw while rebuilding an existing attach. */
  attachReplayUntil: number;
  /** First non-empty chunk from explicit recovery is replay, even if delayed. */
  attachReplayPending: boolean;
  /**
   * Disposes the current attach child's `onData`/`onExit` listeners. Called
   * before `pty.kill()` on every teardown so a just-killed attach cannot fan
   * trailing bytes into the shared ring / subscribers — which would otherwise
   * let a disposed generation's teardown bytes count as the NEXT generation's
   * fresh-liveness signal (kookr-ai/kookr#1347). `null` while detached.
   */
  disposePtyListeners: (() => void) | null;
  /**
   * Monotonic counter of internal attach children opened for this session.
   * Bumped by `attachPtyInto` on every (re)attach. Reported by
   * `reconnectTransport` as the old/new "attach generation" so an operator can
   * see the transport was actually rebuilt.
   */
  attachGeneration: number;
}

/** Mutable accumulator threaded through `performReconnect` into the result. */
export interface ReconnectBase {
  identityVerified: boolean;
  masterPid: number;
  agentPid: number | null;
  previousGeneration: number;
  newGeneration: number;
  livenessWaitedMs: number;
}

export interface LocalDtachBackendOptions {
  /**
   * Where to store per-instance sockets + manifest. Defaults to
   * /tmp/kookr-dtach/<uid>/<instanceId>/.
   */
  socketDir?: string;

  /** Unique id for this Kookr instance. */
  instanceId?: string;

  /** Path to the dtach binary. Defaults to `dtach` on PATH. */
  dtachBinary?: string;

  /** Override write timeout for tests that want to assert the rejection quickly. */
  writeTimeoutMs?: number;

  /**
   * Override the per-session ring-buffer flush interval. Tests use a short
   * value so they don't have to sleep through the production cadence.
   */
  ringFlushIntervalMs?: number;

  /**
   * Override the reconnect-transport cooldown (ms). Tests set a small value so
   * they can assert the cooldown rejection without a real 2 s sleep.
   */
  reconnectCooldownMs?: number;

  /**
   * Fleet-wide sum of live ring buffer capacities (issue #1779). When the sum
   * exceeds this budget, least-recently-active rings shrink to 64 KiB. `0`
   * disables enforcement. Production reads `KOOKR_RING_FLEET_BUDGET_BYTES`
   * (default 32 MiB).
   */
  ringFleetBudgetBytes?: number;
}

/**
 * Build the argv for spawning a dtach master that must outlive Kookr.
 *
 * Linux/BSD: wrap in `setsid -f` so the master gets a brand-new session and
 * forks into the background, fully detached from Kookr's process group.
 *
 * macOS: `setsid` is util-linux-only and is not shipped on macOS (and the
 * hand-ported builds users compile frequently lack the `-f` flag), so a
 * literal `setsid -f` either ENOENTs or rejects the flag — the dtach master
 * never starts and the socket never appears. We therefore spawn dtach
 * directly there: `dtach -n` already daemonizes, and the caller passes
 * `detached: true`, which runs the child through `setsid(2)` for the same
 * new-session detachment. See docs/adr/014-local-dtach-backend.md and the
 * "dtach socket did not appear" entry in docs/troubleshooting.md.
 */
export function buildDtachSpawn(
  platform: NodeJS.Platform,
  dtachBinary: string,
  dtachArgs: string[],
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: dtachBinary, args: dtachArgs };
  }
  return { command: 'setsid', args: ['-f', dtachBinary, ...dtachArgs] };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
