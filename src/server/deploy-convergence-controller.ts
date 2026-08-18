/**
 * In-process deploy-convergence controller (issue #2226).
 *
 * Root cause of the 2026-08-11 stall: the agent-scheduled "Kookr Deploy
 * Convergence" playbook (#1883/#1891) was never registered in
 * `~/.kookr/schedules.json` (only Lucy's schedule existed), so
 * `behindCount≥1` + `deploying=false` could persist indefinitely while
 * `/api/health` stayed green. The 6h deploy-lag detector only pages — it
 * never advances prod.
 *
 * This controller runs in-process on the prod port (default 4800), so it does
 * not depend on agent slots, Grok auth, or a manually registered schedule:
 *
 * 1. Evaluate serving SHA vs origin/main (same pure classifier as the CLI).
 * 2. When DIVERGENT past grace → POST/call the canonical redeploy trigger
 *    (`/api/deploy/trigger` → prod-update.sh), unless a hold is set.
 * 3. When behindCount≥1 + deploying=false for ≥T → fire a loud residual
 *    operator signal (and recover when the gap closes).
 *
 * Never throws out of {@link maybeRun}. Enabled by default only on port 4800.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  DEFAULT_CONVERGENCE_THRESHOLDS,
  evaluateConvergence,
  formatConvergenceReceipt,
  normalizeSha,
  type ConvergenceResult,
  type ConvergenceThresholds,
} from '../core/deploy-convergence.js';
import {
  DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS,
  evaluateDeployStaleResidual,
  type DeployStaleResidualThresholds,
} from '../core/deploy-stale-residual.js';
import { gitIn } from '../core/git-helpers.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Stable operational-alert key for the deploy-stale residual (issue #2226). */
export const DEPLOY_STALE_RESIDUAL_ALERT_KEY = 'deploy:stale-residual' as const;
export const DEPLOY_STALE_RESIDUAL_METRIC = 'deploy_stale_residual' as const;

/** Default tick cadence: every 5 minutes (between 15m grace and residual 20m). */
export const DEFAULT_DEPLOY_CONVERGENCE_INTERVAL_MS = 5 * 60_000;

/** Hard ceiling on one tick's git/HTTP work. */
export const DEFAULT_DEPLOY_CONVERGENCE_OVERALL_TIMEOUT_MS = 45_000;

/** Default hold-file path: presence disables auto-redeploy (residual still pages). */
export const DEFAULT_DEPLOY_CONVERGENCE_HOLD_PATH = join(
  homedir(),
  '.kookr',
  'deploy-convergence-hold',
);

export interface DeployStatusSnapshot {
  behindCount: number;
  deploying: boolean;
  currentCommit?: string | null;
  latestCommit?: string | null;
}

export type RedeployTriggerResult =
  | { ok: true; status: number; alreadyInProgress?: boolean }
  | { ok: false; error: string; status?: number };

export interface DeployConvergenceControllerDeps {
  /** Local checkout used to resolve origin/main + ancestry (usually serverCwd / prod tree). */
  repoPath: string;
  /** Running server's build commit (null for dev builds). */
  getRunningSha: () => string | null;
  /**
   * Live deploy status (behindCount + deploying). Prefer GET /api/deploy/status
   * so residual matches the dashboard. Injected for tests.
   */
  getDeployStatus: () => Promise<DeployStatusSnapshot>;
  /**
   * Canonical redeploy path (POST /api/deploy/trigger). 409 already-in-progress
   * must be treated as success by the implementer.
   */
  triggerRedeploy: (reason: string) => Promise<RedeployTriggerResult>;
  /** Broadcast residual fire/recover. Absent ⇒ residual still classifies but is silent. */
  broadcast?: (msg: ServerMessage) => void;
  /** Override grace window for evaluateConvergence. */
  convergenceThresholds?: Partial<ConvergenceThresholds>;
  /** Override residual stale/cooldown bounds. */
  residualThresholds?: Partial<DeployStaleResidualThresholds>;
  /** Deploy branch (default main). */
  branch?: string;
  /** When false, classify + residual only — never call triggerRedeploy. */
  act?: boolean;
  /** When true (default), `git fetch origin <branch>` before compare. */
  fetchBeforeCompare?: boolean;
  /** Hold file path; if present, act is suppressed. */
  holdPath?: string | null;
  /** Host tick interval (ms). */
  intervalMs?: number;
  /** Overall tick deadline (ms). */
  overallTimeoutMs?: number;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Test seam for ancestry. */
  isAncestor?: (ancestor: string, descendant: string) => Promise<boolean>;
  /** Test seam for target SHA resolution. */
  resolveTargetSha?: () => Promise<{ sha: string | null; committedAtMs: number | null }>;
}

