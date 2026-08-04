// src/server/prod-smoke-tick.ts — hourly in-process prod smoke tick (issue #1593).
//
// The post-deploy smoke suite (issue #1592, scripts/prod-smoke.ts +
// src/server/prod-smoke.ts) only runs at deploy time. A wedge that develops
// *while the server runs* — the #1543 /api/health hang that sat undetected for
// ~21h before a human found it with one `curl --max-time 10` — needs a periodic
// live check. This module runs the SAME bounded checks against the live prod
// instance on an hourly cadence and files/updates a single operational alert
// artifact on failure, so the 21h-undetected scenario becomes structurally
// impossible: no tick can pass while a bounded /api/health probe would time out,
// because the tick IS that bounded probe and a timeout resolves to a failing
// check (never a pass), including a hard overall deadline as a last-resort
// backstop.
//
// Detection scope (honest): this catches a hung/slow *handler* while the rest
// of the event loop still turns (the #1543 class) — the bounded fetch aborts
// client-side via AbortSignal.timeout even if the handler never returns. A
// fully CPU-wedged event loop would also starve this in-process tick, but that
// failure mode kills every route at once and is covered by the startup /
// systemd liveness gate, not this hourly wedge detector.
//
// No agent is spawned for the happy path — this is a cheap in-process tick
// hosted by the server's periodic-timer infrastructure (lifecycle-timers.ts).

import { join } from 'node:path';

import type { OpsStatusEdgeKind } from '../core/ops-status.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  buildAlertArtifact,
  formatDuration,
  mergeAlertArtifact,
  readAlertArtifact,
  resolveConfig as resolveSmokeConfig,
  runSmokeChecks,
  writeAlertArtifact,
  type AlertArtifact,
  type CheckResult,
  type SmokeConfig,
} from './prod-smoke.js';

/** Ops-status edge kinds the smoke tick may record (issue #2032). */
export type SmokeTickOpsEdgeKind = Extract<OpsStatusEdgeKind, 'smoke_tick_fire' | 'smoke_tick_clear'>;

/**
 * Best-effort hook for durable ops-status.json edges on smoke fire/clear.
 * Implementations must not throw (OpsStatusWriter.noteEdge already swallows).
 */
export type NoteSmokeTickOpsEdge = (
  kind: SmokeTickOpsEdgeKind,
  detail?: string,
) => void | Promise<unknown>;

/** Stable operational-alert key so repeated failures dedup into one episode. */
export const PROD_SMOKE_TICK_ALERT_KEY = 'smoke:hourly';
/** Operator-facing metric identifier for the operational alert. */
export const PROD_SMOKE_TICK_ALERT_METRIC = 'prod_smoke_tick';
/** Default cadence: once an hour (AC1 — an alert appears within one hour). */
export const DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS = 60 * 60_000;
/**
 * Slack subtracted from the cadence threshold so timer jitter can never skip an
 * on-schedule fire. The host `setInterval` cadence equals `intervalMs`, and the
 * gate anchors to the fire START (see {@link ProdSmokeTick.maybeRun}), so
 * consecutive on-grid fires are ~`intervalMs` apart; without this slack a
 * sub-millisecond-early fire (or clock granularity) could round just under the
 * threshold and drop the run, halving the effective detection cadence. 1s is far
 * above real timer jitter and far below the minimum configurable interval (1m).
 */
export const CADENCE_TOLERANCE_MS = 1_000;

/** Path of the hourly-tick alert artifact. Deliberately distinct from the
 * deploy-gate's `prod-smoke-alert.json` so a deploy and the hourly tick never
 * clobber each other's failing-streak continuity. */
export function prodSmokeTickAlertPath(kookrDir: string): string {
  return join(kookrDir, 'prod-smoke-tick-alert.json');
}

/**
 * Operator-facing health projection of the hourly prod smoke tick (issue #2031).
 * Projected on `GET /api/health.prodSmokeTick` so offline operators / remote
 * probes can see consecutiveFailures + failingChecks without filesystem access.
 * Built from the durable alert artifact only — never re-runs smoke checks.
 */
export const PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION = 'prod-smoke-tick.v1' as const;

export interface ProdSmokeTickHealthSnapshot {
  schemaVersion: typeof PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION;
  /**
   * Artifact status when present; `unknown` when the tick is enabled but no
   * readable artifact exists yet (first hour after enable / clean data dir).
   */
  status: 'ok' | 'alert' | 'unknown';
  consecutiveFailures: number;
  failingChecks: string[];
  /** ISO timestamp of the latest artifact write, when an artifact exists. */
  generatedAt?: string;
  /** ISO timestamp when the current failing streak began, when status is alert. */
  firstFailedAt?: string;
}

