// Integration train liveness monitor (issue #3796).
//
// The train (scripts/integration-train.ts) is the only thing that moves `main`
// once pull requests merge into the integration branch. If it is not running,
// or is halted, merged work silently stops reaching `main` and production. This
// server-side tick alerts the operator when the integration branch has differed
// from `main` for longer than a threshold while the train is not running or is
// halted, and sends the matching "clear" once that is no longer true.
//
// "Differed for longer than the threshold" is measured from the last time
// `main` moved: a train that keeps promoting resets the clock, so a slow but
// working train never alerts. The refs are read from the remote with
// `git ls-remote`, not from local tracking refs, which only the train itself
// keeps fresh. It only alerts; it never starts, stops or resumes the train.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runGitIn } from '../core/git-helpers.js';
import {
  defaultOperatorSignalDir,
  writeOperatorSignal,
  type WriteOperatorSignalInput,
} from '../observability/signal-delivery/operator-signal.js';
import { parseIntegrationBranch } from '../core/integration-branch.js';
import {
  effectiveIntegrationTrainStateDir,
  readIntegrationTrainStatus,
  resolveRepoKey,
  type IntegrationTrainStatus,
} from './integration-train-runtime.js';

export const DEFAULT_TRAIN_MONITOR_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_TRAIN_STALL_THRESHOLD_MS = 30 * 60_000;
/** Stable signal key: the alert and its clear overwrite one outbox file. */
export const TRAIN_STALL_SIGNAL_KEY = 'integration-train-monitor:stalled';
const GIT_TIMEOUT_MS = 20_000;

export interface RemoteRefs {
  main: string;
  integration: string;
}

/** What `/api/health` and `kookr status` show under `integrationTrain`. */
export interface IntegrationTrainHealth {
  integrationBranch: string;
  running: boolean;
  pid: number | null;
  halted: IntegrationTrainStatus['halted'];
  lastCycle: IntegrationTrainStatus['lastCycle'];
  /** Set while a restart waits for the train's current cycle to end. */
  restartPending: IntegrationTrainStatus['restartPending'];
  /** Since when the integration branch has differed from `main` with `main` not moving; null when equal. */
  pendingSince: string | null;
  /** True while a stall alert is out and not yet cleared. */
  alerting: boolean;
  checkedAt: string | null;
  lastError?: string;
}

interface MonitorState {
  pendingSince: string | null;
  lastMain: string | null;
  alerting: boolean;
}

export interface IntegrationTrainMonitorDeps {
  kookrDir: string;
  /** A checkout of the repository the train promotes (the server's own). */
  repoPath: string;
  thresholdMs?: number;
  intervalMs?: number;
  // --- seams (default to the real implementations) ---
  readConfiguredBranch?: () => Promise<string | null>;
  readRemoteRefs?: (branch: string) => Promise<RemoteRefs | null>;
  readStatus?: () => IntegrationTrainStatus;
  writeSignal?: (input: WriteOperatorSignalInput) => Promise<unknown>;
  statePath?: string;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'warn'>;
}

function formatMinutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

export class IntegrationTrainMonitor {
  private running = false;
  private branch: string | null = null;
  private checkedAt: string | null = null;
  private lastError: string | null = null;
  private state: MonitorState;

  private readonly thresholdMs: number;
  private readonly intervalMs: number;
  private readonly statePath: string;
  private readonly readConfiguredBranch: () => Promise<string | null>;
  private readonly readRemoteRefs: (branch: string) => Promise<RemoteRefs | null>;
  private readonly readStatus: () => IntegrationTrainStatus;
  private readonly writeSignal: (input: WriteOperatorSignalInput) => Promise<unknown>;
  private readonly now: () => number;
  private readonly logger: Pick<Console, 'log' | 'warn'>;

  constructor(deps: IntegrationTrainMonitorDeps) {
    this.thresholdMs = deps.thresholdMs ?? DEFAULT_TRAIN_STALL_THRESHOLD_MS;
    this.intervalMs = deps.intervalMs ?? DEFAULT_TRAIN_MONITOR_INTERVAL_MS;
    this.statePath = deps.statePath ?? join(deps.kookrDir, 'integration-train-monitor.json');
    this.readConfiguredBranch = deps.readConfiguredBranch ?? (() => readConfiguredBranchFromRepo(deps.repoPath));
    this.readRemoteRefs = deps.readRemoteRefs ?? ((branch) => readRemoteRefsFromRepo(deps.repoPath, branch));
    let repoKey: string | null = null;
    this.readStatus = deps.readStatus ?? (() => {
      repoKey ??= resolveRepoKey(deps.repoPath);
      return readIntegrationTrainStatus(effectiveIntegrationTrainStateDir(deps.kookrDir, repoKey));
    });
    const signalDir = defaultOperatorSignalDir(process.env);
    this.writeSignal = deps.writeSignal ?? ((input) => writeOperatorSignal(signalDir, input));
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger ?? console;
    this.state = this.loadState();
  }

  get hostIntervalMs(): number {
    return this.intervalMs;
  }