export interface DeployConvergenceTickResult {
  convergence: ConvergenceResult | null;
  residualAction: 'none' | 'alert' | 'recover';
  redeployRequested: boolean;
  redeployError: string | null;
  held: boolean;
  receipt: string;
}

/**
 * Stateful in-process controller. One instance per server; lifecycle timers
 * call {@link maybeRun} on {@link hostIntervalMs}.
 */
export class DeployConvergenceController {
  private running = false;
  private lastRunAtMs = Number.NEGATIVE_INFINITY;
  private residualFiring = false;
  private behindIdleSinceMs: number | null = null;
  private lastResidualAlertedAtMs: number | null = null;
  private lastRedeployAtMs: number | null = null;
  private readonly deps: DeployConvergenceControllerDeps;
  private readonly intervalMs: number;
  private readonly overallTimeoutMs: number;
  private readonly branch: string;
  private readonly act: boolean;
  private readonly fetchBeforeCompare: boolean;
  private readonly holdPath: string | null;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(deps: DeployConvergenceControllerDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? DEFAULT_DEPLOY_CONVERGENCE_INTERVAL_MS;
    this.overallTimeoutMs = deps.overallTimeoutMs ?? DEFAULT_DEPLOY_CONVERGENCE_OVERALL_TIMEOUT_MS;
    this.branch = deps.branch ?? 'main';
    this.act = deps.act !== false;
    this.fetchBeforeCompare = deps.fetchBeforeCompare !== false;
    this.holdPath =
      deps.holdPath === null
        ? null
        : (deps.holdPath ?? DEFAULT_DEPLOY_CONVERGENCE_HOLD_PATH);
    this.logger = deps.logger ?? console;
  }

  get hostIntervalMs(): number {
    return this.intervalMs;
  }

