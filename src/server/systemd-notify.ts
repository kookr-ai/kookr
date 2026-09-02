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

/** Sends one sd_notify variable assignment (e.g. `"READY=1"`). */
export type NotifySender = (payload: string) => void;

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
  /** Sink for send failures. Defaults to `console.warn`. */
  logger?: (msg: string) => void;
}

/**
 * Default sender: fire-and-forget `systemd-notify <payload>`. `systemd-notify`
 * inherits `NOTIFY_SOCKET` from our environment and writes the datagram itself.
 * Failures (e.g. the binary is missing) are logged once per call and never
 * propagate — a notify failure must not take the server down.
 */
function spawnSystemdNotify(payload: string, logger: (msg: string) => void): void {
  execFile('systemd-notify', [payload], (err) => {
    if (err) {
      logger(`[systemd-notify] failed to send ${payload}: ${err.message}`);
    }
  });
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
  const logger = options.logger ?? ((msg: string) => console.warn(msg));
  const send = options.send ?? ((payload: string) => spawnSystemdNotify(payload, logger));

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

  const safeSend = (payload: string): void => {
    // A throwing sender must never break the caller (the liveness tick).
    try {
      send(payload);
    } catch (err) {
      logger(`[systemd-notify] send threw for ${payload}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    enabled,
    watchdogEnabled,
    watchdogIntervalMs,
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
 * Operator-facing projection of the notifier's in-memory arming state (issue
 * #2853). Health and `kookr ops digest` surface this so a remote operator can
 * tell whether process-level watchdog integration is disabled, instead of
 * mistaking a dead-but-unsupervised service for an externally supervised one.
 *
 * Deliberately narrow: it reports only what the process learned from the
 * sd_notify environment at construction. It never queries `systemctl` or the
 * unit — see {@link SystemdNotifierHealthBlock.externalUnitStatus}.
 */
export interface SystemdNotifierHealthBlock {
  readonly schemaVersion: typeof SYSTEMD_NOTIFIER_HEALTH_SCHEMA_VERSION;
  /** Three-way arming state; see {@link SystemdNotifierArming}. */
  readonly arming: SystemdNotifierArming;
  /** True when `NOTIFY_SOCKET` was present — `READY=1` / `WATCHDOG=1` can reach systemd. */
  readonly notificationEnabled: boolean;
  /** True when the watchdog heartbeat is armed and `WATCHDOG=1` pings flow. */
  readonly watchdogArmed: boolean;
  /**
   * Heartbeat cadence in ms (`WATCHDOG_USEC / 2`); `0` when the watchdog is not
   * armed.
   */
  readonly watchdogIntervalMs: number;
  /**
   * Always `'unknown'`. This block reports only PROCESS-LOCAL arming read from
   * the sd_notify environment — it performs no `systemctl` call and no
   * filesystem work — so it cannot, and must not, claim the external service
   * manager is active or that a restart is guaranteed.
   */
  readonly externalUnitStatus: 'unknown';
}

/**
 * Project a {@link SystemdNotifier}'s cheap in-memory arming state into the
 * operator-facing health block (issue #2853). Pure and allocation-cheap: no
 * `systemctl`, no filesystem, no env re-read — safe on the `/api/health` hot
 * path.
 */
export function buildSystemdNotifierHealthBlock(
  notifier: Pick<SystemdNotifier, 'enabled' | 'watchdogEnabled' | 'watchdogIntervalMs'>,
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
    externalUnitStatus: 'unknown',
  };
}
