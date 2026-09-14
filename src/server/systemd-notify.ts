import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * Optional systemd readiness + watchdog notifier (issue #2491).
 *
 * The production server is a bare `node` process. When its event loop wedges,
 * HTTP goes dark but the process stays alive, so `Restart=on-failure` never
 * fires — a hung server looks healthy to systemd. Recovery has to live OUTSIDE
 * the event loop. That is what the systemd watchdog gives us: the unit declares
 * a `WatchdogSec=` deadline, the server keeps pinging `WATCHDOG=1`, and the
 * instant those pings stop (a wedged loop cannot fire its timers) systemd kills
 * and restarts the unit.
 *
 * This helper turns two events into sd_notify(3) datagrams:
 *
 *   - {@link SystemdNotifier.ready}    → `READY=1`, sent once the HTTP listener
 *     is up, so a `Type=notify` unit promotes from "activating" to "active".
 *   - {@link SystemdNotifier.watchdog} → `WATCHDOG=1`, sent from the liveness
 *     tick to prove the event loop is still delivering timers.
 *
 * Node core cannot open an `AF_UNIX` `SOCK_DGRAM` socket (nodejs/node#25972),
 * which is the socket family sd_notify uses, so the datagram is sent by shelling
 * out to the `systemd-notify` helper. Because that helper is a child process
 * rather than the unit's main PID, the unit must set `NotifyAccess=all` for the
 * notification to be accepted.
 *
 * When `NOTIFY_SOCKET` is unset — any non-systemd run: a dev `node
 * dist/server/start.js`, the pid-file/nohup path, the whole test suite — the
 * notifier is inert and every method is a no-op, so the server behaves exactly
 * as it does today.
 */
export interface SystemdNotifier {
  /** True when `NOTIFY_SOCKET` was present at construction (running under a notify unit). */
  readonly enabled: boolean;
  /**
   * True when the watchdog is armed: `NOTIFY_SOCKET` is present, `WATCHDOG_USEC`
   * parses to a positive integer, and (if set) `WATCHDOG_PID` matches this pid.
   */
  readonly watchdogEnabled: boolean;
  /**
   * Minimum gap between `WATCHDOG=1` sends, in milliseconds — half the systemd
   * deadline (`WATCHDOG_USEC / 2`), per the sd_notify(3) recommendation. `0`
   * when the watchdog is not armed.
   */
  readonly watchdogIntervalMs: number;
  /** Snapshot of helper attempts and completions; never proof of external supervision. */
  readonly sendHealth: SystemdNotifySendHealth;
  /** Send `READY=1` once the listener is up. No-op when {@link enabled} is false. */
  ready(): void;
  /**
   * Send `WATCHDOG=1`, throttled to at most once per {@link watchdogIntervalMs}.
   * Drive it from the liveness tick: a healthy loop keeps the pings flowing; a
   * wedged loop stops calling this, which is exactly what trips the watchdog.
   * No-op when {@link watchdogEnabled} is false.
   */
  watchdog(): void;
}

/** Sends one assignment and reports helper completion. Returning alone is not success. */
export type NotifySender = (payload: string, complete: (error?: unknown) => void) => void;

/** Fixed categories exclude helper output, paths, and environment values. */
export type SystemdNotifyError = 'helper-missing' | 'helper-exit' | 'helper-signal' | 'send-error';

/**
 * Process-local evidence shared by readiness and watchdog sends. After the first
 * completion, status reflects the latest completion even while another send runs.
 * Counters stop at JavaScript's largest safe integer (Number.MAX_SAFE_INTEGER)
 * to preserve precise increments. Timestamps are milliseconds since the Unix epoch.
 */
export interface SystemdNotifySendHealth {
  readonly status: 'not-attempted' | 'pending' | 'succeeded' | 'failed';
  readonly attempts: number;
  readonly failures: number;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  /** Retained across recovery, along with the cumulative failure count. */
  readonly lastFailureAt: number | null;
  /** Current failure category; cleared by a successful helper completion. */
  readonly lastError: SystemdNotifyError | null;
}

export interface SystemdNotifierOptions {
  /** Environment to read `NOTIFY_SOCKET` / `WATCHDOG_USEC` / `WATCHDOG_PID` from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Current pid, checked against `WATCHDOG_PID`. Defaults to `process.pid`. */
  pid?: number;
  /** Injectable datagram sender (tests). Defaults to a `systemd-notify` subprocess. */
  send?: NotifySender;
  /**
   * Monotonic clock (ms) for watchdog throttling (tests). Defaults to
   * `performance.now`. Monotonic on purpose: a wall-clock source (`Date.now`)
   * would let a backward NTP step suppress pings until the clock caught back up,
   * which could starve the watchdog on an otherwise-healthy loop.
   */
  now?: () => number;
  /** Wall clock for health timestamps. Defaults to Date.now; never used for throttling. */
  wallNow?: () => number;
  /** Sink for send failures. Defaults to `console.warn`. */
  logger?: (msg: string) => void;
}

/**
 * Default sender: asynchronous `systemd-notify <payload>`. `systemd-notify`
 * inherits `NOTIFY_SOCKET` from our environment and writes the datagram itself.
 * Completion only describes the helper's exit, not the external unit's status.
 */
function spawnSystemdNotify(payload: string, complete: (error?: unknown) => void): void {
  execFile('systemd-notify', [payload], (err) => complete(err));
}

function classifySendError(error: unknown): SystemdNotifyError {
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && error.code === 'ENOENT') return 'helper-missing';
    if ('signal' in error && error.signal) return 'helper-signal';
    if ('code' in error && typeof error.code === 'number') return 'helper-exit';
  }
  return 'send-error';
}

function parsePositiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Build a {@link SystemdNotifier} from the environment. Reads `NOTIFY_SOCKET`
 * (readiness/watchdog transport), `WATCHDOG_USEC` (deadline), and `WATCHDOG_PID`
 * (owning pid) once at construction — matching the sd_watchdog_enabled(3)
 * contract.
 */
export function createSystemdNotifier(options: SystemdNotifierOptions = {}): SystemdNotifier {
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const logger = options.logger ?? ((msg: string) => console.warn(msg));
  const send = options.send ?? spawnSystemdNotify;

  const enabled = typeof env.NOTIFY_SOCKET === 'string' && env.NOTIFY_SOCKET.length > 0;

  // Watchdog arming mirrors sd_watchdog_enabled(3): a positive WATCHDOG_USEC and,
  // when WATCHDOG_PID is present, a match against our own pid (systemd sets it so
  // a re-exec'd child doesn't wrongly assume the parent's watchdog).
  const watchdogUsec = enabled ? parsePositiveInt(env.WATCHDOG_USEC) : null;
  const watchdogPid = env.WATCHDOG_PID !== undefined ? parsePositiveInt(env.WATCHDOG_PID) : null;
  const pidMatches = env.WATCHDOG_PID === undefined || watchdogPid === pid;
  const watchdogEnabled = watchdogUsec !== null && pidMatches;

  // Ping at half the deadline so a single missed tick (a GC pause, a slow
  // reconcile) can never starve the watchdog — the >= 30s default in the unit
  // leaves ample margin above the 5s liveness cadence.
  const watchdogIntervalMs = watchdogEnabled ? Math.floor(watchdogUsec / 1000 / 2) : 0;

  let lastWatchdogAt = Number.NEGATIVE_INFINITY;
  let sendHealth: SystemdNotifySendHealth = {
    status: 'not-attempted', attempts: 0, failures: 0,
    lastAttemptAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
  };

  const safeSend = (payload: string): void => {
    sendHealth = {
      ...sendHealth,
      status: sendHealth.status === 'not-attempted' ? 'pending' : sendHealth.status,
      attempts: Math.min(Number.MAX_SAFE_INTEGER, sendHealth.attempts + 1),
      lastAttemptAt: wallNow(),
    };
    let completed = false;
    const complete = (error?: unknown): void => {
      if (completed) return;
      completed = true;
      if (error != null) {
        const category = classifySendError(error);
        sendHealth = {
          ...sendHealth, status: 'failed',
          failures: Math.min(Number.MAX_SAFE_INTEGER, sendHealth.failures + 1),
          lastFailureAt: wallNow(), lastError: category,
        };
        logger(`[systemd-notify] failed to send ${payload}: ${category}`);
      } else {
        sendHealth = { ...sendHealth, status: 'succeeded', lastSuccessAt: wallNow(), lastError: null };
      }
    };
    // A throwing sender must never break the caller (the liveness tick).
    try {
      send(payload, complete);
    } catch (err) {
      complete(err ?? new Error('sender threw without an error'));
    }
  };

  return {
    enabled,
    watchdogEnabled,
    watchdogIntervalMs,
    get sendHealth(): SystemdNotifySendHealth {
      return { ...sendHealth };
    },
    ready(): void {
      if (!enabled) return;
      safeSend('READY=1');
    },
    watchdog(): void {
      if (!watchdogEnabled) return;
      const t = now();
      if (t - lastWatchdogAt < watchdogIntervalMs) return;
      lastWatchdogAt = t;
      safeSend('WATCHDOG=1');
    },
  };
}

