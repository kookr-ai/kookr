/**
 * Cheap schedule probes (issue #2569).
 *
 * Some playbooks are a one-line script when nothing is wrong — compare two
 * SHAs, exit 0, go home. Launching a full Grok/Codex agent for that tick
 * occupied a fleet slot every 15 minutes and drowned the task list. The
 * scheduler now execs a declared (or well-known) command first and only
 * escalates to an agent when the command's exit code says so (default: 2,
 * the deploy-convergence DIVERGENT contract).
 *
 * No I/O. The runner gathers the playbook + parameters and hands them here;
 * the default exec lives in the runner so tests can inject a fake.
 */

export const DEFAULT_PROBE_ESCALATE_ON_EXIT = [2] as const;
/** Stay well under the 45s fire wall-clock cap so an escalate+launch still fits. */
export const DEFAULT_PROBE_TIMEOUT_MS = 20_000;

export interface PlaybookProbeConfig {
  /** Shell-less argv template. `{{param}}` is interpolated from schedule parameters. */
  command: string;
  /** Exit codes that should launch the playbook agent. Default: `[2]`. */
  escalateOnExit?: number[];
}

export interface ResolvedScheduleProbe {
  argv: string[];
  escalateOnExit: number[];
  timeoutMs: number;
}

export interface ProbeExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const FALLBACK_PROBE_COMMANDS: Readonly<Record<string, string>> = {
  'kookr-deploy-convergence.md':
    'pnpm deploy:convergence -- --branch {{branch}} --grace-minutes {{graceMinutes}}',
  'kookr-deploy-convergence':
    'pnpm deploy:convergence -- --branch {{branch}} --grace-minutes {{graceMinutes}}',
  'lucy-deploy-convergence.md':
    'node scripts/deploy-convergence-check.mjs --base {{healthBase}} --branch {{branch}} --grace-minutes {{graceMinutes}} --signal-file {{signalFile}}',
  'lucy-deploy-convergence':
    'node scripts/deploy-convergence-check.mjs --base {{healthBase}} --branch {{branch}} --grace-minutes {{graceMinutes}} --signal-file {{signalFile}}',
};

const BUILTIN_PARAM_DEFAULTS: Readonly<Record<string, string>> = {
  branch: 'main',
  graceMinutes: '15',
  healthBase: 'http://127.0.0.1:4877',
  signalFile: '',
};

export function playbookBasename(playbookPath: string): string {
  const trimmed = playbookPath.trim();
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function fallbackProbeCommand(playbookPath: string): string | null {
  return FALLBACK_PROBE_COMMANDS[playbookBasename(playbookPath)] ?? null;
}

export function isTruthyScheduleParam(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

/**
 * Split a probe command into argv without a shell. Double-quoted spans keep
 * internal spaces; there is no expansion, redirection, or globbing.
 */
export function tokenizeProbeCommand(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        argv.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) argv.push(current);
  return argv;
}

export function interpolateProbeTemplate(
  template: string,
  parameters: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => parameters[name] ?? '');
}

/**
 * Flags that take a value. A blank interpolation (`--signal-file {{signalFile}}`
 * with an empty param) tokenizes as a bare flag, so we drop those rather than
 * pass the next flag as their value.
 */
const VALUE_TAKING_FLAGS = new Set([
  '--base',
  '--branch',
  '--grace-minutes',
  '--repo-dir',
  '--signal-file',
  '--state-dir',
  '--state-file',
]);

/** Drop a flag whose following value interpolated to empty (e.g. blank `--signal-file`). */
export function dropEmptyFlagValues(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    const nextIsValue = next !== undefined && next !== '' && !(next.startsWith('--') && next !== '--');
    if (VALUE_TAKING_FLAGS.has(token) && !nextIsValue) {
      if (next === '') i += 1;
      continue;
    }
    if (token.startsWith('--') && token !== '--' && next !== undefined && next === '') {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

export function resolveScheduleProbe(input: {
  playbookPath: string;
  probe?: PlaybookProbeConfig | null;
  parameters?: Record<string, string>;
}): ResolvedScheduleProbe | null {
  const parameters = { ...BUILTIN_PARAM_DEFAULTS, ...(input.parameters ?? {}) };
  const rawCommand = input.probe?.command?.trim() || fallbackProbeCommand(input.playbookPath);
  if (!rawCommand) return null;

  const interpolated = interpolateProbeTemplate(rawCommand, parameters);
  let argv = dropEmptyFlagValues(tokenizeProbeCommand(interpolated));
  if (argv.length === 0) return null;

  const dryRun = isTruthyScheduleParam(parameters.dryRun);
  const act = isTruthyScheduleParam(parameters.act);
  if (act && !dryRun && !argv.includes('--act')) {
    argv = [...argv, '--act'];
  }

  const declaredEscalate = normalizeEscalateOnExit(input.probe?.escalateOnExit);
  const escalateOnExit = dryRun ? [] : declaredEscalate;

  return {
    argv,
    escalateOnExit,
    timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
  };
}

export function shouldEscalateProbe(spec: ResolvedScheduleProbe, exitCode: number): boolean {
  return spec.escalateOnExit.includes(exitCode);
}

/** Prefer the probe's `receipt` JSON field; otherwise the last non-empty stdout line. */
export function probeReceiptLine(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const receipt = (parsed as { receipt?: unknown }).receipt;
      if (typeof receipt === 'string' && receipt.trim()) return receipt.trim();
    }
  } catch {
    // stdout is not a single JSON object — fall through to last line
  }
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function normalizeEscalateOnExit(raw: number[] | undefined): number[] {
  if (!raw || raw.length === 0) return [...DEFAULT_PROBE_ESCALATE_ON_EXIT];
  return raw.filter((code) => Number.isInteger(code));
}
