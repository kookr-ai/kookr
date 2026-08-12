import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  classifyKbDoctorCommandResult,
  classifyKbSearchSmokeResult,
  type DependencyCommandResult,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';
import {
  probeAgentBinary,
  probeBinaryFlagSupport,
  type ProbeExecRunner,
} from '../adapters/probe-agent-binary.js';
import {
  readAlertArtifact,
  type AlertArtifact,
} from '../server/prod-smoke.js';
import { prodSmokeTickAlertPath } from '../server/prod-smoke-tick.js';
import { resolveMaintenancePruneIntervalHours } from '../server/maintenance-prune-schedule.js';
import { resolveKookrDataDir } from './kookr-maintenance.js';
import {
  parseGithubStatusBody,
  type GithubStatusSnapshot,
} from './kookr-github.js';
import { DEFAULT_DTACH_PRESSURE_SOFT_BOUND } from '../core/resource-watchdog-eval.js';

type DoctorCheckStatus = 'ok' | 'warn' | 'fail';
type DoctorStatus = 'ok' | 'warn' | 'fail';
type DoctorCategory = 'runtime' | 'launch-dependency' | 'agent' | 'github' | 'ops';

/** Stable doctor/diagnostic code for the host-stale dtach mismatch (issue #2348). */
export const HOST_STALE_DTACH_MISMATCH_CODE = 'host_stale_dtach_mismatch';

export interface DoctorCheck {
  id: string;
  label: string;
  category: DoctorCategory;
  status: DoctorCheckStatus;
  required: boolean;
  summary: string;
  detail?: string;
  recommendedAction?: string;
}

export interface DoctorJsonReport {
  ok: boolean;
  status: DoctorStatus;
  generatedAt: string;
  checks: DoctorCheck[];
}

interface CommandRunner {
  (file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<DependencyCommandResult>;
}

/**
 * Live probe of resourceWatchdog from /api/health (issues #1988 / #2354).
 * null = unreachable / unknown. Boolean form kept for older test injectors.
 */
export interface ResourceWatchdogProbeSnapshot {
  enabled: boolean;
  pressureWhileDisabled?: boolean;
  pressureWhileDisabledReason?: string | null;
  lastDecision?: string | null;
  autoEnableOnPressure?: boolean;
}

type ResourceWatchdogEnabledProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<boolean | ResourceWatchdogProbeSnapshot | null>;

/**
 * Live probe of hungSuspect residual + hungSuspectTtlReclaim from /api/health
 * (issue #2231). null = unreachable / unknown / block absent — doctor stays green.
 */
export interface HungSuspectReclaimProbeSnapshot {
  hungSuspectCount: number;
  reclaimedTotal: number;
  reclaimAttempted: number;
  skippedOpenPrFailsafe: number;
  skippedUnderTtl: number;
  skippedNoLiveness: number;
  skippedProviderPaused: number;
  lastCandidatesConsidered: number;
  /** Last reclaim pass outcomes (`outcome` strings from hung-suspect-ttl). */
  lastOutcomes: Array<{ outcome: string }>;
}

type HungSuspectReclaimProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<HungSuspectReclaimProbeSnapshot | null>;

/**
 * Live probe of maintenancePrune.lastFiredAt from /api/diagnostics/timer-health
 * (issue #2080). Outer null = unreachable / unknown; inner lastFiredAt null =
 * loop registered but never fired yet.
 */
type MaintenancePruneTimerProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<{ lastFiredAt: string | null } | null>;

/**
 * Live probe of GET /api/github/status (issue #2098). null = unreachable /
 * unknown / no API base configured — doctor stays green (hermetic offline).
 */
type GithubScannerStatusProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<GithubStatusSnapshot | null>;

/**
 * Live probe of hook-ingestion lag gauges (issue #2320). null = unreachable /
 * unknown / no API base — doctor stays green (hermetic offline).
 */
export interface HookIngestionLagProbeSnapshot {
  sessionCount: number;
  notableLagCount: number;
  lagWarningThresholdMs: number;
}

type HookIngestionLagProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<HookIngestionLagProbeSnapshot | null>;

/**
 * Live probe of host-stale dtach vs session-reaper gauges from GET /api/health
 * (issue #2348). null = unreachable / unknown / gauges absent — doctor stays green.
 */
export interface HostStaleDtachProbeSnapshot {
  /** Host-wide `staleProcesses.dtach.count` from the health /proc cache. */
  dtachCount: number;
  /** Last session-reaper sweep orphan count (`sessionReaper.lastOrphanCount`). */
  lastOrphanCount: number;
  /** Last session-reaper sweep terminal-leak count. */
  lastTerminalLeakCount: number;
  /**
   * Soft bound for host excess (defaults to {@link DEFAULT_DTACH_PRESSURE_SOFT_BOUND}).
   * `<= 0` disables the check.
   */
  softBound?: number;
}

type HostStaleDtachProbe = (
  env: NodeJS.ProcessEnv,
) => Promise<HostStaleDtachProbeSnapshot | null>;

/**
 * Read the durable prod-smoke-tick alert artifact (issue #2035).
 * Return null when the file is missing, unreadable, or not an alert.
 * Injected in unit tests so hermetic runs never touch the host data dir.
 */
type ProdSmokeTickAlertReader = (alertPath: string) => AlertArtifact | null;

interface RunDoctorDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: Pick<typeof console, 'log' | 'error'>;
  commandRunner?: CommandRunner;
  access?: (path: string, mode?: number) => Promise<void>;
  now?: () => Date;
  /**
   * Optional override for the live /api/health resourceWatchdog probe.
   * Defaults to a short-timeout fetch when KOOKR_API_BASE_URL or KOOKR_PORT is set.
   */
  probeResourceWatchdogEnabled?: ResourceWatchdogEnabledProbe;
  /**
   * Optional override for the live /api/health hungSuspectTtlReclaim probe
   * (issue #2231). Defaults to a short-timeout fetch when KOOKR_API_BASE_URL or
   * KOOKR_PORT is set.
   */
  probeHungSuspectReclaim?: HungSuspectReclaimProbe;
  /**
   * Optional override for the live timer-health maintenancePrune probe.
   * Defaults to a short-timeout fetch of GET /api/diagnostics/timer-health when
   * KOOKR_API_BASE_URL or KOOKR_PORT points at a server.
   */
  probeMaintenancePruneTimer?: MaintenancePruneTimerProbe;
  /**
   * Optional override for the live GET /api/github/status probe (issue #2098).
   * Defaults to a short-timeout fetch when KOOKR_API_BASE_URL or KOOKR_PORT is set.
   */
  probeGithubScannerStatus?: GithubScannerStatusProbe;
  /**
   * Optional override for reading `{dataDir}/prod-smoke-tick-alert.json`.
   * Defaults to {@link readAlertArtifact}. Tests inject a fixture reader so
   * the host `~/.kookr` never leaks into hermetic unit runs.
   */
  readProdSmokeTickAlert?: ProdSmokeTickAlertReader;
  /**
   * Optional override for the live hook-ingestion lag probe (issue #2320).
   * Defaults to a short-timeout fetch of GET /api/diagnostics/hook-ingestion
   * when KOOKR_API_BASE_URL or KOOKR_PORT is set. null = unreachable / skip.
   */
  probeHookIngestionLag?: HookIngestionLagProbe;
  /**
   * Optional override for the live /api/health host-stale dtach mismatch probe
   * (issue #2348). Defaults to a short-timeout fetch when KOOKR_API_BASE_URL or
   * KOOKR_PORT is set. null = unreachable / skip.
   */
  probeHostStaleDtach?: HostStaleDtachProbe;
}

