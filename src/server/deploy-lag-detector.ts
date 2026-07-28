// src/server/deploy-lag-detector.ts — scheduled deploy-lag detector (issue #1594).
//
// Runs the pure lag evaluation in `deploy-lag.ts` against every configured prod
// on a cheap in-process tick and files/updates a SINGLE operational-alert
// artifact when merged commits sit undeployed past the threshold. Structurally
// a sibling of the hourly smoke tick (`prod-smoke-tick.ts`): same re-entrancy
// guard, cadence gate, hard overall deadline, durable streak dedup, and
// edge-triggered fire/recover broadcast — so a persisting lag updates one
// artifact rather than filing a fresh alert every tick (AC5).
//
// It ONLY alerts. There is deliberately no deploy seam anywhere in this module
// or its resolvers — `prod:update` stays operator-triggered (AC4).

import { join } from 'node:path';

import type { ServerMessage } from '../shared/contracts/messages.js';
import {
  buildAlertArtifact,
  mergeAlertArtifact,
  readAlertArtifact,
  writeAlertArtifact,
  type AlertArtifact,
  type CheckResult,
} from './prod-smoke.js';
import {
  DEFAULT_DEPLOY_LAG_THRESHOLD_MS,
  defaultGitReader,
  defaultStatusFetcher,
  diffAgainstMain,
  evaluateDeployLag,
  extractGitSha,
  resolveDeployLagConfig,
  targetResultToCheckResult,
  type DeployLagConfig,
  type DeployLagTargetResult,
  type DeployLagTargetSnapshot,
  type GitReader,
  type StatusFetcher,
} from './deploy-lag.js';

/** Stable operational-alert key so repeated lag ticks dedup into one episode. */
export const DEPLOY_LAG_ALERT_KEY = 'deploy:lag';
/** Operator-facing metric identifier for the operational alert. */
export const DEPLOY_LAG_ALERT_METRIC = 'deploy_lag';
/** Default cadence: once an hour (can share the hourly smoke tick's rhythm). */
export const DEFAULT_DEPLOY_LAG_INTERVAL_MS = 60 * 60_000;
/** Jitter tolerance so an on-grid fire is never dropped for rounding (mirrors the smoke tick). */
export const CADENCE_TOLERANCE_MS = 1_000;
/** Hard ceiling on one tick's resolver I/O, so a hung git/HTTP call can never wedge the tick. */
export const DEFAULT_DEPLOY_LAG_OVERALL_TIMEOUT_MS = 45_000;
/** Bound on a single lucy status-surface GET. */
export const DEFAULT_STATUS_FETCH_TIMEOUT_MS = 8_000;

/** A resolver reads one prod's deployed SHA and diffs it against origin/main. */
export type DeployLagTargetResolver = () => Promise<DeployLagTargetSnapshot>;

/**
 * Answers "is `ancestor` contained in `descendant`?" for a repo — a
 * `git merge-base --is-ancestor` check. Injected so the containment resolution
 * of the live-verification flip (issue #1596) is trivially stubbed in tests.
 */
export type CommitAncestryChecker = (repoPath: string, ancestor: string, descendant: string) => Promise<boolean>;

/**
 * Default {@link CommitAncestryChecker}: exit 0 from `merge-base --is-ancestor`
 * ⇒ contained. Every other outcome — not an ancestor (exit 1), an unknown
 * commit (exit 128), or any error — resolves to `false`, so a merged unit is
 * only ever flipped to live-verified on a positive containment proof, never on
 * an ambiguous git result.
 */
