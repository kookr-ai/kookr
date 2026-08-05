import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
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

type DoctorCheckStatus = 'ok' | 'warn' | 'fail';
type DoctorStatus = 'ok' | 'warn' | 'fail';
type DoctorCategory = 'runtime' | 'launch-dependency' | 'agent' | 'github' | 'ops';

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

/** Live probe of resourceWatchdog.enabled from /api/health. null = unreachable / unknown. */
type ResourceWatchdogEnabledProbe = (env: NodeJS.ProcessEnv) => Promise<boolean | null>;

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
  checks.push(await checkGhAuth(run));
  checks.push(await checkGithubScannerBackoff(env, deps.probeGithubScannerStatus));
  checks.push(...await checkKbLaunchDependency(run));
  checks.push(...await checkAgentBinaries(env, run));
  checks.push(await checkResourceWatchdog(env, deps.probeResourceWatchdogEnabled));
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

/**
 * Advisory ops check (issue #1988): surface that host-pressure auto-investigation
 * is off by default. Prefer live /api/health when reachable; otherwise env flag.
 * Never fails required checks — warn only.
 */
async function checkResourceWatchdog(
  env: NodeJS.ProcessEnv,
  probe: ResourceWatchdogEnabledProbe | undefined,
): Promise<DoctorCheck> {
  const envEnabled = isTruthyEnvFlag(env.KOOKR_RESOURCE_WATCHDOG);
  const probeFn = probe ?? defaultProbeResourceWatchdogEnabled;
  let liveEnabled: boolean | null = null;
  try {
    liveEnabled = await probeFn(env);
  } catch {
    liveEnabled = null;
  }

  const enabled = liveEnabled ?? envEnabled;
  if (enabled) {
    return okCheck(
      'ops.resource-watchdog',
      'Resource watchdog',
      'ops',
      liveEnabled === true
        ? 'enabled (GET /api/health resourceWatchdog.enabled=true)'
        : 'enabled (KOOKR_RESOURCE_WATCHDOG is truthy)',
      false,
    );
  }

  return {
    id: 'ops.resource-watchdog',
    label: 'Resource watchdog',
    category: 'ops',
    status: 'warn',
    required: false,
    summary: 'host-pressure auto-investigation is disabled',
    detail: liveEnabled === false
      ? 'GET /api/health reports resourceWatchdog.enabled=false'
      : 'KOOKR_RESOURCE_WATCHDOG is unset or not truthy (disabled by default)',
    recommendedAction:
      'Set KOOKR_RESOURCE_WATCHDOG=1 (or true/yes/on) and restart the server to enable host-pressure auto-investigation.',
  };
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
async function defaultProbeResourceWatchdogEnabled(env: NodeJS.ProcessEnv): Promise<boolean | null> {
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
    const body = (await res.json()) as { resourceWatchdog?: { enabled?: unknown } };
    if (typeof body?.resourceWatchdog?.enabled === 'boolean') {
      return body.resourceWatchdog.enabled;
    }
    return null;
  } catch {
    return null;
  }
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