const HELP_TEXT = `kookr doctor — run launch preflight checks.

Usage:
  kookr doctor
  kookr doctor --json
  kookr doctor --strict

Options:
  --json       Print one JSON report to stdout (machine-readable).
  --strict     Exit non-zero when any advisory WARN is present (default: only
               required FAIL checks fail the process).
  -h, --help   Show this help.

Without --json, prints a human-readable table of each check (status, summary,
recommended action) covering runtime tools, gh auth, kb, agent binaries,
github.scanner-backoff (advisory warn when state-fetch rate-limit backoff is active),
ops.resource-watchdog (advisory warn when host-pressure auto-investigation is off),
ops.hung-reclaim (advisory warn when residual hungSuspect is open_pr_failsafe-dominated),
hooks.ingestion-lag (advisory warn when live hook-ingestion notableLagCount > 0),
ops.host-stale-dtach (advisory warn when host staleProcesses.dtach far exceeds sessionReaper orphans),
ops.prod-smoke-tick (advisory warn when the hourly smoke artifact is in alert),
and ops.maintenance-prune (advisory warn when scheduled data-dir prune is off).
`;

const KB_PREFLIGHT_TIMEOUT_MS = 5_000;
const AGENT_PROBE_TIMEOUT_MS = 2_000;
const KB_SMOKE_QUERY = 'kookr launch dependency smoke';
/**
 * Ignore brief state-fetch backoff windows so doctor does not flap WARN during
 * short rate-limit recoveries (issue #2098). Multi-minute pauses surface as WARN.
 */
export const GITHUB_SCANNER_BACKOFF_WARN_MS = 30_000;
const STATUS_LABEL: Record<DoctorCheckStatus, string> = {
  ok: 'OK',
  warn: 'WARN',
  fail: 'FAIL',
};

/**
 * Render a doctor report as an aligned text table (mirrors scripts/doctor.sh
 * print_row: fixed-width label + status + summary, then recommended actions).
 */
export function formatDoctorReport(report: DoctorJsonReport): string {
  const lines: string[] = [
    'Kookr doctor — launch preflight',
    '',
  ];

  for (const check of report.checks) {
    const status = STATUS_LABEL[check.status];
    // label 22 | status 4 | two spaces | summary — same spirit as print_row
    lines.push(`${check.label.padEnd(22)} ${status.padEnd(4)}  ${check.summary}`);
    if (check.detail) {
      lines.push(`${''.padEnd(22)} ${''.padEnd(4)}  ${check.detail}`);
    }
  }

  const actions = report.checks
    .filter((check) => check.status !== 'ok' && check.recommendedAction)
    .map((check) => check.recommendedAction!);

  if (actions.length > 0) {
    lines.push('');
    lines.push('Recommended actions:');
    for (const action of actions) {
      lines.push(`  - ${action}`);
    }
  }

  lines.push('');
  lines.push(`Overall: ${STATUS_LABEL[report.status]}${report.ok ? '' : ' (required checks failed)'}`);
  return lines.join('\n');
}

export async function runDoctorCli(argv = process.argv.slice(2), deps: RunDoctorDeps = {}): Promise<number> {
  const args = parseArgs(argv);
  const out = deps.out ?? console;

  if (args.help) {
    out.log(HELP_TEXT);
    return 0;
  }

  if (args.error) {
    out.error(args.error);
    out.error(HELP_TEXT);
    return 2;
  }

  const report = await buildDoctorJsonReport(deps);
  if (args.json) {
    out.log(JSON.stringify(report, null, 2));
  } else {
    out.log(formatDoctorReport(report));
  }
  // Default: only required FAIL checks fail the process (advisory WARNs allowed).
  // --strict: any advisory WARN also exits non-zero so unattended gates can act.
  if (!report.ok) return 1;
  if (args.strict && report.status === 'warn') return 1;
  return 0;
}

export async function buildDoctorJsonReport(deps: RunDoctorDeps = {}): Promise<DoctorJsonReport> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const run = deps.commandRunner ?? execFileCommand;
  const accessFn = deps.access ?? access;
  const checks: DoctorCheck[] = [];

  checks.push(await checkNode(run));
  checks.push(await checkPnpm(run));
  checks.push(await checkGit(run));
  checks.push(await checkDtach(cwd, accessFn, run));
  checks.push(await checkPersistence(env, accessFn));
  checks.push(await checkGhAuth(run));
  checks.push(await checkGithubScannerBackoff(env, deps.probeGithubScannerStatus));
  checks.push(...await checkKbLaunchDependency(run));
  checks.push(...await checkAgentBinaries(env, run));
  checks.push(await checkResourceWatchdog(env, deps.probeResourceWatchdogEnabled));
  checks.push(await checkHungSuspectReclaim(env, deps.probeHungSuspectReclaim));
  checks.push(await checkHookIngestionLag(env, deps.probeHookIngestionLag));
  checks.push(await checkHostStaleDtach(env, deps.probeHostStaleDtach));
  checks.push(checkProdSmokeTick(env, deps.readProdSmokeTickAlert));
  checks.push(await checkMaintenancePruneSchedule(env, deps.probeMaintenancePruneTimer));

  const status = aggregateStatus(checks);
  return {
    ok: status !== 'fail',
    status,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    checks,
  };
}

function parseArgs(argv: string[]): { json: boolean; strict: boolean; help: boolean; error?: string } {
  const parsed = { json: false, strict: false, help: false, error: undefined as string | undefined };
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
    else if (arg === '--strict') parsed.strict = true;
    else if (arg === '-h' || arg === '--help') parsed.help = true;
    else if (!parsed.error) parsed.error = `Unexpected argument: ${arg}`;
  }
  return parsed;
}

async function checkNode(run: CommandRunner): Promise<DoctorCheck> {
  const result = await run('node', ['--version'], { timeoutMs: 2_000 }).catch(commandErrorResult);
  if (result.exitCode !== 0) {
    return failCheck('runtime.node', 'Node.js', 'runtime', 'Node.js is not available', result.stderr, 'Install Node.js >= 22.');
  }
  const version = result.stdout.trim().replace(/^v/, '');
  if (versionAtLeast(version, '22.0.0')) {
    return okCheck('runtime.node', 'Node.js', 'runtime', `v${version} satisfies >= 22`, true);
  }
  return failCheck('runtime.node', 'Node.js', 'runtime', `Node.js v${version} is below the required >= 22`, undefined, 'Install Node.js >= 22.');
}

async function checkPnpm(run: CommandRunner): Promise<DoctorCheck> {
  const result = await run('pnpm', ['--version'], { timeoutMs: 2_000 }).catch(commandErrorResult);
  if (result.exitCode !== 0) {
    return failCheck('runtime.pnpm', 'pnpm', 'runtime', 'pnpm is not available', result.stderr, 'Run `corepack enable` or install pnpm >= 10.');
  }
  const version = result.stdout.trim();
  if (versionAtLeast(version, '10.0.0')) {
    return okCheck('runtime.pnpm', 'pnpm', 'runtime', `${version} satisfies >= 10`, true);
  }
  return failCheck('runtime.pnpm', 'pnpm', 'runtime', `pnpm ${version} is below the required >= 10`, undefined, 'Run `corepack enable` or install pnpm >= 10.');
}

async function checkGit(run: CommandRunner): Promise<DoctorCheck> {
  const result = await run('git', ['--version'], { timeoutMs: 2_000 }).catch(commandErrorResult);
  if (result.exitCode !== 0) {
    return failCheck('runtime.git', 'git', 'runtime', 'git is not available', result.stderr, 'Install git before launching agents from repository worktrees.');
  }
  return okCheck('runtime.git', 'git', 'runtime', result.stdout.trim(), true);
}