export async function defaultCommitAncestryChecker(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const { runGitIn } = await import('../core/git-helpers.js');
  const result = await runGitIn(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.kind === 'ok';
}

/**
 * Fired on a converged (`up-to-date`) tick for a target whose repo is known
 * (issue #1596): the deployed SHA has caught up to origin/main, so every merged
 * unit it contains is now live. The handler receives the deployed SHA and an
 * `isContained` predicate (bound to that SHA) it uses to resolve which merged
 * units the SHA covers. This is the deploy-lag detector's "converged"
 * observation named in issue #1596 as the mechanical flip signal.
 */
export type DeployVerifiedHandler = (
  deployedSha: string,
  isContained: (mergeCommit: string) => Promise<boolean>,
) => void | Promise<void>;

/**
 * A named monitored prod. The name is carried ALONGSIDE the resolver (not only
 * inside its returned snapshot) so a resolver that times out or throws — the
 * failure path most likely during a real incident — still yields a
 * correctly-named `unknown` result instead of an anonymous `target#0`.
 */
export interface DeployLagTarget {
  name: string;
  resolve: DeployLagTargetResolver;
  /**
   * Local checkout of this prod's repo, used to resolve merge-commit containment
   * for the live-verification flip (issue #1596). Optional: a target without a
   * repo path never drives the flip (its convergence is still alerted on as
   * before), so the feature is purely additive.
   */
  repoPath?: string;
}

/** Path of the deploy-lag alert artifact (distinct from the smoke ticks' artifacts). */
export function deployLagAlertPath(kookrDir: string): string {
  return join(kookrDir, 'deploy-lag-alert.json');
}

/**
 * Build the edge-triggered operational-alert message for a state transition.
 * `fired` on healthy→lagging, `recovered` on lagging→healthy. The stable
 * `operationalAlert.key` lets the dashboard correlate a fire with its recovery
 * instead of treating each lagging tick as a brand-new alert.
 */
export function buildDeployLagAlertMessage(
  artifact: AlertArtifact,
  state: 'fired' | 'recovered',
  alertPath: string,
): ServerMessage {
  if (state === 'recovered') {
    return {
      type: 'alert',
      agentId: '',
      summary: 'Deploy lag cleared',
      details: `All monitored prods are within the deploy-lag threshold again. Artifact: ${alertPath}`,
      severity: 'info',
      operationalAlert: { key: DEPLOY_LAG_ALERT_KEY, metric: DEPLOY_LAG_ALERT_METRIC, state: 'recovered' },
    };
  }
  const lagging = artifact.failingChecks.map((c) => c.replace(/^deploy-lag:/, '')).join(', ') || 'unknown';
  const streak = artifact.consecutiveFailures ?? 1;
  const since = artifact.firstFailedAt ?? artifact.generatedAt;
  const detail = artifact.checks
    .filter((c) => !c.ok)
    .map((c) => c.detail)
    .join(' | ');
  return {
    type: 'alert',
    agentId: '',
    summary: `Deploy lag: ${lagging} behind origin/main`,
    details:
      `Merged commits have sat undeployed past the threshold (${streak} consecutive tick(s) since ${since}). ` +
      `${detail}. prod:update stays operator-triggered — this detector never deploys. Artifact: ${alertPath}`,
    severity: 'critical',
    operationalAlert: { key: DEPLOY_LAG_ALERT_KEY, metric: DEPLOY_LAG_ALERT_METRIC, state: 'fired' },
  };
}

export interface DeployLagDetectorDeps {
  /** Kookr data dir — derives the default alert artifact path. */
  kookrDir: string;
  /** One named resolver per monitored prod (kookr, lucy). */
  targets: DeployLagTarget[];
  /** Age past which undeployed commits alert. Defaults to 6h. */
  thresholdMs?: number;
  /** Minimum spacing between runs; a fire is skipped if the last one is newer. */
  intervalMs?: number;
  /** Hard ceiling on one tick's resolver I/O. */
  overallTimeoutMs?: number;
  /** Broadcast a fire/recover operational alert. Absent in tests without a bus. */
  broadcast?: (msg: ServerMessage) => void;
  /** Explicit alert-artifact path override. */
  alertPath?: string;
  /**
   * Called on a converged (`up-to-date`) tick for a target with a `repoPath`,
   * once per newly-converged deployed SHA (issue #1596). Drives the ROI rollup's
   * live-verified flip. Absent ⇒ the detector only alerts, exactly as before.
   */
  onDeployVerified?: DeployVerifiedHandler;
  /** Resolves merge-commit containment for {@link onDeployVerified}. */
  ancestryChecker?: CommitAncestryChecker;
  // --- test seams (all default to the real implementations) ---
  readArtifact?: (path: string) => AlertArtifact | null;
  writeArtifact?: (path: string, artifact: AlertArtifact) => void;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Stateful deploy-lag detector. One instance per server; the host periodic
 * timer calls {@link maybeRun} on its interval. Guards against pile-up (a
 * still-running tick is skipped) and enforces its own minimum cadence, so it is
 * safe to host on a faster tick than the configured interval.
 */
export class DeployLagDetector {
  private running = false;
  /** Edge-trigger flag: true while a lag alert episode is active (fired, not yet recovered). */
  private firing = false;
  /** Whether {@link firing} has been seeded from the durable artifact yet (first run). */
  private firingSeeded = false;
  private lastRunAtMs = Number.NEGATIVE_INFINITY;

  private readonly targets: DeployLagTarget[];
  private readonly thresholdMs: number;
  private readonly intervalMs: number;
  private readonly overallTimeoutMs: number;
  private readonly alertPath: string;
  private readonly broadcast?: (msg: ServerMessage) => void;
  private readonly onDeployVerified?: DeployVerifiedHandler;
  private readonly ancestryChecker: CommitAncestryChecker;
  /** Last deployed SHA a converged tick fired {@link onDeployVerified} for, per target — dedups repeat fires for an unchanged SHA. */
  private readonly lastVerifiedShaByTarget = new Map<string, string>();
  private readonly readArtifact: (path: string) => AlertArtifact | null;
  private readonly writeArtifact: (path: string, artifact: AlertArtifact) => void;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(deps: DeployLagDetectorDeps) {
    this.targets = deps.targets;
    this.thresholdMs = deps.thresholdMs ?? DEFAULT_DEPLOY_LAG_THRESHOLD_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_DEPLOY_LAG_INTERVAL_MS;
    this.overallTimeoutMs = deps.overallTimeoutMs ?? DEFAULT_DEPLOY_LAG_OVERALL_TIMEOUT_MS;
    this.alertPath = deps.alertPath ?? deployLagAlertPath(deps.kookrDir);
    this.broadcast = deps.broadcast;
    this.onDeployVerified = deps.onDeployVerified;
    this.ancestryChecker = deps.ancestryChecker ?? defaultCommitAncestryChecker;
    this.readArtifact = deps.readArtifact ?? readAlertArtifact;
    this.writeArtifact = deps.writeArtifact ?? writeAlertArtifact;
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? console;
  }

  get hostIntervalMs(): number {
    return this.intervalMs;
  }

  get alertArtifactPath(): string {
    return this.alertPath;
  }

  /** Names of the prods this detector monitors, in order. */
  get monitoredTargets(): string[] {
    return this.targets.map((t) => t.name);
  }

  /**
   * Run one tick if due and not already running. NEVER throws — a failure is
   * logged and swallowed so it can never crash the host interval callback.
   * Returns the artifact written, or null when the run was skipped (pile-up
   * guard or cadence gate).
   */
  async maybeRun(): Promise<AlertArtifact | null> {
    if (this.running) {
      this.logger.warn('[deploy-lag] previous tick still running; skipping this fire');
      return null;
    }
    const startMs = this.now();
    // Anchor the cadence to the fire START, not the run's end (same reasoning as
    // the smoke tick): measuring fire-to-fire minus a jitter tolerance keeps
    // every scheduled fire even when a run takes a while.
    if (startMs - this.lastRunAtMs < this.intervalMs - CADENCE_TOLERANCE_MS) return null;

    this.running = true;
    this.lastRunAtMs = startMs;
    try {
      return await this.runOnce(startMs);
    } catch (err) {
      this.logger.error('[deploy-lag] tick failed:', err);
      return null;
    } finally {
      this.running = false;
    }
  }

  private async runOnce(startMs: number): Promise<AlertArtifact> {
    const results = await this.resolveAllBounded();
    const checks: CheckResult[] = results.map(targetResultToCheckResult);
    const anyLagging = results.some((r) => r.status === 'lagging');
    const unknownTargets = results.filter((r) => r.status === 'unknown').map((r) => r.target);

    const prev = this.readArtifact(this.alertPath);
    // Seed the edge-trigger from the durable artifact on the first run of this
    // process so a restart mid-episode does not re-broadcast a duplicate `fired`
    // (mirrors the smoke tick).
    if (!this.firingSeeded) {
      this.firing = prev?.status === 'alert';
      this.firingSeeded = true;
    }

    // HOLD: an INDETERMINATE tick — no target confirmed lagging, but at least one
    // could not be resolved (a transient git/HTTP blip) — must neither raise a
    // new alert nor CLEAR an active one. `unknown` maps to a non-failing check,
    // so without this guard a lagging target that momentarily errors would flip
    // the artifact to `ok`, reset the streak, and broadcast a false "Deploy lag
    // cleared" while prod is exactly as lagged as before (operability +
    // failure-mode review). Keep the prior alert artifact and firing state
    // untouched; only a positively-confirmed clean tick may recover.
    if (!anyLagging && unknownTargets.length > 0 && this.firing && prev) {
      this.logger.warn(
        `[deploy-lag] indeterminate tick during an active alert — holding episode (not clearing); ` +
          `unresolved: ${unknownTargets.join(', ')}`,
      );
      return prev;
    }

    const built = buildAlertArtifact(checks, new Date(startMs).toISOString());
    const artifact = mergeAlertArtifact(prev, built);
    this.writeArtifact(this.alertPath, artifact);

    if (artifact.status === 'alert') {
      this.logger.warn(
        `[deploy-lag] LAG (${artifact.consecutiveFailures} consecutive): ` +
          `${artifact.failingChecks.join(', ')} — artifact ${this.alertPath}`,
      );
      if (!this.firing) {
        this.firing = true;
        this.broadcast?.(buildDeployLagAlertMessage(artifact, 'fired', this.alertPath));
      }
    } else {
      if (unknownTargets.length > 0) {
        // Not a clean bill of health — some target could not be verified this
        // tick. Log distinctly so a tail does not read this as "all good".
        this.logger.warn(
          `[deploy-lag] ${unknownTargets.length} target(s) indeterminate this tick — could not verify: ` +
            unknownTargets.join(', '),
        );
      } else {
        this.logger.log('[deploy-lag] all monitored prods within threshold');
      }
      if (this.firing) {
        this.firing = false;
        this.broadcast?.(buildDeployLagAlertMessage(artifact, 'recovered', this.alertPath));
      }
    }

    // Live-verification flip (issue #1596): a converged target means its
    // deployed SHA has caught up to origin/main, so every merged unit that SHA
    // contains is now live. Runs independently of the alert edge above — a
    // steady-state converged prod fires this once per newly-converged SHA. A
    // lagging/unknown result never reaches here, so a failed/incomplete deploy
    // flips nothing.
    await this.maybeFireDeployVerified(results);
    return artifact;
  }

  /**
   * For each target that CONVERGED (`up-to-date`) this tick and has a known
   * repo, fire {@link onDeployVerified} once per newly-converged deployed SHA.
   * The dedup (per-target last SHA) keeps a steady converged prod from
   * re-flipping every hour; a genuinely new deploy (new SHA) fires again.
   */
  private async maybeFireDeployVerified(results: DeployLagTargetResult[]): Promise<void> {
    if (!this.onDeployVerified) return;
    const repoByTarget = new Map(this.targets.map((t) => [t.name, t.repoPath]));
    for (const result of results) {
      if (result.status !== 'up-to-date' || !result.deployedSha) continue;
      const repoPath = repoByTarget.get(result.target);
      if (!repoPath) continue;
      if (this.lastVerifiedShaByTarget.get(result.target) === result.deployedSha) continue;
      this.lastVerifiedShaByTarget.set(result.target, result.deployedSha);
      const deployedSha = result.deployedSha;
      try {
        await this.onDeployVerified(
          deployedSha,
          (mergeCommit) => this.ancestryChecker(repoPath, mergeCommit, deployedSha),
        );
      } catch (err) {
        this.logger.error('[deploy-lag] onDeployVerified handler failed:', err);
      }
    }
  }

  /**
   * Resolve every target with a per-target deadline. Each resolver already
   * bounds its own git/HTTP calls, but this backstop guarantees the tick settles
   * within a budget even if a resolver hangs — a timed-out target resolves to an
   * `unknown` (non-alerting) result rather than never settling. Targets run
   * concurrently, so the whole tick still completes within ~one deadline.
   * `unknown` never fires a false lag alert, so a slow resolver degrades to
   * silence, not noise.
   */
  private async resolveAllBounded(): Promise<DeployLagTargetResult[]> {
    const nowMs = this.now();
    const evaluate = (snapshot: DeployLagTargetSnapshot): DeployLagTargetResult =>
      evaluateDeployLag({ snapshot, nowMs, thresholdMs: this.thresholdMs });

    const settle = this.targets.map(async ({ name, resolve }): Promise<DeployLagTargetResult> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<DeployLagTargetSnapshot>((res) => {
        timer = setTimeout(
          () =>
            res({
              target: name,
              deployedSha: null,
              mainSha: null,
              pendingCommits: [],
              unavailableReason: `resolver exceeded the ${this.overallTimeoutMs}ms deadline`,
            }),
          this.overallTimeoutMs,
        );
      });
      const work = resolve().catch(
        (err): DeployLagTargetSnapshot => ({
          target: name,
          deployedSha: null,
          mainSha: null,
          pendingCommits: [],
          unavailableReason: err instanceof Error ? err.message : String(err),
        }),
      );
      try {
        return evaluate(await Promise.race([work, deadline]));
      } finally {
        if (timer) clearTimeout(timer);
      }
    });

    return Promise.all(settle);
  }
}

// ---------------------------------------------------------------------------
// Default target resolvers wired from config.
// ---------------------------------------------------------------------------

/** kookr resolver: running SHA from build-info (the server API surface), diffed against origin/main. */
export function createKookrTargetResolver(deps: {
  config: DeployLagConfig;
  /** Full running SHA baked into the build (build-info.json). `dev`/unset ⇒ fall back to HEAD. */
  getRunningSha: () => string | null;
  git?: GitReader;
}): DeployLagTargetResolver {
  const git = deps.git ?? defaultGitReader;
  return async () => {
    let rawDeployedSha = deps.getRunningSha();
    let rawDeployedReason: string | undefined;
    if (!rawDeployedSha) {
      // No baked build SHA (dev build); fall back to the checkout HEAD — the
      // prod worktree HEAD, which is what was built and is running.
      rawDeployedSha = await git(deps.config.kookrRepoPath, ['rev-parse', 'HEAD']);
      if (!rawDeployedSha) rawDeployedReason = 'no build-info SHA and HEAD unresolved';
    }
    return diffAgainstMain({
      target: 'kookr',
      rawDeployedSha,
      ...(rawDeployedReason ? { rawDeployedReason } : {}),
      repoPath: deps.config.kookrRepoPath,
      git,
      fetchBeforeCompare: deps.config.fetchBeforeCompare,
    });
  };
}

/** lucy resolver: live GIT_SHA from its status surface, diffed against origin/main in a local lucy clone. */
export function createLucyTargetResolver(deps: {
  config: DeployLagConfig & { lucyStatusUrl: string; lucyRepoPath: string };
  git?: GitReader;
  fetchStatus?: StatusFetcher;
}): DeployLagTargetResolver {
  const git = deps.git ?? defaultGitReader;
  const fetchStatus = deps.fetchStatus ?? defaultStatusFetcher(DEFAULT_STATUS_FETCH_TIMEOUT_MS);
  return async () => {
    let rawDeployedSha: string | null = null;
    let rawDeployedReason: string | undefined;
    try {
      const payload = await fetchStatus(deps.config.lucyStatusUrl);
      rawDeployedSha = extractGitSha(payload, deps.config.lucyShaFields);
      if (!rawDeployedSha) rawDeployedReason = `no git SHA field in ${deps.config.lucyStatusUrl}`;
    } catch (err) {
      rawDeployedReason = `lucy status surface unreachable: ${err instanceof Error ? err.message : String(err)}`;
    }
    return diffAgainstMain({
      target: 'lucy',
      rawDeployedSha,
      ...(rawDeployedReason ? { rawDeployedReason } : {}),
      repoPath: deps.config.lucyRepoPath,
      git,
      fetchBeforeCompare: deps.config.fetchBeforeCompare,
    });
  };
}

// ---------------------------------------------------------------------------
// Env resolution + factory (mirrors the smoke tick's enable-on-4800 default).
// ---------------------------------------------------------------------------

/**
 * Resolve whether the detector is enabled and its interval from the
 * environment. Enabled by default ONLY on the canonical prod port (4800) so a
 * fresh deploy is protected with no operational change, while dev servers and
 * the test suite stay silent. `KOOKR_DEPLOY_LAG_DETECTOR` forces it on
 * (`1`/`true`) or off (`0`/`false`); `KOOKR_DEPLOY_LAG_INTERVAL_MINUTES`
 * overrides the cadence (a non-positive value disables the detector).
 */
export function resolveDeployLagDetectorSettings(
  env: NodeJS.ProcessEnv,
  port: number | string,
  logger: Pick<Console, 'warn'> = console,
): { enabled: boolean; intervalMs: number } {
  const intervalRaw = env.KOOKR_DEPLOY_LAG_INTERVAL_MINUTES?.trim();
  let intervalMs = DEFAULT_DEPLOY_LAG_INTERVAL_MS;
  let intervalDisables = false;
  if (intervalRaw !== undefined && intervalRaw !== '') {
    const minutes = Number(intervalRaw);
    if (Number.isFinite(minutes)) {
      if (minutes > 0) intervalMs = minutes * 60_000;
      else intervalDisables = true;
    } else {
      logger.warn(
        `[deploy-lag] ignoring malformed KOOKR_DEPLOY_LAG_INTERVAL_MINUTES="${intervalRaw}"; ` +
          `using the default ${DEFAULT_DEPLOY_LAG_INTERVAL_MS / 60_000}m cadence`,
      );
    }
  }

  const flag = env.KOOKR_DEPLOY_LAG_DETECTOR?.trim().toLowerCase();
  let enabled: boolean;
  if (flag !== undefined && flag !== '') {
    enabled = flag !== '0' && flag !== 'false' && flag !== 'off' && flag !== 'no';
  } else {
    enabled = String(port) === '4800';
  }

  return { enabled: enabled && !intervalDisables, intervalMs };
}

/**
 * Build a {@link DeployLagDetector} from the environment, or return undefined
 * when it is disabled (dev/test, or explicitly turned off) or no target is
 * configured. The kookr target is always monitored (the running server's repo);
 * the lucy target is added only when both its status URL and a local clone are
 * configured.
 */
export function createDeployLagDetectorFromEnv(deps: {
  env: NodeJS.ProcessEnv;
  port: number | string;
  kookrDir: string;
  kookrRepoPath: string;
  getRunningSha: () => string | null;
  broadcast?: (msg: ServerMessage) => void;
  /** Drives the ROI rollup live-verified flip on a converged tick (issue #1596). */
  onDeployVerified?: DeployVerifiedHandler;
}): DeployLagDetector | undefined {
  const { enabled, intervalMs } = resolveDeployLagDetectorSettings(deps.env, deps.port);
  if (!enabled) return undefined;

  const config = resolveDeployLagConfig(deps.env, deps.kookrRepoPath);
  const targets: DeployLagTarget[] = [
    {
      name: 'kookr',
      resolve: createKookrTargetResolver({ config, getRunningSha: deps.getRunningSha }),
      // The repo whose merge commits a converged kookr deploy makes live (#1596).
      repoPath: config.kookrRepoPath,
    },
  ];
  if (config.lucyStatusUrl && config.lucyRepoPath) {
    targets.push({
      name: 'lucy',
      resolve: createLucyTargetResolver({
        config: { ...config, lucyStatusUrl: config.lucyStatusUrl, lucyRepoPath: config.lucyRepoPath },
      }),
      repoPath: config.lucyRepoPath,
    });
  } else {
    console.log(
      '[deploy-lag] lucy target not monitored (set KOOKR_DEPLOY_LAG_LUCY_STATUS_URL and ' +
        'KOOKR_DEPLOY_LAG_LUCY_REPO to enable it)',
    );
  }

  return new DeployLagDetector({
    kookrDir: deps.kookrDir,
    targets,
    thresholdMs: config.thresholdMs,
    intervalMs,
    ...(deps.broadcast ? { broadcast: deps.broadcast } : {}),
    ...(deps.onDeployVerified ? { onDeployVerified: deps.onDeployVerified } : {}),
  });
}