  /**
   * Cadence-gated tick. Safe to call faster than {@link hostIntervalMs}; skips
   * when a previous tick is still running. Never throws.
   */
  async maybeRun(opts?: { ignoreCadence?: boolean }): Promise<DeployConvergenceTickResult | null> {
    const nowMs = this.deps.now?.() ?? Date.now();
    if (this.running) return null;
    // Startup fire (issue #2635) must not move lastRunAtMs or the first
    // on-grid interval tick is still inside the window and is skipped.
    if (!opts?.ignoreCadence && nowMs - this.lastRunAtMs + 1_000 < this.intervalMs) return null;
    this.running = true;
    if (!opts?.ignoreCadence) this.lastRunAtMs = nowMs;
    try {
      return await this.runOnce(nowMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[deploy-convergence] tick failed: ${message}`);
      return {
        convergence: null,
        residualAction: 'none',
        redeployRequested: false,
        redeployError: message,
        held: false,
        receipt: `deploy-convergence: ERROR ${message}`,
      };
    } finally {
      this.running = false;
    }
  }

  /** Force one evaluation (tests / manual probe). Ignores cadence gate. */
  async runOnce(nowMs: number = this.deps.now?.() ?? Date.now()): Promise<DeployConvergenceTickResult> {
    // Use wall-clock deadlines for I/O timeouts — injected `nowMs` is only for
    // residual/grace age math (tests freeze it in the past/future).
    const timeoutMs = this.overallTimeoutMs;
    const held = await this.isHeld();

    let status: DeployStatusSnapshot;
    try {
      status = await withTimeout(this.deps.getDeployStatus(), timeoutMs, 'getDeployStatus');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        convergence: null,
        residualAction: 'none',
        redeployRequested: false,
        redeployError: message,
        held,
        receipt: `deploy-convergence: ERROR status ${message}`,
      };
    }

    // Residual first so a long-idle gap pages even when the serve SHA probe is
    // a dev build (convergence would return unknown).
    const residual = evaluateDeployStaleResidual({
      behindCount: status.behindCount,
      deploying: status.deploying,
      behindIdleSinceMs: this.behindIdleSinceMs,
      lastAlertedAtMs: this.lastResidualAlertedAtMs,
      firing: this.residualFiring,
      nowMs,
      thresholds: this.deps.residualThresholds,
    });
    this.behindIdleSinceMs = residual.nextBehindIdleSinceMs;
    let residualAction = residual.action;
    if (residual.action === 'alert') {
      this.emitResidual('fired', residual.message, status);
      this.residualFiring = true;
      this.lastResidualAlertedAtMs = nowMs;
    } else if (residual.action === 'recover') {
      this.emitResidual('recovered', residual.message, status);
      this.residualFiring = false;
    }

    const servingSha =
      normalizeSha(this.deps.getRunningSha()) ||
      normalizeSha(status.currentCommit) ||
      null;

    if (this.fetchBeforeCompare) {
      await gitIn(this.deps.repoPath, 'fetch', 'origin', this.branch);
    }

    const target = this.deps.resolveTargetSha
      ? await this.deps.resolveTargetSha()
      : await this.defaultResolveTarget();

    let servingIncludesTarget: boolean | null = null;
    if (servingSha && target.sha) {
      try {
        servingIncludesTarget = this.deps.isAncestor
          ? await this.deps.isAncestor(target.sha, servingSha)
          : await this.defaultIsAncestor(target.sha, servingSha);
      } catch {
        servingIncludesTarget = null;
      }
    }

    const convergence = evaluateConvergence({
      servingSha,
      targetSha: target.sha,
      servingIncludesTarget,
      targetCommittedAtMs: target.committedAtMs,
      thresholds: this.deps.convergenceThresholds ?? DEFAULT_CONVERGENCE_THRESHOLDS,
      nowMs,
    });

    let redeployRequested = false;
    let redeployError: string | null = null;

    if (convergence.action === 'redeploy' && this.act && !held && !status.deploying) {
      // Rate-limit: at least one full grace window between triggers so we
      // cannot re-fire while the deploy-routes 5m `deploying` safety net has
      // already cleared but prod-update is still building/restarting.
      // Using max(grace, interval) matches the comment and stays ≥ the
      // route's safety timer when grace is the 15m default.
      const graceMs =
        (this.deps.convergenceThresholds?.divergenceGraceMinutes ??
          DEFAULT_CONVERGENCE_THRESHOLDS.divergenceGraceMinutes) *
        60_000;
      const sinceLast = this.lastRedeployAtMs == null ? Infinity : nowMs - this.lastRedeployAtMs;
      if (sinceLast >= Math.max(graceMs, this.intervalMs)) {
        try {
          const reason = formatConvergenceReceipt(convergence);
          const result = await withTimeout(
            this.deps.triggerRedeploy(reason),
            timeoutMs,
            'triggerRedeploy',
          );
          if (result.ok) {
            redeployRequested = true;
            this.lastRedeployAtMs = nowMs;
            this.logger.log(
              `[deploy-convergence] redeploy requested (${result.alreadyInProgress ? 'already in progress' : `HTTP ${result.status}`}): ${reason}`,
            );
          } else {
            redeployError = result.error;
            this.logger.warn(`[deploy-convergence] redeploy failed: ${result.error}`);
          }
        } catch (err) {
          redeployError = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[deploy-convergence] redeploy threw: ${redeployError}`);
        }
      }
    } else if (convergence.action === 'redeploy' && held) {
      this.logger.log(
        `[deploy-convergence] DIVERGENT but hold active at ${this.holdPath ?? '(none)'} — residual-only`,
      );
    }

    const receipt = formatConvergenceReceipt(convergence);
    if (convergence.divergent || residualAction !== 'none') {
      this.logger.log(`[deploy-convergence] ${receipt} residual=${residualAction}`);
    }

    return {
      convergence,
      residualAction,
      redeployRequested,
      redeployError,
      held,
      receipt,
    };
  }

  private async defaultResolveTarget(): Promise<{ sha: string | null; committedAtMs: number | null }> {
    const ref = `origin/${this.branch}`;
    const sha = await gitIn(this.deps.repoPath, 'rev-parse', ref);
    const ct = sha ? await gitIn(this.deps.repoPath, 'show', '-s', '--format=%ct', ref) : null;
    const sec = ct ? Number(ct) : NaN;
    return {
      sha: normalizeSha(sha),
      committedAtMs: Number.isFinite(sec) ? sec * 1000 : null,
    };
  }

  private async defaultIsAncestor(ancestor: string, descendant: string): Promise<boolean> {
    // git merge-base --is-ancestor A B exits 0 when A is ancestor of B.
    // On success stdout is empty, so use runGitIn (kind==='ok') not gitIn.
    const { runGitIn } = await import('../core/git-helpers.js');
    const result = await runGitIn(this.deps.repoPath, [
      'merge-base',
      '--is-ancestor',
      ancestor,
      descendant,
    ]);
    return result.kind === 'ok';
  }

  private async isHeld(): Promise<boolean> {
    if (!this.holdPath) return false;
    try {
      await access(this.holdPath);
      return true;
    } catch {
      return false;
    }
  }

  private emitResidual(
    state: 'fired' | 'recovered',
    detail: string,
    status: DeployStatusSnapshot,
  ): void {
    if (!this.deps.broadcast) return;
    const msg: Extract<ServerMessage, { type: 'alert' }> =
      state === 'recovered'
        ? {
            type: 'alert',
            agentId: OPERATIONAL_ALERT_AGENT_ID,
            summary: 'Deploy lag residual cleared',
            details: `${detail}. behindCount=${status.behindCount} deploying=${status.deploying}`,
            severity: 'info',
            operationalAlert: {
              key: DEPLOY_STALE_RESIDUAL_ALERT_KEY,
              metric: DEPLOY_STALE_RESIDUAL_METRIC,
              state: 'recovered',
            },
          }
        : {
            type: 'alert',
            agentId: OPERATIONAL_ALERT_AGENT_ID,
            summary: `Deploy residual: kookr-prod ${status.behindCount} behind, not deploying`,
            details:
              `${detail}. Auto-advance should have fired past the 15m grace; ` +
              `check hold file (${this.holdPath ?? 'none'}), smoke gates, and /api/deploy/status. ` +
              `Issue #2226.`,
            severity: 'critical',
            operationalAlert: {
              key: DEPLOY_STALE_RESIDUAL_ALERT_KEY,
              metric: DEPLOY_STALE_RESIDUAL_METRIC,
              state: 'fired',
            },
          };
    try {
      this.deps.broadcast(msg);
    } catch (err) {
      this.logger.warn(
        `[deploy-convergence] residual broadcast threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`${label} timeout budget is non-positive`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve enablement + interval from env. Default on for port 4800 only.
 * `KOOKR_DEPLOY_CONVERGENCE` forces on/off; `KOOKR_DEPLOY_CONVERGENCE_INTERVAL_MINUTES`
 * overrides cadence (≤0 disables).
 */
export function resolveDeployConvergenceSettings(
  env: NodeJS.ProcessEnv,
  port: number | string,
  logger: Pick<Console, 'warn'> = console,
): { enabled: boolean; intervalMs: number; act: boolean } {
  const intervalRaw = env.KOOKR_DEPLOY_CONVERGENCE_INTERVAL_MINUTES?.trim();
  let intervalMs = DEFAULT_DEPLOY_CONVERGENCE_INTERVAL_MS;
  let intervalDisables = false;
  if (intervalRaw !== undefined && intervalRaw !== '') {
    const minutes = Number(intervalRaw);
    if (Number.isFinite(minutes)) {
      if (minutes > 0) intervalMs = minutes * 60_000;
      else intervalDisables = true;
    } else {
      logger.warn(
        `[deploy-convergence] ignoring malformed KOOKR_DEPLOY_CONVERGENCE_INTERVAL_MINUTES="${intervalRaw}"`,
      );
    }
  }

  const flag = env.KOOKR_DEPLOY_CONVERGENCE?.trim().toLowerCase();
  let enabled: boolean;
  if (flag !== undefined && flag !== '') {
    enabled = flag !== '0' && flag !== 'false' && flag !== 'off' && flag !== 'no';
  } else {
    enabled = String(port) === '4800';
  }

  const actRaw = env.KOOKR_DEPLOY_CONVERGENCE_ACT?.trim().toLowerCase();
  const act =
    actRaw === undefined || actRaw === ''
      ? true
      : actRaw !== '0' && actRaw !== 'false' && actRaw !== 'off' && actRaw !== 'no';

  return { enabled: enabled && !intervalDisables, intervalMs, act };
}

/**
 * Build a controller from the environment, or undefined when disabled.
 */
export function createDeployConvergenceControllerFromEnv(deps: {
  env: NodeJS.ProcessEnv;
  port: number | string;
  repoPath: string;
  apiBaseUrl: string;
  getRunningSha: () => string | null;
  broadcast?: (msg: ServerMessage) => void;
  holdPath?: string | null;
}): DeployConvergenceController | undefined {
  const { enabled, intervalMs, act } = resolveDeployConvergenceSettings(deps.env, deps.port);
  if (!enabled) return undefined;

  const base = deps.apiBaseUrl.replace(/\/+$/, '');
  const graceRaw = deps.env.KOOKR_DEPLOY_CONVERGENCE_GRACE_MINUTES?.trim();
  const graceParsed = graceRaw !== undefined && graceRaw !== '' ? Number(graceRaw) : NaN;
  const graceMinutes =
    Number.isFinite(graceParsed) && graceParsed >= 0 ? graceParsed : undefined;
  const residualStaleRaw = deps.env.KOOKR_DEPLOY_STALE_RESIDUAL_MINUTES?.trim();
  const residualStaleMs =
    residualStaleRaw && Number.isFinite(Number(residualStaleRaw)) && Number(residualStaleRaw) > 0
      ? Number(residualStaleRaw) * 60_000
      : undefined;

  return new DeployConvergenceController({
    repoPath: deps.repoPath,
    getRunningSha: deps.getRunningSha,
    intervalMs,
    act,
    holdPath: deps.holdPath,
    broadcast: deps.broadcast,
    convergenceThresholds:
      graceMinutes !== undefined ? { divergenceGraceMinutes: graceMinutes } : undefined,
    residualThresholds:
      residualStaleMs !== undefined
        ? { ...DEFAULT_DEPLOY_STALE_RESIDUAL_THRESHOLDS, staleMs: residualStaleMs }
        : undefined,
    getDeployStatus: async () => {
      const res = await fetch(`${base}/api/deploy/status`, {
        signal: AbortSignal.timeout(10_000),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`GET /api/deploy/status → HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown>;
      const behindCount =
        typeof body.behindCount === 'number' && Number.isFinite(body.behindCount)
          ? body.behindCount
          : 0;
      return {
        behindCount,
        deploying: body.deploying === true,
        currentCommit: typeof body.currentCommit === 'string' ? body.currentCommit : null,
        latestCommit: typeof body.latestCommit === 'string' ? body.latestCommit : null,
      };
    },
    triggerRedeploy: async (reason: string) => {
      const res = await fetch(`${base}/api/deploy/trigger`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (res.ok) return { ok: true, status: res.status };
      if (res.status === 409) return { ok: true, status: 409, alreadyInProgress: true };
      let detail = '';
      try {
        const body = (await res.json()) as { error?: string };
        detail = body.error ? `: ${body.error}` : '';
      } catch {
        // ignore
      }
      return { ok: false, status: res.status, error: `HTTP ${res.status}${detail}` };
    },
  });
}