async function checkDtach(
  cwd: string,
  accessFn: (path: string, mode?: number) => Promise<void>,
  run: CommandRunner,
): Promise<DoctorCheck> {
  const dtachPath = join(cwd, 'vendor', 'dtach', 'dtach');
  try {
    await accessFn(dtachPath, constants.X_OK);
    return okCheck('runtime.dtach', 'dtach binary', 'runtime', 'vendor/dtach/dtach is executable', true);
  } catch {
    // Mirror server startup: prefer the vendored binary, but accept a system
    // dtach resolved by PATH when the vendored copy is unavailable.
    const systemDtach = await run('dtach', ['-V'], { timeoutMs: 2_000 }).catch(commandErrorResult);
    if (systemDtach.exitCode === 0) {
      return okCheck('runtime.dtach', 'dtach binary', 'runtime', 'system dtach is available on PATH', true);
    }
    return failCheck(
      'runtime.dtach',
      'dtach binary',
      'runtime',
      'dtach is unavailable from both vendor/dtach/dtach and PATH',
      firstNonEmpty(systemDtach.stderr, systemDtach.stdout, dtachPath),
      'Run `pnpm build:dtach` to compile the vendored copy, or install dtach via your package manager.',
    );
  }
}

/**
 * Operator-facing parity with the server readiness probe (issue #2155): the
 * data dir must be writable or Kookr cannot persist state. Mirrors
 * `checkPersistenceWritable` in diagnostics-routes.ts (`accessSync(dir, W_OK)`
 * wired into `/api/ready`, a *critical* readiness check). A full disk, a
 * read-only mount, or a permissions change surfaces the errno (`EACCES`,
 * `EROFS`, …) at preflight instead of later as opaque write errors.
 *
 * One deliberate divergence from the server check: `kookr doctor` is a
 * *pre-launch* preflight, but the data dir is created lazily by the server at
 * startup (single-writer-lock `mkdirSync`). The server's check only ever runs
 * once the dir already exists; doctor can run before first launch, when the
 * default `~/.kookr` legitimately does not exist yet. So a missing-but-creatable
 * dir (`ENOENT` with a writable parent) is an advisory WARN, not a required
 * FAIL — otherwise every fresh host would fail doctor on an otherwise healthy
 * machine. A dir that exists but is unwritable, or one that cannot be created
 * because its parent is also unwritable, remains a required FAIL.
 */
async function checkPersistence(
  env: NodeJS.ProcessEnv,
  accessFn: (path: string, mode?: number) => Promise<void>,
): Promise<DoctorCheck> {
  const dataDir = resolveDoctorKookrDataDir(env);
  try {
    await accessFn(dataDir, constants.W_OK);
    return okCheck('runtime.persistence', 'Data dir writable', 'runtime', `${dataDir} is writable`, true);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') {
      // Missing dir: distinguish "not created yet, but creatable" (benign on a
      // fresh host) from "cannot be created" (a real failure). The server
      // creates the dir with `mkdirSync(..., { recursive: true })`, so the whole
      // chain is creatable as long as the *nearest existing ancestor* is
      // writable. Walk up (bounded) until an ancestor resolves (writable →
      // creatable) or rejects with a non-ENOENT errno (e.g. EACCES/EROFS → not
      // creatable). Checking only the immediate parent would false-FAIL a nested
      // KOOKR_DIR whose intermediate dirs the server would have created.
      let ancestor = dirname(dataDir);
      for (let depth = 0; depth < 64; depth += 1) {
        let ancestorErrno: string | undefined;
        try {
          await accessFn(ancestor, constants.W_OK);
        } catch (ancestorErr) {
          ancestorErrno = errnoOf(ancestorErr);
        }
        if (ancestorErrno === undefined) {
          return {
            id: 'runtime.persistence',
            label: 'Data dir writable',
            category: 'runtime',
            status: 'warn',
            required: false,
            summary: 'Kookr data dir does not exist yet; the server creates it at startup',
            detail: `${dataDir}: ENOENT (creatable — nearest existing ancestor ${ancestor} is writable)`,
            recommendedAction:
              'No action needed for a fresh install — the server creates the data dir on first launch. ' +
              'If it existed before, investigate why it disappeared (unexpected deletion, or a wrong KOOKR_DIR/KOOKR_PORT pointing doctor at the wrong path).',
          };
        }
        const parent = dirname(ancestor);
        if (ancestorErrno === 'ENOENT' && parent !== ancestor) {
          ancestor = parent;
          continue;
        }
        return failCheck(
          'runtime.persistence',
          'Data dir writable',
          'runtime',
          `Kookr data dir cannot be created (${ancestorErrno})`,
          `${dataDir}: nearest resolvable ancestor ${ancestor} ${ancestorErrno}`,
          'Ensure the Kookr data dir (KOOKR_DIR or ~/.kookr) can be created — check that an ancestor dir is writable, plus disk space, mount flags (read-only?), and permissions.',
        );
      }
    }
    const errno = errnoOf(err);
    return failCheck(
      'runtime.persistence',
      'Data dir writable',
      'runtime',
      `Kookr data dir is not writable (${errno})`,
      `${dataDir}: ${errno}`,
      'Ensure the Kookr data dir (KOOKR_DIR or ~/.kookr) is writable — check disk space, mount flags (read-only?), and permissions.',
    );
  }
}

/** errno code from a rejected `access`, falling back to a generic label. */
function errnoOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && code ? code : 'unwritable';
}

async function checkGhAuth(run: CommandRunner): Promise<DoctorCheck> {
  const result = await run('gh', ['auth', 'status'], { timeoutMs: 5_000 }).catch(commandErrorResult);
  if (result.exitCode === 0) {
    return okCheck('github.gh-auth', 'GitHub auth', 'github', 'gh auth status passed', false);
  }
  return {
    id: 'github.gh-auth',
    label: 'GitHub auth',
    category: 'github',
    status: 'warn',
    required: false,
    summary: 'gh authentication is unavailable or not configured',
    detail: firstNonEmpty(result.stderr, result.stdout),
    recommendedAction: 'Run `gh auth login` if you want GitHub PR/issue monitoring and automation.',
  };
}

/**
 * Advisory github check (issue #2098): surface that the GitHub scanner is in a
 * multi-minute state-fetch rate-limit backoff so operators do not mis-attribute
 * stale PR/issue cards to a "broken scanner" after SSH preflight.
 *
 * - stateFetchBackoffMs >= {@link GITHUB_SCANNER_BACKOFF_WARN_MS} → WARN
 * - probe null / unreachable / no API base → OK with "probe skipped" (hermetic)
 * - Never a required fail; gh-auth remains the only hard-ish github signal
 */