/**
 * Project a health snapshot from a previously-read alert artifact.
 * Pure; never touches disk or re-runs checks. Null artifact → null-safe empty.
 */
export function buildProdSmokeTickHealthSnapshot(
  artifact: AlertArtifact | null,
): ProdSmokeTickHealthSnapshot {
  if (!artifact) {
    return {
      schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
      status: 'unknown',
      consecutiveFailures: 0,
      failingChecks: [],
    };
  }
  return {
    schemaVersion: PROD_SMOKE_TICK_HEALTH_SCHEMA_VERSION,
    status: artifact.status,
    consecutiveFailures: artifact.consecutiveFailures ?? 0,
    failingChecks: [...artifact.failingChecks],
    generatedAt: artifact.generatedAt,
    ...(artifact.firstFailedAt ? { firstFailedAt: artifact.firstFailedAt } : {}),
  };
}

/**
 * Build the edge-triggered operational-alert message for a state transition.
 * `fired` on healthy→failing, `recovered` on failing→healthy. The stable
 * `operationalAlert.key` lets the dashboard correlate a fire with its recovery
 * instead of treating each hourly failing tick as a brand-new alert.
 */
export function buildSmokeTickAlertMessage(
  artifact: AlertArtifact,
  state: 'fired' | 'recovered',
  alertPath: string,
): ServerMessage {
  if (state === 'recovered') {
    return {
      type: 'alert',
      agentId: '',
      summary: 'Prod smoke tick recovered',
      details: `All hourly prod smoke checks pass again. Artifact: ${alertPath}`,
      severity: 'info',
      operationalAlert: { key: PROD_SMOKE_TICK_ALERT_KEY, metric: PROD_SMOKE_TICK_ALERT_METRIC, state: 'recovered' },
    };
  }
  const failing = artifact.failingChecks.join(', ') || 'unknown';
  const streak = artifact.consecutiveFailures ?? 1;
  const since = artifact.firstFailedAt ?? artifact.generatedAt;
  return {
    type: 'alert',
    agentId: '',
    summary: `Prod smoke tick failing: ${failing}`,
    details:
      `Hourly prod smoke check failed (${streak} consecutive since ${since}). ` +
      `Failing check(s): ${failing}. Artifact: ${alertPath}`,
    severity: 'critical',
    operationalAlert: { key: PROD_SMOKE_TICK_ALERT_KEY, metric: PROD_SMOKE_TICK_ALERT_METRIC, state: 'fired' },
  };
}

export interface ProdSmokeTickDeps {
  /** Kookr data dir — derives the default tick alert artifact path. */
  kookrDir: string;
  /** Broadcast a fire/recover operational alert. Absent in tests without a bus. */
  broadcast?: (msg: ServerMessage) => void;
  /**
   * Record durable ops-status.json edges on fire/clear (issue #2032).
   * Invoked on the same edge-trigger as {@link broadcast} (once per episode).
   * Fire detail is the failingChecks list (no secrets).
   */
  noteOpsEdge?: NoteSmokeTickOpsEdge;
  /** Minimum spacing between runs; a fire is skipped if the last one is newer. */
  intervalMs?: number;
  /** Env used to resolve the underlying smoke config (URLs/bounds). */
  env?: NodeJS.ProcessEnv;
  /** Explicit alert-artifact path override (defaults to {@link prodSmokeTickAlertPath}). */
  alertPath?: string;
  // --- test seams (all default to the real implementations) ---
  resolveConfig?: (env: NodeJS.ProcessEnv) => SmokeConfig;
  runChecks?: (config: SmokeConfig) => Promise<CheckResult[]>;
  readArtifact?: (path: string) => AlertArtifact | null;
  writeArtifact?: (path: string, artifact: AlertArtifact) => void;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Stateful hourly smoke tick. One instance per server; the host periodic timer
 * calls {@link maybeRun} on its interval. Guards against pile-up (a still-running
 * tick is skipped) and enforces its own minimum cadence, so it is safe to host
 * on a faster tick than the configured interval.
 */
export class ProdSmokeTick {
  private running = false;
  /** Edge-trigger flag: true while an alert episode is active (fired, not yet recovered). */
  private firing = false;
  /** Whether {@link firing} has been seeded from the durable artifact yet (first run). */
  private firingSeeded = false;
  private lastRunAtMs = Number.NEGATIVE_INFINITY;