/** Schema tag for the `/api/health` + `kookr ops digest` notifier block (issue #2853). */
export const SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION = 'systemd-notifier.v1';

/**
 * Three-way process-local arming state (issue #2853):
 *   - `'absent'`         → `NOTIFY_SOCKET` was unset; this process is not running
 *     under a `Type=notify` unit, so no readiness/watchdog datagrams are sent.
 *   - `'notifier-only'`  → readiness notifications are armed but the watchdog is
 *     not (`WATCHDOG_USEC` missing/invalid, or `WATCHDOG_PID` names another pid).
 *   - `'watchdog-armed'` → readiness *and* the watchdog heartbeat are armed.
 */
export type SystemdNotifierArming = 'absent' | 'notifier-only' | 'watchdog-armed';

/**
 * Operator-facing projection of the notifier's in-memory state (issue
 * #2853). Health and `kookr ops digest` surface this so a remote operator can
 * tell whether process-level watchdog integration is disabled, instead of
 * mistaking a dead-but-unsupervised service for an externally supervised one.
 *
 * Configuration and helper completions are separate evidence. It never queries
 * `systemctl` or the unit — see {@link SystemdNotifierHealthBlock.externalUnitStatus}.
 */
export interface SystemdNotifierHealthBlock {
  readonly schemaVersion: typeof SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION;
  /** Three-way arming state; see {@link SystemdNotifierArming}. */
  readonly arming: SystemdNotifierArming;
  /** True when `NOTIFY_SOCKET` was present; does not prove notifications arrive. */
  readonly notificationEnabled: boolean;
  /** True when the watchdog heartbeat is configured, regardless of send failures. */
  readonly watchdogArmed: boolean;
  /**
   * Heartbeat cadence in ms (`WATCHDOG_USEC / 2`); `0` when the watchdog is not
   * armed.
   */
  readonly watchdogIntervalMs: number;
  /** Helper completion evidence, separate from configuration and external supervision. */
  readonly sendHealth: SystemdNotifySendHealth;
  /**
   * Always `'unknown'`. This block reports only process-local configuration
   * and helper completions — it performs no `systemctl` call and no
   * filesystem work — so it cannot, and must not, claim the external service
   * manager is active or that a restart is guaranteed.
   */
  readonly externalUnitStatus: 'unknown';
}

/**
 * Project a {@link SystemdNotifier}'s cheap in-memory state into the
 * operator-facing health block (issue #2853). Pure and allocation-cheap: no
 * `systemctl`, no filesystem, no env re-read — safe on the `/api/health` hot
 * path.
 */
export function buildSystemdNotifierHealthBlock(
  notifier: Pick<SystemdNotifier, 'enabled' | 'watchdogEnabled' | 'watchdogIntervalMs' | 'sendHealth'>,
): SystemdNotifierHealthBlock {
  const notificationEnabled = notifier.enabled;
  const watchdogArmed = notifier.watchdogEnabled;
  const arming: SystemdNotifierArming = watchdogArmed
    ? 'watchdog-armed'
    : notificationEnabled
      ? 'notifier-only'
      : 'absent';
  return {
    schemaVersion: SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION,
    arming,
    notificationEnabled,
    watchdogArmed,
    // A non-armed watchdog reports a 0 interval regardless of the notifier's
    // raw field, so the block never advertises a cadence that isn't pinging.
    watchdogIntervalMs: watchdogArmed ? notifier.watchdogIntervalMs : 0,
    sendHealth: notifier.sendHealth,
    externalUnitStatus: 'unknown',
  };
}