async function checkGithubScannerBackoff(
  env: NodeJS.ProcessEnv,
  probe: GithubScannerStatusProbe | undefined,
): Promise<DoctorCheck> {
  const probeFn = probe ?? defaultProbeGithubScannerStatus;
  let snap: GithubStatusSnapshot | null = null;
  try {
    snap = await probeFn(env);
  } catch {
    snap = null;
  }

  if (!snap) {
    return okCheck(
      'github.scanner-backoff',
      'GitHub scanner backoff',
      'github',
      'probe skipped (no KOOKR_API_BASE_URL / KOOKR_PORT, or status unreachable)',
      false,
    );
  }

  if (snap.stateFetchBackoffMs >= GITHUB_SCANNER_BACKOFF_WARN_MS) {
    const remainingSec = Math.ceil(snap.stateFetchBackoffMs / 1000);
    return {
      id: 'github.scanner-backoff',
      label: 'GitHub scanner backoff',
      category: 'github',
      status: 'warn',
      required: false,
      summary:
        `state-fetch rate-limit backoff active: remaining≈${remainingSec}s, ` +
        `trackedRefCount=${snap.trackedRefCount}`,
      detail:
        `GET /api/github/status stateFetchBackoffMs=${snap.stateFetchBackoffMs}` +
        (snap.repoHealthBackoffMs > 0 ? ` repoHealthBackoffMs=${snap.repoHealthBackoffMs}` : '') +
        ` active=${snap.active}`,
      recommendedAction:
        'Wait for the GitHub rate-limit reset, reduce tracked terminal refs, or check `gh api rate_limit`. ' +
        'PR/issue cards may stay stale until state-fetch resumes.',
    };
  }

  return okCheck(
    'github.scanner-backoff',
    'GitHub scanner backoff',
    'github',
    snap.stateFetchBackoffMs > 0
      ? `state-fetch backoff ${snap.stateFetchBackoffMs}ms is below ${GITHUB_SCANNER_BACKOFF_WARN_MS}ms threshold (trackedRefCount=${snap.trackedRefCount})`
      : `no state-fetch rate-limit backoff (trackedRefCount=${snap.trackedRefCount})`,
    false,
  );
}

function normalizeResourceWatchdogProbe(
  value: boolean | ResourceWatchdogProbeSnapshot | null,
): ResourceWatchdogProbeSnapshot | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return { enabled: value };
  if (typeof value.enabled === 'boolean') return value;
  return null;
}

/**
 * Advisory ops check (issue #1988 / #2354): surface that continuous host-pressure
 * monitoring is off by default, and elevate when live health shows
 * pressureWhileDisabled / lastDecision under auto-enable. Prefer live
 * /api/health when reachable; otherwise env flag. Never fails required checks —
 * warn only.
 */
async function checkResourceWatchdog(
  env: NodeJS.ProcessEnv,
  probe: ResourceWatchdogEnabledProbe | undefined,
): Promise<DoctorCheck> {
  const envEnabled = isTruthyEnvFlag(env.KOOKR_RESOURCE_WATCHDOG);
  const probeFn = probe ?? defaultProbeResourceWatchdogEnabled;
  let live: ResourceWatchdogProbeSnapshot | null = null;
  try {
    live = normalizeResourceWatchdogProbe(await probeFn(env));
  } catch {
    live = null;
  }

  const enabled = live?.enabled ?? envEnabled;
  if (enabled) {
    return okCheck(
      'ops.resource-watchdog',
      'Resource watchdog',
      'ops',
      live?.enabled === true
        ? 'enabled (GET /api/health resourceWatchdog.enabled=true)'
        : 'enabled (KOOKR_RESOURCE_WATCHDOG is truthy)',
      false,
    );
  }

  const underPressure = live?.pressureWhileDisabled === true;
  const lastDecision = live?.lastDecision ?? null;
  const autoEnable = live?.autoEnableOnPressure;
  const reason = live?.pressureWhileDisabledReason?.trim() || null;

  if (underPressure) {
    const decisionNote = lastDecision ? ` lastDecision=${lastDecision}.` : '';
    const autoNote =
      autoEnable === false
        ? ' Auto-enable is off (page-only).'
        : autoEnable === true
          ? ' Auto-enable-on-pressure is armed (rate-limited investigation may spawn).'
          : '';
    return {
      id: 'ops.resource-watchdog',
      label: 'Resource watchdog',
      category: 'ops',
      status: 'warn',
      required: false,
      summary:
        'resourceWatchdog disabled under host pressure (pressureWhileDisabled=true)',
      detail:
        (reason
          ? `GET /api/health resourceWatchdog.pressureWhileDisabled: ${reason}.`
          : 'GET /api/health reports resourceWatchdog.enabled=false with pressureWhileDisabled=true.') +
        decisionNote +
        autoNote,
      recommendedAction:
        'Set KOOKR_RESOURCE_WATCHDOG=1 for continuous monitoring, or keep auto-enable ' +
        '(default) for rate-limited investigation spawns under soft-bound pressure. ' +
        'Set KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0 only for deliberate page-only mode.',
    };
  }

  return {
    id: 'ops.resource-watchdog',
    label: 'Resource watchdog',
    category: 'ops',
    status: 'warn',
    required: false,
    summary: 'host-pressure continuous monitoring is disabled',
    detail: live?.enabled === false
      ? 'GET /api/health reports resourceWatchdog.enabled=false'
      : 'KOOKR_RESOURCE_WATCHDOG is unset or not truthy (disabled by default; ' +
        'auto-enable-on-pressure still arms rate-limited investigation under soft-bound pressure)',
    recommendedAction:
      'Set KOOKR_RESOURCE_WATCHDOG=1 (or true/yes/on) and restart the server for continuous ' +
      'host-pressure monitoring. Soft-bound pressure still auto-enables a rate-limited ' +
      'investigation by default (KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE).',
  };
}

/**
 * Advisory ops check (issue #2320): WARN when a reachable server reports elevated
 * hook-ingestion lag (`notableLagCount > 0`). Soft-skip when the server is
 * unreachable so hermetic offline doctor stays green. Never required:fail.
 *
 * Threshold defaults to any notable lag (>0), aligned with
 * `lagWarningThresholdMs` already applied inside HookIngestion diagnostics.
 */
async function checkHookIngestionLag(
  env: NodeJS.ProcessEnv,
  probe: HookIngestionLagProbe | undefined,
): Promise<DoctorCheck> {
  const probeFn = probe ?? defaultProbeHookIngestionLag;
  let snap: HookIngestionLagProbeSnapshot | null = null;
  try {
    snap = await probeFn(env);
  } catch {
    snap = null;
  }

  if (!snap) {
    return okCheck(
      'hooks.ingestion-lag',
      'Hook ingestion lag',
      'ops',
      'probe skipped (no KOOKR_API_BASE_URL / KOOKR_PORT, or diagnostics unreachable)',
      false,
    );
  }

  if (snap.notableLagCount > 0) {
    return {
      id: 'hooks.ingestion-lag',
      label: 'Hook ingestion lag',
      category: 'ops',
      status: 'warn',
      required: false,
      summary:
        `elevated hook-ingestion lag: notableLagCount=${snap.notableLagCount} ` +
        `across ${snap.sessionCount} session(s)`,
      detail:
        `GET /api/diagnostics/hook-ingestion reports notableLagCount=${snap.notableLagCount} ` +
        `(threshold lagWarningThresholdMs=${snap.lagWarningThresholdMs}). ` +
        'Dashboard may look fine while agents go silent under data-plane stall.',
      recommendedAction:
        'Inspect GET /api/diagnostics/hook-ingestion and event-loop / capacity pressure; ' +
        'consider prod:update if the server is on a stale build, and reduce co-tenant RAM pressure.',
    };
  }

  return okCheck(
    'hooks.ingestion-lag',
    'Hook ingestion lag',
    'ops',
    snap.sessionCount === 0
      ? 'no tracked sessions (idle)'
      : `notableLagCount=0 across ${snap.sessionCount} session(s)`,
    false,
  );
}