  private readonly intervalMs: number;
  private readonly alertPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly broadcast?: (msg: ServerMessage) => void;
  private readonly noteOpsEdge?: NoteSmokeTickOpsEdge;
  private readonly resolveConfig: (env: NodeJS.ProcessEnv) => SmokeConfig;
  private readonly runChecks: (config: SmokeConfig) => Promise<CheckResult[]>;
  private readonly readArtifact: (path: string) => AlertArtifact | null;
  private readonly writeArtifact: (path: string, artifact: AlertArtifact) => void;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(deps: ProdSmokeTickDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS;
    this.alertPath = deps.alertPath ?? prodSmokeTickAlertPath(deps.kookrDir);
    this.env = deps.env ?? process.env;
    this.broadcast = deps.broadcast;
    this.noteOpsEdge = deps.noteOpsEdge;
    this.resolveConfig = deps.resolveConfig ?? resolveSmokeConfig;
    this.runChecks = deps.runChecks ?? runSmokeChecks;
    this.readArtifact = deps.readArtifact ?? readAlertArtifact;
    this.writeArtifact = deps.writeArtifact ?? writeAlertArtifact;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? console;
  }

  /** Cadence the host timer should fire at to honour the configured interval. */
  get hostIntervalMs(): number {
    return this.intervalMs;
  }

  get alertArtifactPath(): string {
    return this.alertPath;
  }

  /**
   * Cheap health projection for GET /api/health (issue #2031).
   * Reads the durable alert artifact only — never re-runs smoke checks.
   */
  getHealthSnapshot(): ProdSmokeTickHealthSnapshot {
    return buildProdSmokeTickHealthSnapshot(this.readArtifact(this.alertPath));
  }

  /**
   * Run one tick if due and not already running. NEVER throws — a failure is
   * logged and swallowed so it can never crash the host interval callback.
   * Returns the artifact written, or null when the run was skipped (pile-up
   * guard or cadence gate).
   */
  async maybeRun(): Promise<AlertArtifact | null> {
    if (this.running) {
      this.logger.warn('[prod-smoke-tick] previous tick still running; skipping this fire');
      return null;
    }
    const startMs = this.now();
    // Anchor the cadence to the fire START, not the run's end. The host timer
    // and this threshold share `intervalMs`, and `setInterval` fires ~on a fixed
    // grid; if we measured from run-end (start + run duration) every other fire
    // would fall `runDuration` short of the threshold and be dropped, doubling
    // detection latency and breaking AC1's within-one-hour guarantee. Measuring
    // fire-to-fire (minus a jitter tolerance) keeps every scheduled fire.
    if (startMs - this.lastRunAtMs < this.intervalMs - CADENCE_TOLERANCE_MS) return null;

    this.running = true;
    this.lastRunAtMs = startMs;
    try {
      return await this.runOnce(startMs);
    } catch (err) {
      this.logger.error('[prod-smoke-tick] tick failed:', err);
      return null;
    } finally {
      this.running = false;
    }
  }

  private async runOnce(startMs: number): Promise<AlertArtifact> {
    // Reuse the deploy-gate config for URLs/bounds, but point the artifact at
    // the tick-specific path and disable the deploy-only log-continuity anchor
    // (a running instance has no pre-deploy mtime to compare against).
    const base = this.resolveConfig(this.env);
    const config: SmokeConfig = { ...base, alertPath: this.alertPath, previousLogMtimeMs: null };

    const checks = await this.runChecksBounded(config);
    const prev = this.readArtifact(this.alertPath);
    // Seed the edge-trigger from the durable artifact on the first run of this
    // process: if a restart lands mid-episode (prior artifact still `alert`),
    // treat the episode as already-fired so a still-failing tick updates the
    // artifact without re-broadcasting a duplicate `fired`. A recovery after
    // such a restart still emits exactly one `recovered`.
    if (!this.firingSeeded) {
      this.firing = prev?.status === 'alert';
      this.firingSeeded = true;
    }
    const built = buildAlertArtifact(checks, new Date(startMs).toISOString());
    const artifact = mergeAlertArtifact(prev, built);
    this.writeArtifact(this.alertPath, artifact);

    if (artifact.status === 'alert') {
      this.logger.warn(
        `[prod-smoke-tick] FAIL (${artifact.consecutiveFailures} consecutive): ${artifact.failingChecks.join(', ')} ` +
          `— artifact ${this.alertPath}`,
      );
      // Edge-trigger: fire once per episode, so a sustained outage updates the
      // one artifact each tick but does not re-broadcast every hour. Same edge
      // gates the durable ops-status card (issue #2032).
      if (!this.firing) {
        this.firing = true;
        this.broadcast?.(buildSmokeTickAlertMessage(artifact, 'fired', this.alertPath));
        // failingChecks only — check names, never paths/tokens/secrets.
        const failingDetail = artifact.failingChecks.join(', ');
        void this.noteOpsEdge?.(
          'smoke_tick_fire',
          failingDetail.length > 0 ? failingDetail : undefined,
        );
      }
    } else {
      this.logger.log('[prod-smoke-tick] all checks passed');
      if (this.firing) {
        this.firing = false;
        this.broadcast?.(buildSmokeTickAlertMessage(artifact, 'recovered', this.alertPath));
        void this.noteOpsEdge?.('smoke_tick_clear');
      }
    }
    return artifact;
  }