  /** One check. Never throws; a run still in progress makes this a no-op. */
  async maybeRun(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.tick();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[integration-train-monitor] check failed: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  private async tick(): Promise<void> {
    const nowMs = this.now();
    this.branch = await this.readConfiguredBranch();
    this.checkedAt = new Date(nowMs).toISOString();
    if (this.branch === null) {
      // Feature off: nothing to promote. Close an alert that is still out.
      this.state.pendingSince = null;
      this.state.lastMain = null;
      if (this.state.alerting) await this.clear('no integration branch is configured any more');
      this.saveState();
      this.lastError = null;
      return;
    }
    const refs = await this.readRemoteRefs(this.branch);
    if (refs === null) {
      // Unknown, not healthy: keep the clock and the alert as they are.
      this.lastError = `could not read main and ${this.branch} from origin`;
      return;
    }
    this.lastError = null;
    if (refs.main === refs.integration) {
      this.state.pendingSince = null;
    } else if (this.state.pendingSince === null || refs.main !== this.state.lastMain) {
      // Newly different, or `main` moved since the last check: the train is making progress.
      this.state.pendingSince = new Date(nowMs).toISOString();
    }
    this.state.lastMain = refs.main;

    const status = this.readStatus();
    const pendingMs = this.state.pendingSince === null ? 0 : nowMs - Date.parse(this.state.pendingSince);
    const trainDown = !status.running || status.halted !== null;
    const stalled = this.state.pendingSince !== null && pendingMs >= this.thresholdMs && trainDown;

    if (stalled && !this.state.alerting) {
      const why = !status.running
        ? 'the integration train is not running. Start it with `pnpm train:start` in the production checkout.'
        : `the integration train is halted (${status.halted?.reason}). See \`pnpm train:status\` and docs/reference/integration-train.md.`;
      await this.writeSignal({
        key: TRAIN_STALL_SIGNAL_KEY,
        kind: 'alert',
        source: 'integration-train-monitor',
        title: `integration train stalled: ${this.branch} is not reaching main`,
        detail: `${this.branch} has differed from main for ${formatMinutes(pendingMs)} and ${why}`,
      });
      this.state.alerting = true;
      this.logger.warn(`[integration-train-monitor] alert: ${this.branch} stalled for ${formatMinutes(pendingMs)}`);
    } else if (!stalled && this.state.alerting) {
      await this.clear(refs.main === refs.integration
        ? `main has caught up with ${this.branch}`
        : 'the integration train is running again');
    }
    this.saveState();
  }

  private async clear(detail: string): Promise<void> {
    await this.writeSignal({
      key: TRAIN_STALL_SIGNAL_KEY,
      kind: 'clear',
      source: 'integration-train-monitor',
      title: 'integration train no longer stalled',
      detail,
    });
    this.state.alerting = false;
  }

  /** Cheap snapshot for `/api/health`: the last check plus a fresh read of the train's files. Null while the feature is off. */
  getHealthSnapshot(): IntegrationTrainHealth | null {
    if (this.branch === null) return null;
    let status: IntegrationTrainStatus | null = null;
    try { status = this.readStatus(); } catch { /* reported as not running */ }
    return {
      integrationBranch: this.branch,
      running: status?.running ?? false,
      pid: status?.pid ?? null,
      halted: status?.halted ?? null,
      lastCycle: status?.lastCycle ?? null,
      restartPending: status?.restartPending ?? null,
      pendingSince: this.state.pendingSince,
      alerting: this.state.alerting,
      checkedAt: this.checkedAt,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  private loadState(): MonitorState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<MonitorState>;
      return {
        pendingSince: typeof raw.pendingSince === 'string' ? raw.pendingSince : null,
        lastMain: typeof raw.lastMain === 'string' ? raw.lastMain : null,
        alerting: raw.alerting === true,
      };
    } catch {
      return { pendingSince: null, lastMain: null, alerting: false };
    }
  }

  private saveState(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      renameSync(tmp, this.statePath);
    } catch (err) {
      this.logger.warn(`[integration-train-monitor] could not save ${this.statePath}: ${String(err)}`);
    }
  }
}

/** The integration branch named by `.kookr/delivery-gate.json` on the local `origin/main`, or null. */
export async function readConfiguredBranchFromRepo(repoPath: string): Promise<string | null> {
  const r = await runGitIn(repoPath, ['show', 'origin/main:.kookr/delivery-gate.json'], { timeoutMs: GIT_TIMEOUT_MS });
  return r.kind === 'ok' ? parseIntegrationBranch(r.stdout) : null;
}

/** `main` and the integration branch as the remote has them now, or null when unreadable. */
export async function readRemoteRefsFromRepo(repoPath: string, branch: string): Promise<RemoteRefs | null> {
  const r = await runGitIn(
    repoPath,
    ['ls-remote', 'origin', 'refs/heads/main', `refs/heads/${branch}`],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (r.kind !== 'ok') return null;
  const refs = new Map<string, string>();
  for (const line of r.stdout.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref) refs.set(ref, sha);
  }
  const main = refs.get('refs/heads/main');
  const integration = refs.get(`refs/heads/${branch}`);
  return main && integration ? { main, integration } : null;
}

/**
 * Build the monitor, or undefined when disabled. On by default only on the
 * production port (4800), like the deploy-lag detector, so dev servers and the
 * test suite stay silent. `KOOKR_INTEGRATION_TRAIN_MONITOR` forces it on or
 * off; `KOOKR_INTEGRATION_TRAIN_STALL_MINUTES` sets the threshold (default 30).
 */
export function createIntegrationTrainMonitorFromEnv(deps: {
  env: NodeJS.ProcessEnv;
  port: number | string;
  kookrDir: string;
  repoPath: string;
}): IntegrationTrainMonitor | undefined {
  const flag = deps.env.KOOKR_INTEGRATION_TRAIN_MONITOR?.trim().toLowerCase();
  const enabled = flag !== undefined && flag !== ''
    ? !['0', 'false', 'off', 'no'].includes(flag)
    : String(deps.port) === '4800';
  if (!enabled) return undefined;
  const minutes = Number(deps.env.KOOKR_INTEGRATION_TRAIN_STALL_MINUTES);
  return new IntegrationTrainMonitor({
    kookrDir: deps.kookrDir,
    repoPath: deps.repoPath,
    ...(Number.isFinite(minutes) && minutes > 0 ? { thresholdMs: minutes * 60_000 } : {}),
  });
}