/**
 * Advisory ops check (issue #2348): WARN when host-wide `staleProcesses.dtach`
 * far exceeds what the session reaper reports as orphans/leaks.
 *
 * Live prod pattern: `staleProcesses.dtach.count=23` while
 * `sessionReaper.lastOrphanCount=0` and `lastTerminalLeakCount=0` — host-stale
 * masters accumulate outside TaskStore; reaper (#1720) cannot see them, and
 * doctor previously stayed green.
 *
 * WARN when `hostExcess = dtachCount - (lastOrphanCount + lastTerminalLeakCount)`
 * is ≥ soft bound (default {@link DEFAULT_DTACH_PRESSURE_SOFT_BOUND}). Soft-skip
 * when the server is unreachable so hermetic offline doctor stays green.
 * Never required:fail. Does not enable kill/spawn paths.
 */
async function checkHostStaleDtach(
  env: NodeJS.ProcessEnv,
  probe: HostStaleDtachProbe | undefined,
): Promise<DoctorCheck> {
  const probeFn = probe ?? defaultProbeHostStaleDtach;
  let snap: HostStaleDtachProbeSnapshot | null = null;
  try {
    snap = await probeFn(env);
  } catch {
    snap = null;
  }

  if (!snap) {
    return okCheck(
      'ops.host-stale-dtach',
      'Host-stale dtach',
      'ops',
      'probe skipped (no KOOKR_API_BASE_URL / KOOKR_PORT, or health unreachable)',
      false,
    );
  }

  const softBound = snap.softBound ?? DEFAULT_DTACH_PRESSURE_SOFT_BOUND;
  const reaperVisible = snap.lastOrphanCount + snap.lastTerminalLeakCount;
  const hostExcess = Math.max(0, snap.dtachCount - reaperVisible);
  const mismatch = softBound > 0 && hostExcess >= softBound;

  if (mismatch) {
    return {
      id: 'ops.host-stale-dtach',
      label: 'Host-stale dtach',
      category: 'ops',
      status: 'warn',
      required: false,
      summary:
        `${HOST_STALE_DTACH_MISMATCH_CODE}: staleProcesses.dtach.count=${snap.dtachCount} ` +
        `sessionReaper.lastOrphanCount=${snap.lastOrphanCount} ` +
        `lastTerminalLeakCount=${snap.lastTerminalLeakCount} ` +
        `(hostExcess=${hostExcess} ≥ softBound=${softBound})`,
      detail:
        `code=${HOST_STALE_DTACH_MISMATCH_CODE} GET /api/health ` +
        `staleProcesses.dtach.count=${snap.dtachCount} while ` +
        `sessionReaper.lastOrphanCount=${snap.lastOrphanCount} + ` +
        `lastTerminalLeakCount=${snap.lastTerminalLeakCount} ` +
        `(reaper-visible=${reaperVisible}, hostExcess=${hostExcess}, softBound=${softBound}). ` +
        'Host-stale dtach masters accumulate outside TaskStore; session reaper cannot see them.',
      recommendedAction:
        'Enable KOOKR_RESOURCE_WATCHDOG=1 for host-pressure auto-investigation; ' +
        'inspect GET /api/health staleProcesses and sessionReaper; ' +
        'consider a host-stale janitor for masters not owned by TaskStore. ' +
        'Restart only as last resort — do not invent kill logic from doctor.',
    };
  }

  return okCheck(
    'ops.host-stale-dtach',
    'Host-stale dtach',
    'ops',
    `staleProcesses.dtach.count=${snap.dtachCount} ` +
      `sessionReaper.lastOrphanCount=${snap.lastOrphanCount} ` +
      `lastTerminalLeakCount=${snap.lastTerminalLeakCount} ` +
      `(hostExcess=${hostExcess} < softBound=${softBound})`,
    false,
  );
}

/**
 * Advisory ops check (issue #2231): surface residual hungSuspect capacity held
 * behind open-PR fail-safe when the TTL reclaim has never reclaimed a slot.
 * Operator offline recovery runs doctor first; without this, failsafe-dominated
 * residual only shows up via manual `/api/health` spelunking.
 *
 * WARN only when all hold:
 * - capacity.byClass.hungSuspect > 0
 * - hungSuspectTtlReclaim.reclaimedTotal === 0
 * - last reclaim pass is open_pr_failsafe-dominated (plurality of lastOutcomes)
 *
 * Probe null / unreachable → OK (hermetic offline). Never a required fail.
 */
async function checkHungSuspectReclaim(
  env: NodeJS.ProcessEnv,
  probe: HungSuspectReclaimProbe | undefined,
): Promise<DoctorCheck> {
  const probeFn = probe ?? defaultProbeHungSuspectReclaim;
  let snap: HungSuspectReclaimProbeSnapshot | null = null;
  try {
    snap = await probeFn(env);
  } catch {
    snap = null;
  }

  if (!snap) {
    return okCheck(
      'ops.hung-reclaim',
      'Hung-suspect reclaim',
      'ops',
      'probe skipped (no KOOKR_API_BASE_URL / KOOKR_PORT, or health unreachable)',
      false,
    );
  }

  const openPrLastPass = countLastPassOpenPrFailsafes(snap.lastOutcomes);
  const lastPassTotal = snap.lastOutcomes.length;
  const failsafeDominated = isOpenPrFailsafeDominatedLastPass(snap.lastOutcomes);

  if (
    snap.hungSuspectCount > 0
    && snap.reclaimedTotal === 0
    && failsafeDominated
  ) {
    return {
      id: 'ops.hung-reclaim',
      label: 'Hung-suspect reclaim',
      category: 'ops',
      status: 'warn',
      required: false,
      summary:
        `hungSuspect residual blocked by open_pr failsafe: ` +
        `hungSuspect=${snap.hungSuspectCount} reclaimedTotal=0 ` +
        `openPrSkips=${openPrLastPass}/${lastPassTotal} last pass`,
      detail:
        `GET /api/health capacity.byClass.hungSuspect=${snap.hungSuspectCount} ` +
        `hungSuspectTtlReclaim.reclaimedTotal=0 reclaimAttempted=${snap.reclaimAttempted} ` +
        `skippedOpenPrFailsafe=${snap.skippedOpenPrFailsafe} (lifetime) ` +
        `lastCandidatesConsidered=${snap.lastCandidatesConsidered}. ` +
        `Open-PR fail-safe intentionally holds reclaim; verify tasks still hold open/unknown PRs.`,
      recommendedAction:
        'Inspect GET /api/health hungSuspectTtlReclaim.lastOutcomes and capacity.byClass.hungSuspect. ' +
        'Confirm residual tasks still hold open PRs (fail-safe treats unknown like a hold). ' +
        'Complete, merge, or cancel stranded work so slots free — do not weaken open-PR fail-safes. ' +
        'See docs/reference/offline-recovery-card.md §3.',
    };
  }

  if (snap.hungSuspectCount === 0) {
    return okCheck(
      'ops.hung-reclaim',
      'Hung-suspect reclaim',
      'ops',
      `no hungSuspect residual (reclaimedTotal=${snap.reclaimedTotal})`,
      false,
    );
  }

  if (snap.reclaimedTotal > 0) {
    return okCheck(
      'ops.hung-reclaim',
      'Hung-suspect reclaim',
      'ops',
      `reclaim progressing: hungSuspect=${snap.hungSuspectCount} reclaimedTotal=${snap.reclaimedTotal}`,
      false,
    );
  }

  // Residual exists and reclaimedTotal=0, but last pass is not open_pr-dominated
  // (e.g. under-TTL after restart, provider pause, or empty last pass).
  const dominantHint = lastPassTotal === 0
    ? 'no last-pass outcomes yet'
    : `last pass not open_pr-dominated (openPrSkips=${openPrLastPass}/${lastPassTotal})`;
  return okCheck(
    'ops.hung-reclaim',
    'Hung-suspect reclaim',
    'ops',
    `hungSuspect=${snap.hungSuspectCount} reclaimedTotal=0 (${dominantHint})`,
    false,
  );
}

