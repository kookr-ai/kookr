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

type DoctorCheckStatus = 'ok' | 'warn' | 'fail';
type DoctorStatus = 'ok' | 'warn' | 'fail';
type DoctorCategory = 'runtime' | 'launch-dependency' | 'agent' | 'github';

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

interface RunDoctorDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: Pick<typeof console, 'log' | 'error'>;
  commandRunner?: CommandRunner;
  access?: (path: string, mode?: number) => Promise<void>;
  now?: () => Date;
}

const HELP_TEXT = `kookr doctor — run machine-readable launch preflight checks.

Usage:
  kookr doctor --json

Options:
  --json       Print one JSON report to stdout.
  -h, --help   Show this help.
`;

const KB_PREFLIGHT_TIMEOUT_MS = 5_000;
const AGENT_PROBE_TIMEOUT_MS = 2_000;
const KB_SMOKE_QUERY = 'kookr launch dependency smoke';

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

  if (!args.json) {
    out.error('`kookr doctor` currently requires --json. Use `pnpm doctor` for the human-readable shell report.');
    out.error(HELP_TEXT);
    return 2;
  }

  const report = await buildDoctorJsonReport(deps);
  out.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
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
  checks.push(...await checkKbLaunchDependency(run));
  checks.push(...await checkAgentBinaries(env, run));

  const status = aggregateStatus(checks);
  return {
    ok: status !== 'fail',
    status,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    checks,
  };
}

function parseArgs(argv: string[]): { json: boolean; help: boolean; error?: string } {
  const parsed = { json: false, help: false, error: undefined as string | undefined };
  for (const arg of argv) {
    if (arg === '--json') parsed.json = true;
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