  /**
   * Run the checks with a hard overall deadline. Each check already bounds
   * itself, but this backstop guarantees {@link maybeRun} completes within a
   * budget (AC3) AND that a set of checks which somehow all hang resolves to a
   * FAILING artifact rather than never settling — so the tick can never pass
   * while a bounded probe would time out (AC2).
   */
  private async runChecksBounded(config: SmokeConfig): Promise<CheckResult[]> {
    const timeoutMs = config.overallTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CheckResult[]>((resolve) => {
      timer = setTimeout(() => {
        resolve([
          {
            name: 'overall-timeout',
            ok: false,
            detail: `smoke tick exceeded its hard overall deadline of ${formatDuration(timeoutMs)}`,
          },
        ]);
      }, timeoutMs);
    });
    const checks = this.runChecks(config);
    // runSmokeChecks never rejects (every check try/catches into a CheckResult),
    // but a custom seam could — attach a no-op handler so a late rejection that
    // loses the race to the deadline can never surface as an unhandled rejection.
    checks.catch(() => {});
    try {
      return await Promise.race([checks, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Resolve whether the hourly tick is enabled and its interval from the
 * environment. Enabled by default ONLY on the canonical prod port (4800) so a
 * fresh deploy is protected with no operational change, while dev servers
 * (4801) and the test suite stay silent. `KOOKR_PROD_SMOKE_TICK` forces it on
 * (`1`/`true`) or off (`0`/`false`); `KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES`
 * overrides the cadence (a non-positive value disables the tick).
 */
export function resolveProdSmokeTickSettings(
  env: NodeJS.ProcessEnv,
  port: number | string,
  logger: Pick<Console, 'warn'> = console,
): { enabled: boolean; intervalMs: number } {
  const intervalMinutesRaw = env.KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES?.trim();
  let intervalMs = DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS;
  let intervalDisables = false;
  if (intervalMinutesRaw !== undefined && intervalMinutesRaw !== '') {
    const minutes = Number(intervalMinutesRaw);
    if (Number.isFinite(minutes)) {
      // An explicit non-positive value is the documented disable signal.
      if (minutes > 0) intervalMs = minutes * 60_000;
      else intervalDisables = true;
    } else {
      // A malformed value (typo like `60m`/`1h`) must NOT silently turn a
      // monitoring feature dark — fall back to the default cadence and warn.
      logger.warn(
        `[prod-smoke-tick] ignoring malformed KOOKR_PROD_SMOKE_TICK_INTERVAL_MINUTES=` +
          `"${intervalMinutesRaw}"; using the default ${DEFAULT_PROD_SMOKE_TICK_INTERVAL_MS / 60_000}m cadence`,
      );
    }
  }

  const flag = env.KOOKR_PROD_SMOKE_TICK?.trim().toLowerCase();
  let enabled: boolean;
  if (flag !== undefined && flag !== '') {
    enabled = flag !== '0' && flag !== 'false' && flag !== 'off' && flag !== 'no';
  } else {
    enabled = String(port) === '4800';
  }

  return { enabled: enabled && !intervalDisables, intervalMs };
}

/**
 * Build a {@link ProdSmokeTick} from the environment, or return undefined when
 * the tick is disabled (dev/test, or explicitly turned off). Bootstrap passes
 * the result to the lifecycle timers; a `undefined` result means no interval is
 * ever started.
 */
export function createProdSmokeTickFromEnv(deps: {
  env: NodeJS.ProcessEnv;
  port: number | string;
  kookrDir: string;
  broadcast?: (msg: ServerMessage) => void;
  /** Durable ops-status edges on fire/clear (issue #2032). */
  noteOpsEdge?: NoteSmokeTickOpsEdge;
}): ProdSmokeTick | undefined {
  const { enabled, intervalMs } = resolveProdSmokeTickSettings(deps.env, deps.port);
  if (!enabled) return undefined;
  return new ProdSmokeTick({
    kookrDir: deps.kookrDir,
    env: deps.env,
    intervalMs,
    ...(deps.broadcast ? { broadcast: deps.broadcast } : {}),
    ...(deps.noteOpsEdge ? { noteOpsEdge: deps.noteOpsEdge } : {}),
  });
}