/**
 * Last-pass open_pr fail-safe dominates when it is the plurality among
 * `lastOutcomes` (ties for first still count — residual is still held by the
 * fail-safe). Empty last pass → not dominated (cannot attribute residual yet).
 *
 * Issue #2228: confirmed + unknown outcomes both count as open_pr fail-safe
 * (legacy `skipped_open_pr_failsafe` kept for older health snapshots).
 */
export function isOpenPrFailsafeDominatedLastPass(
  lastOutcomes: ReadonlyArray<{ outcome: string }>,
): boolean {
  if (lastOutcomes.length === 0) return false;
  const openPr = countLastPassOpenPrFailsafes(lastOutcomes);
  if (openPr === 0) return false;
  const otherCounts = new Map<string, number>();
  for (const entry of lastOutcomes) {
    if (isOpenPrFailsafeOutcome(entry.outcome)) continue;
    otherCounts.set(entry.outcome, (otherCounts.get(entry.outcome) ?? 0) + 1);
  }
  const maxOther = otherCounts.size === 0
    ? 0
    : Math.max(...otherCounts.values());
  return openPr >= maxOther;
}

function isOpenPrFailsafeOutcome(outcome: string): boolean {
  return (
    outcome === 'skipped_open_pr_failsafe'
    || outcome === 'skipped_open_pr_confirmed'
    || outcome === 'skipped_open_pr_unknown'
  );
}

function countLastPassOpenPrFailsafes(
  lastOutcomes: ReadonlyArray<{ outcome: string }>,
): number {
  let n = 0;
  for (const entry of lastOutcomes) {
    if (isOpenPrFailsafeOutcome(entry.outcome)) n += 1;
  }
  return n;
}

/**
 * Advisory ops check (issue #2080): surface that the scheduled maintenance prune
 * is off by default (`KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS` unset/0). Disk/log
 * growth under unattended multi-day runs is a host-class failure operators
 * cannot discover without reading lifecycle code — doctor makes it visible.
 *
 * - intervalHours <= 0 → WARN with remediation to set interval=24
 * - intervalHours > 0 → OK; optional timer-health lastFiredAt enriches summary
 * - Never a required fail; use `kookr doctor --strict` to exit non-zero on WARN
 */
async function checkMaintenancePruneSchedule(
  env: NodeJS.ProcessEnv,
  probe: MaintenancePruneTimerProbe | undefined,
): Promise<DoctorCheck> {
  const intervalHours = resolveMaintenancePruneIntervalHours(env);
  const probeFn = probe ?? defaultProbeMaintenancePruneTimer;
  let live: { lastFiredAt: string | null } | null = null;
  try {
    live = await probeFn(env);
  } catch {
    live = null;
  }

  if (intervalHours > 0) {
    let summary = `scheduled every ${intervalHours}h (KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS=${intervalHours})`;
    if (live) {
      summary = live.lastFiredAt
        ? `scheduled every ${intervalHours}h (timer-health lastFiredAt=${live.lastFiredAt})`
        : `scheduled every ${intervalHours}h (timer registered; not fired yet)`;
    }
    return okCheck(
      'ops.maintenance-prune',
      'Maintenance prune',
      'ops',
      summary,
      false,
    );
  }

  return {
    id: 'ops.maintenance-prune',
    label: 'Maintenance prune',
    category: 'ops',
    status: 'warn',
    required: false,
    summary: 'scheduled data-dir prune is disabled',
    detail:
      'KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS is unset, 0, or non-positive (opt-in only). ' +
      'Aged hooks/logs/playbook-state will not be reclaimed automatically.',
    recommendedAction:
      'Set KOOKR_MAINTENANCE_PRUNE_INTERVAL_HOURS=24 and restart the server so unattended multi-day runs reclaim aged data-dir artifacts.',
  };
}

/**
 * Advisory ops check (issue #2035): surface a sustained prod-smoke-tick failure
 * streak from the durable on-disk alert artifact so doctor/preflight show the
 * same signal autonomous recovery already has on disk / on /api/health.
 *
 * - status=alert → WARN with consecutiveFailures + failingChecks
 * - status=ok or artifact missing/unreadable → OK (no warn)
 * - Never a required fail; use `kookr doctor --strict` to exit non-zero on WARN
 */
function checkProdSmokeTick(
  env: NodeJS.ProcessEnv,
  reader: ProdSmokeTickAlertReader | undefined,
): DoctorCheck {
  const dataDir = resolveDoctorKookrDataDir(env);
  const alertPath = prodSmokeTickAlertPath(dataDir);
  const read = reader ?? readAlertArtifact;
  let artifact: AlertArtifact | null = null;
  try {
    artifact = read(alertPath);
  } catch {
    artifact = null;
  }

  if (!artifact || artifact.status !== 'alert') {
    return okCheck(
      'ops.prod-smoke-tick',
      'Prod smoke tick',
      'ops',
      !artifact
        ? `no alert artifact at ${alertPath}`
        : 'hourly prod smoke tick is healthy (status=ok)',
      false,
    );
  }

  const consecutive = artifact.consecutiveFailures ?? 0;
  const failing = artifact.failingChecks.length > 0
    ? artifact.failingChecks.join(', ')
    : 'unknown';
  const since = artifact.firstFailedAt ?? artifact.generatedAt;

  return {
    id: 'ops.prod-smoke-tick',
    label: 'Prod smoke tick',
    category: 'ops',
    status: 'warn',
    required: false,
    summary:
      `hourly smoke failing: consecutiveFailures=${consecutive}, failingChecks=[${failing}]`,
    detail:
      `Artifact ${alertPath} status=alert` +
      (since ? ` since ${since}` : '') +
      `. Inspect failingChecks; do not delete the artifact alone — see unattended-recovery-runbook §4.`,
    recommendedAction:
      'Inspect prod-smoke-tick-alert.json failingChecks (and GET /api/health prodSmokeTick). ' +
      'Fix the root cause (adapter version-probe, health latency, etc.); see docs/reference/unattended-recovery-runbook.md §4.',
  };
}

/**
 * Data dir for the smoke-tick artifact: explicit `KOOKR_DIR` wins, else the
 * same port-based default as `kookr maintenance` (`~/.kookr` / `~/.kookr-<port>`).
 */
function resolveDoctorKookrDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.KOOKR_DIR?.trim();
  if (explicit) return explicit;
  return resolveKookrDataDir(env);
}

/** Same truthy semantics as `readResourceWatchdogConfigFromEnv` (1/true/yes/on). */
function isTruthyEnvFlag(raw: string | undefined): boolean {
  if (raw == null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Best-effort live probe. Only hits the network when the operator has pointed
 * at a server (`KOOKR_API_BASE_URL` or numeric `KOOKR_PORT`) — no auto 4800/4801
 * scan, so hermetic unit tests with empty env stay offline.
 */
async function defaultProbeResourceWatchdogEnabled(
  env: NodeJS.ProcessEnv,
): Promise<ResourceWatchdogProbeSnapshot | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/health`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      resourceWatchdog?: {
        enabled?: unknown;
        pressureWhileDisabled?: unknown;
        pressureWhileDisabledReason?: unknown;
        lastDecision?: unknown;
        autoEnableOnPressure?: unknown;
      };
    };
    const rw = body?.resourceWatchdog;
    if (typeof rw?.enabled !== 'boolean') return null;
    return {
      enabled: rw.enabled,
      ...(typeof rw.pressureWhileDisabled === 'boolean'
        ? { pressureWhileDisabled: rw.pressureWhileDisabled }
        : {}),
      ...(typeof rw.pressureWhileDisabledReason === 'string' || rw.pressureWhileDisabledReason === null
        ? { pressureWhileDisabledReason: rw.pressureWhileDisabledReason as string | null }
        : {}),
      ...(typeof rw.lastDecision === 'string' || rw.lastDecision === null
        ? { lastDecision: rw.lastDecision as string | null }
        : {}),
      ...(typeof rw.autoEnableOnPressure === 'boolean'
        ? { autoEnableOnPressure: rw.autoEnableOnPressure }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort live probe of hungSuspect residual + TTL reclaim counters from
 * GET /api/health (issue #2231). Same base-URL gate as resourceWatchdog —
 * hermetic offline doctor stays green without scanning default ports.
 */
async function defaultProbeHungSuspectReclaim(
  env: NodeJS.ProcessEnv,
): Promise<HungSuspectReclaimProbeSnapshot | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/health`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseHungSuspectReclaimHealthBody(body);
  } catch {
    return null;
  }
}

