/**
 * Issue #1723: die-with-parent watchdog for the standalone relay process.
 *
 * The relay test harness spawns real `relay/server.(ts|js)` processes (via the
 * production `startRelay` lifecycle, which spawns `detached: true` + `unref()`).
 * When the test runner crashes, times out, or is SIGKILL-ed mid-test, those
 * detached servers are reparented to init and survive forever — the leak that
 * accumulated 533 orphans / ~7.5 GB RSS on 2026-07-30.
 *
 * This module installs an opt-in watchdog that polls `process.ppid` and shuts
 * the relay down the moment its original parent exits (detected as a change in
 * ppid — a reparent to init/pid 1 or to a subreaper). It is a pure-JS,
 * cross-platform substitute for `prctl(PR_SET_PDEATHSIG)` (which Node does not
 * expose) and works even for a `detached`/`unref`-ed child, because reparenting
 * changes the child's ppid regardless of its process group or session.
 *
 * CRITICAL: this MUST stay opt-in (env-gated). Production relays are spawned
 * detached precisely so they OUTLIVE the CLI that launched them — the CLI exits
 * immediately after spawn, so the relay's ppid becomes 1 right away. Enabling
 * the watchdog in production would therefore kill the relay seconds after boot.
 * It is enabled ONLY for the test suite (see vitest.config.ts `env`).
 *
 * Lives in its own module so it can be unit-tested with an injected ppid getter
 * and timer, without importing `server.ts`'s main-entry listen side effect.
 */
import { readFileSync } from 'node:fs';

/**
 * Read the CURRENT parent pid. `process.ppid` is evaluated once at startup and
 * cached by Node, so it does NOT update when the process is reparented after
 * its parent dies — exactly the event this watchdog must detect. On Linux we
 * therefore read the live ppid from `/proc/self/stat` (field 4, after the
 * paren-wrapped `comm`). On other platforms we fall back to `process.ppid`
 * (best effort; the watchdog is only enabled in the Linux test suite).
 */
export function readLivePpid(): number {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      const rparen = stat.lastIndexOf(')');
      if (rparen >= 0) {
        const fields = stat.slice(rparen + 2).split(' ');
        const ppid = Number.parseInt(fields[1] ?? '', 10);
        if (Number.isInteger(ppid)) return ppid;
      }
    } catch {
      // /proc unavailable — fall through to the cached value.
    }
  }
  return process.ppid;
}

export interface DieWithParentConfig {
  /** Whether the watchdog should run at all. */
  enabled: boolean;
  /** Poll interval in ms. */
  intervalMs: number;
  /**
   * The pid the launcher declared as the parent to watch (via
   * `KOOKR_RELAY_PARENT_PID`), or `undefined` to fall back to the live ppid read
   * at install time. Declaring it explicitly closes a boot-race: if the parent
   * dies while the relay is still starting up, a live ppid read would capture
   * the post-reparent value and the watchdog would never see a change.
   */
  expectedPpid?: number;
}

/** Default watchdog poll interval. */
export const DEFAULT_DIE_WITH_PARENT_INTERVAL_MS = 1_000;

/**
 * Parse the die-with-parent gating env. Disabled unless
 * `KOOKR_RELAY_DIE_WITH_PARENT` is `1`/`true`. The poll interval can be tuned
 * with `KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS` (positive integer; defaults to
 * {@link DEFAULT_DIE_WITH_PARENT_INTERVAL_MS}).
 */
export function readDieWithParentConfig(
  env: NodeJS.ProcessEnv = process.env,
): DieWithParentConfig {
  const raw = env.KOOKR_RELAY_DIE_WITH_PARENT?.trim();
  const enabled = raw === '1' || raw === 'true';
  const intervalRaw = env.KOOKR_RELAY_DIE_WITH_PARENT_INTERVAL_MS?.trim();
  const parsed = intervalRaw ? Number.parseInt(intervalRaw, 10) : NaN;
  const intervalMs =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DIE_WITH_PARENT_INTERVAL_MS;
  const parentRaw = env.KOOKR_RELAY_PARENT_PID?.trim();
  const parentParsed = parentRaw ? Number.parseInt(parentRaw, 10) : NaN;
  const expectedPpid =
    Number.isInteger(parentParsed) && parentParsed > 1 ? parentParsed : undefined;
  return { enabled, intervalMs, ...(expectedPpid !== undefined ? { expectedPpid } : {}) };
}