/** Parse capacity.byClass.hungSuspect + hungSuspectTtlReclaim from /api/health JSON. */
export function parseHungSuspectReclaimHealthBody(
  body: unknown,
): HungSuspectReclaimProbeSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as {
    capacity?: { byClass?: { hungSuspect?: unknown } };
    hungSuspectTtlReclaim?: {
      reclaimedTotal?: unknown;
      reclaimAttempted?: unknown;
      skippedOpenPrFailsafe?: unknown;
      skippedUnderTtl?: unknown;
      skippedNoLiveness?: unknown;
      skippedProviderPaused?: unknown;
      lastCandidatesConsidered?: unknown;
      lastOutcomes?: unknown;
    };
  };

  const reclaim = root.hungSuspectTtlReclaim;
  if (!reclaim || typeof reclaim !== 'object') return null;

  const hungSuspectRaw = root.capacity?.byClass?.hungSuspect;
  const hungSuspectCount = typeof hungSuspectRaw === 'number' && Number.isFinite(hungSuspectRaw)
    ? Math.max(0, Math.floor(hungSuspectRaw))
    : 0;

  const reclaimedTotal = nonNegInt(reclaim.reclaimedTotal);
  const reclaimAttempted = nonNegInt(reclaim.reclaimAttempted);
  const skippedOpenPrFailsafe = nonNegInt(reclaim.skippedOpenPrFailsafe);
  const skippedUnderTtl = nonNegInt(reclaim.skippedUnderTtl);
  const skippedNoLiveness = nonNegInt(reclaim.skippedNoLiveness);
  const skippedProviderPaused = nonNegInt(reclaim.skippedProviderPaused);
  const lastCandidatesConsidered = nonNegInt(reclaim.lastCandidatesConsidered);

  if (
    reclaimedTotal === null
    || reclaimAttempted === null
    || skippedOpenPrFailsafe === null
  ) {
    return null;
  }

  const lastOutcomes: Array<{ outcome: string }> = [];
  if (Array.isArray(reclaim.lastOutcomes)) {
    for (const entry of reclaim.lastOutcomes) {
      if (!entry || typeof entry !== 'object') continue;
      const outcome = (entry as { outcome?: unknown }).outcome;
      if (typeof outcome === 'string' && outcome.length > 0) {
        lastOutcomes.push({ outcome });
      }
    }
  }

  return {
    hungSuspectCount,
    reclaimedTotal,
    reclaimAttempted,
    skippedOpenPrFailsafe,
    skippedUnderTtl: skippedUnderTtl ?? 0,
    skippedNoLiveness: skippedNoLiveness ?? 0,
    skippedProviderPaused: skippedProviderPaused ?? 0,
    lastCandidatesConsidered: lastCandidatesConsidered ?? 0,
    lastOutcomes,
  };
}

function nonNegInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/**
 * Best-effort live probe of maintenancePrune on timer-health. Only hits the
 * network when the operator has pointed at a server (`KOOKR_API_BASE_URL` or
 * numeric `KOOKR_PORT`) — no auto 4800/4801 scan.
 */
async function defaultProbeMaintenancePruneTimer(
  env: NodeJS.ProcessEnv,
): Promise<{ lastFiredAt: string | null } | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/diagnostics/timer-health`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      loops?: Array<{ name?: unknown; lastFiredAt?: unknown }>;
    };
    const loop = body?.loops?.find((entry) => entry?.name === 'maintenancePrune');
    if (!loop) return null;
    if (loop.lastFiredAt === null) return { lastFiredAt: null };
    if (typeof loop.lastFiredAt === 'string') return { lastFiredAt: loop.lastFiredAt };
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort live probe of GET /api/github/status (issue #2098). Only hits the
 * network when `KOOKR_API_BASE_URL` or numeric `KOOKR_PORT` is set — hermetic
 * offline doctor stays green without scanning default ports.
 */
async function defaultProbeGithubScannerStatus(
  env: NodeJS.ProcessEnv,
): Promise<GithubStatusSnapshot | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/github/status`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseGithubStatusBody(body);
  } catch {
    return null;
  }
}

/**
 * Best-effort live probe of GET /api/diagnostics/hook-ingestion (issue #2320).
 * Only hits the network when the operator pointed at a server. Hermetic
 * offline doctor skips with OK.
 */
async function defaultProbeHookIngestionLag(
  env: NodeJS.ProcessEnv,
): Promise<HookIngestionLagProbeSnapshot | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/diagnostics/hook-ingestion`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseHookIngestionLagDiagnosticsBody(body);
  } catch {
    return null;
  }
}

/** Parse notableLagCount/sessionCount from diagnostics hook-ingestion JSON. */
export function parseHookIngestionLagDiagnosticsBody(
  body: unknown,
): HookIngestionLagProbeSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as {
    ingestion?: {
      sessionCount?: unknown;
      notableLagCount?: unknown;
      lagWarningThresholdMs?: unknown;
    };
  };
  const ingestion = root.ingestion;
  if (!ingestion || typeof ingestion !== 'object') return null;

  const sessionCount = nonNegInt(ingestion.sessionCount);
  const notableLagCount = nonNegInt(ingestion.notableLagCount);
  const lagWarningThresholdMs = nonNegInt(ingestion.lagWarningThresholdMs);
  if (sessionCount === null || notableLagCount === null) return null;

  return {
    sessionCount,
    notableLagCount,
    lagWarningThresholdMs: lagWarningThresholdMs ?? 2000,
  };
}

/**
 * Best-effort live probe of host-stale dtach vs sessionReaper gauges from
 * GET /api/health (issue #2348). Same base-URL gate as other health probes —
 * hermetic offline doctor stays green without scanning default ports.
 */
async function defaultProbeHostStaleDtach(
  env: NodeJS.ProcessEnv,
): Promise<HostStaleDtachProbeSnapshot | null> {
  const base = resolveOptionalHealthBase(env);
  if (!base) return null;

  const headers: Record<string, string> = {};
  const token = env.KOOKR_API_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`${base}/api/health`, {
      headers,
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseHostStaleDtachHealthBody(body);
  } catch {
    return null;
  }
}

/**
 * Parse `staleProcesses.dtach` + `sessionReaper` orphan gauges from /api/health.
 * Requires both blocks so a partial payload does not false-WARN.
 */
export function parseHostStaleDtachHealthBody(
  body: unknown,
): HostStaleDtachProbeSnapshot | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as {
    staleProcesses?: { dtach?: { count?: unknown } };
    sessionReaper?: {
      lastOrphanCount?: unknown;
      lastTerminalLeakCount?: unknown;
    };
  };

  const dtach = root.staleProcesses?.dtach;
  const reaper = root.sessionReaper;
  if (!dtach || typeof dtach !== 'object') return null;
  if (!reaper || typeof reaper !== 'object') return null;

  const dtachCount = nonNegInt(dtach.count);
  const lastOrphanCount = nonNegInt(reaper.lastOrphanCount);
  const lastTerminalLeakCount = nonNegInt(reaper.lastTerminalLeakCount);
  if (
    dtachCount === null
    || lastOrphanCount === null
    || lastTerminalLeakCount === null
  ) {
    return null;
  }

  return {
    dtachCount,
    lastOrphanCount,
    lastTerminalLeakCount,
  };
}

function resolveOptionalHealthBase(env: NodeJS.ProcessEnv): string | null {
  const apiBase = env.KOOKR_API_BASE_URL?.trim();
  if (apiBase) return apiBase.replace(/\/$/, '');
  const portRaw = env.KOOKR_PORT?.trim();
  if (!portRaw || portRaw.toLowerCase() === 'auto') return null;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://127.0.0.1:${port}`;
}

async function checkKbLaunchDependency(run: CommandRunner): Promise<DoctorCheck[]> {
  const doctor = await run('kb', ['doctor', '--format=json'], { timeoutMs: KB_PREFLIGHT_TIMEOUT_MS })
    .catch(commandErrorResult);
  const doctorFinding = classifyKbDoctorCommandResult(doctor);
  if (doctorFinding) return [launchDependencyCheckFromFinding('launch.kb-doctor', 'KB doctor', doctorFinding)];

  const search = await run('kb', ['search', KB_SMOKE_QUERY, '--k=1', '--format=json'], {
    timeoutMs: KB_PREFLIGHT_TIMEOUT_MS,
  }).catch(commandErrorResult);
  const searchFinding = classifyKbSearchSmokeResult(search);
  if (searchFinding) return [launchDependencyCheckFromFinding('launch.kb-search', 'KB search smoke', searchFinding)];

  return [{
    id: 'launch.kb',
    label: 'KB launch dependency',
    category: 'launch-dependency',
    status: 'ok',
    required: false,
    summary: '`kb doctor --format=json` and smoke search passed',
  }];
}

async function checkAgentBinaries(env: NodeJS.ProcessEnv, run: CommandRunner): Promise<DoctorCheck[]> {
  const probeExec = probeExecFromRunner(run);
  const checks: DoctorCheck[] = [];
  checks.push(await checkAgentBinary({
    id: 'agent.claude',
    label: 'Claude Code binary',
    bin: env.KOOKR_AGENT_BIN || 'claude',
    envVarName: 'KOOKR_AGENT_BIN',
    explicitlyConfigured: Boolean(env.KOOKR_AGENT_BIN),
    probeExec,
  }));

  const codexBin = env.KOOKR_CODEX_BIN || 'codex';
  const codexConfigured = Boolean(env.KOOKR_CODEX_BIN);
  const codex = await checkAgentBinary({
    id: 'agent.codex',
    label: 'Codex CLI binary',
    bin: codexBin,
    envVarName: 'KOOKR_CODEX_BIN',
    explicitlyConfigured: codexConfigured,
    probeExec,
  });
  checks.push(codex);
  if (codex.status === 'ok') {
    const hasPluginDir = await probeBinaryFlagSupport(codexBin, '--plugin-dir', {
      exec: probeExec,
      timeoutMs: AGENT_PROBE_TIMEOUT_MS,
    });
    checks.push({
      id: 'agent.codex-plugin-dir',
      label: 'Codex --plugin-dir',
      category: 'agent',
      status: hasPluginDir ? 'ok' : 'warn',
      required: false,
      summary: hasPluginDir
        ? 'Codex advertises --plugin-dir for toolkit injection'
        : 'Codex does not advertise --plugin-dir; toolkit injection will be skipped',
      recommendedAction: hasPluginDir ? undefined : 'Run `pnpm codex:rebuild` if Codex-launched agents should see kookr-toolkit.',
    });
  }
  return checks;
}

async function checkAgentBinary(args: {
  id: string;
  label: string;
  bin: string;
  envVarName: string;
  explicitlyConfigured: boolean;
  probeExec: ProbeExecRunner;
}): Promise<DoctorCheck> {
  // Doctor is an interactive diagnostic: keep both probe attempts bounded by the
  // same short budget rather than inheriting the boot preflight's longer
  // --version cold-start window. Passing versionTimeoutMs explicitly preserves
  // the pre-#1557 total budget instead of silently widening to the 5 s default.
  const probe = await probeAgentBinary(args.bin, {
    exec: args.probeExec,
    timeoutMs: AGENT_PROBE_TIMEOUT_MS,
    versionTimeoutMs: AGENT_PROBE_TIMEOUT_MS,
  });
  if (probe.kind === 'ok') {
    return {
      id: args.id,
      label: args.label,
      category: 'agent',
      status: 'ok',
      required: args.explicitlyConfigured,
      summary: `${probe.resolvedPath} responded with version ${probe.version}`,
    };
  }

  return {
    id: args.id,
    label: args.label,
    category: 'agent',
    status: args.explicitlyConfigured ? 'fail' : 'warn',
    required: args.explicitlyConfigured,
    summary: `${args.bin} is not available`,
    detail: probe.reason,
    recommendedAction: args.explicitlyConfigured
      ? `Set ${args.envVarName} to an executable agent binary or unset it to use the default from PATH.`
      : `Install ${args.label.replace(' binary', '')} or set ${args.envVarName} if you plan to launch this agent type.`,
  };
}

function launchDependencyCheckFromFinding(id: string, label: string, finding: LaunchPreflightFinding): DoctorCheck {
  return {
    id,
    label,
    category: 'launch-dependency',
    status: 'warn',
    required: false,
    summary: finding.summary,
    detail: finding.detail,
    recommendedAction: finding.recommendedAction,
  };
}

function okCheck(
  id: string,
  label: string,
  category: DoctorCategory,
  summary: string,
  required: boolean,
): DoctorCheck {
  return { id, label, category, status: 'ok', required, summary };
}

function failCheck(
  id: string,
  label: string,
  category: DoctorCategory,
  summary: string,
  detail: string | undefined,
  recommendedAction: string,
): DoctorCheck {
  return { id, label, category, status: 'fail', required: true, summary, detail, recommendedAction };
}

function aggregateStatus(checks: DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === 'fail' && check.required)) return 'fail';
  if (checks.some((check) => check.status === 'warn' || check.status === 'fail')) return 'warn';
  return 'ok';
}

function versionAtLeast(actual: string, required: string): boolean {
  const a = parseVersion(actual);
  const b = parseVersion(required);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

function parseVersion(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
}

function firstNonEmpty(...values: string[]): string | undefined {
  return values.map((value) => value.trim()).find(Boolean);
}

function commandErrorResult(err: unknown): DependencyCommandResult {
  return {
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
    exitCode: 1,
  };
}

function probeExecFromRunner(run: CommandRunner): ProbeExecRunner {
  return async (file, args, options) => {
    const result = await run(file, args, { timeoutMs: options.timeout });
    if (result.exitCode !== 0) {
      const err = new Error(result.stderr || result.stdout || `${file} exited ${result.exitCode}`) as NodeJS.ErrnoException;
      err.code = result.exitCode as unknown as string;
      throw err;
    }
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

function execFileCommand(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<DependencyCommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], {
      timeout: options.timeoutMs ?? 5_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const nodeError = error as NodeJS.ErrnoException | null;
      const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
      resolve({
        stdout: String(stdout),
        stderr: String(stderr || error?.message || ''),
        exitCode,
      });
    });
  });
}