export interface DieWithParentOptions {
  /** Poll interval in ms. Default {@link DEFAULT_DIE_WITH_PARENT_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * The parent pid to watch. When provided (the launcher declared it via
   * `KOOKR_RELAY_PARENT_PID`), the watchdog trips as soon as the live ppid
   * differs from it — even if the parent already died during startup. When
   * omitted, the initial ppid is read live at install time.
   */
  expectedPpid?: number;
  /**
   * Returns the current parent pid. Injectable for tests; defaults to
   * {@link readLivePpid} (live `/proc/self/stat` read on Linux), NOT the cached
   * `process.ppid`.
   */
  getPpid?: () => number;
  /**
   * Fired exactly once when the original parent is detected to have exited
   * (ppid changed away from its initial value). The wiring in `server.ts`
   * routes this into the graceful relay shutdown handler.
   */
  onParentExit: (info: { initialPpid: number; currentPpid: number }) => void;
  // Handles are opaque (`unknown`): setInterval returns NodeJS.Timeout under the
  // server tsconfig but `number` under the DOM-lib E2E tsconfig, so a concrete
  // type would not typecheck in both.
  /** Injectable interval scheduler (tests). Defaults to `setInterval`. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  /** Injectable interval canceller (tests). Defaults to `clearInterval`. */
  clearIntervalFn?: (handle: unknown) => void;
}

export interface DieWithParentHandle {
  /**
   * Run one poll tick synchronously. Returns `true` if the parent-exit
   * condition was detected on this (or a previous) tick. Exposed for tests;
   * the interval calls it internally.
   */
  check(): boolean;
  /** Stop polling. Idempotent. */
  stop(): void;
  /** The parent pid captured at install time. */
  readonly initialPpid: number;
}

/**
 * Install a die-with-parent watchdog. Polls `getPpid()` every `intervalMs`; the
 * first time the parent pid differs from the one captured at install, it fires
 * `onParentExit` once and stops polling.
 *
 * If the initial ppid is already `<= 1` (the relay was started as a direct
 * child of init — e.g. a production detached relay whose launcher already
 * exited), there is no meaningful parent to watch, so the watchdog never trips.
 * That is a defensive backstop only; production never enables the watchdog.
 */
export function installDieWithParentWatchdog(
  options: DieWithParentOptions,
): DieWithParentHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_DIE_WITH_PARENT_INTERVAL_MS;
  const getPpid = options.getPpid ?? readLivePpid;
  const setIntervalFn: (fn: () => void, ms: number) => unknown =
    options.setIntervalFn ?? setInterval;
  const clearIntervalFn: (handle: unknown) => void =
    options.clearIntervalFn ?? (clearInterval as unknown as (handle: unknown) => void);

  const initialPpid = options.expectedPpid ?? getPpid();
  let handle: unknown = null;
  let tripped = false;
  let stopped = false;

  function stop(): void {
    stopped = true;
    if (handle !== null) {
      clearIntervalFn(handle);
      handle = null;
    }
  }

  function check(): boolean {
    if (tripped) return true;
    if (stopped) return false;
    // No watchable parent (already reparented to init at install) — never trip.
    if (!Number.isInteger(initialPpid) || initialPpid <= 1) return false;
    const currentPpid = getPpid();
    if (currentPpid !== initialPpid) {
      tripped = true;
      stop();
      options.onParentExit({ initialPpid, currentPpid });
      return true;
    }
    return false;
  }

  if (Number.isInteger(initialPpid) && initialPpid > 1) {
    handle = setIntervalFn(() => {
      check();
    }, intervalMs);
    // Never keep the process alive solely to run this watchdog.
    if (handle && typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as { unref: () => void }).unref();
    }
  }

  return {
    check,
    stop,
    initialPpid,
  };
}
