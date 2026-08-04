import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { isValidSpeechServiceUrl } from './speech-service-url.js';

export type ConfigPreflightSeverity = 'fatal' | 'warning';

export interface ConfigPreflightIssue {
  severity: ConfigPreflightSeverity;
  variable: string;
  message: string;
  remediation: string;
}

export interface ConfigPreflightResult {
  issues: ConfigPreflightIssue[];
}

export interface ConfigPreflightDeps {
  access?: (path: string, mode?: number) => Promise<void>;
  stat?: (path: string) => Promise<{ isFile(): boolean }>;
  cwd?: string;
  pathEnv?: string;
}

interface BinarySpec {
  variable: 'KOOKR_AGENT_BIN' | 'KOOKR_CODEX_BIN';
  defaultCommand: string;
  label: string;
}

interface EnvConstraint {
  variable: string;
  validate: (raw: string) => boolean;
  description: string;
}

const AGENT_BINARIES: BinarySpec[] = [
  { variable: 'KOOKR_AGENT_BIN', defaultCommand: 'claude', label: 'Claude Code' },
  { variable: 'KOOKR_CODEX_BIN', defaultCommand: 'codex', label: 'Codex CLI' },
];

const INTEGER_PORT_DESCRIPTION = 'integer port in 1..65535';
const POSITIVE_INTEGER_DESCRIPTION = 'positive integer';

const ENV_CONSTRAINTS: EnvConstraint[] = [
  {
    variable: 'KOOKR_PORT',
    validate: (raw) => raw.trim().toLowerCase() === 'auto' || isIntegerInRange(raw, 1, 65_535),
    description: 'integer port in 1..65535, or "auto"',
  },
  { variable: 'KOOKR_STT_PORT', validate: isPort, description: INTEGER_PORT_DESCRIPTION },
  { variable: 'KOOKR_TTS_PORT', validate: isPort, description: INTEGER_PORT_DESCRIPTION },
  {
    // Issue #2057: reject cloud-metadata / link-local / credentialed speech URLs
    // before server-side health and synthesize fetches can use them.
    variable: 'KOOKR_STT_URL',
    validate: isValidSpeechServiceUrl,
    description:
      'http(s)/ws(s) speech-to-text URL without credentials (loopback and private LAN allowed; metadata/link-local blocked)',
  },
  {
    variable: 'KOOKR_TTS_URL',
    validate: isValidSpeechServiceUrl,
    description:
      'http(s)/ws(s) text-to-speech URL without credentials (loopback and private LAN allowed; metadata/link-local blocked)',
  },
  {
    variable: 'KOOKR_REQUEST_BODY_LIMIT_BYTES',
    validate: isPositiveInteger,
    description: 'positive integer bytes',
  },
  {
    variable: 'KOOKR_STARTUP_TIMEOUT_SECONDS',
    validate: isPositiveInteger,
    description: 'positive integer seconds',
  },
  {
    variable: 'KOOKR_STARTUP_CHECK_INTERVAL_SECONDS',
    validate: isPositiveInteger,
    description: 'positive integer seconds',
  },
  {
    variable: 'KOOKR_STT_HEALTH_TIMEOUT_S',
    validate: isPositiveNumber,
    description: 'positive number of seconds',
  },
  {
    variable: 'KOOKR_SESSION_BRIDGE_OUTPUT_BATCH_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_SESSION_BRIDGE_BACKPRESSURE_RETRY_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_SESSION_BRIDGE_BACKPRESSURE_SOFT_BYTES',
    validate: isPositiveInteger,
    description: 'positive integer bytes',
  },
  {
    variable: 'KOOKR_SESSION_BRIDGE_OWNER_BACKPRESSURE_HARD_BYTES',
    validate: isPositiveInteger,
    description: 'positive integer bytes',
  },
  {
    variable: 'KOOKR_SESSION_BRIDGE_VIEWER_BACKPRESSURE_HARD_BYTES',
    validate: isPositiveInteger,
    description: 'positive integer bytes',
  },
  {
    variable: 'KOOKR_NUDGE_MIN_TASK_AGE_MS',
    validate: isNonNegativeInteger,
    description: 'non-negative integer milliseconds',
  },
  {
    variable: 'KOOKR_LLM_TIMEOUT_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_ALERT_CPU_PERCENT',
    validate: isNonNegativeNumber,
    description: 'non-negative number',
  },
  {
    variable: 'KOOKR_ALERT_MEMORY_PERCENT',
    validate: isNonNegativeNumber,
    description: 'non-negative number',
  },
  {
    variable: 'KOOKR_ALERT_EVENT_LOOP_DELAY_MS',
    validate: isNonNegativeNumber,
    description: 'non-negative number',
  },
  {
    variable: 'KOOKR_ALERT_PROCESS_RSS_BYTES',
    validate: isNonNegativeNumber,
    description: 'non-negative number of bytes (0 disables)',
  },
  {
    variable: 'KOOKR_ALERT_DATA_DIR_FREE_PERCENT',
    validate: isNonNegativeNumber,
    description: 'non-negative number',
  },
  {
    variable: 'KOOKR_ALERT_DATA_DIR_FREE_BYTES',
    validate: isNonNegativeNumber,
    description: 'non-negative number of bytes',
  },
  {
    variable: 'KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS',
    validate: isNonNegativeInteger,
    description: 'non-negative integer milliseconds (0 disables)',
  },
  {
    variable: 'KOOKR_ALERT_SUSTAIN_SAMPLES',
    validate: isPositiveInteger,
    description: 'integer >= 1',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_DAILY_COST_CENTS',
    validate: isNonNegativeInteger,
    description: 'non-negative integer cents',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_MAX_CANDIDATES',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_TIMEOUT_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_INTERVAL_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MIN_AGE_MS',
    validate: isNonNegativeInteger,
    description: 'non-negative integer milliseconds',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MIN_OBSERVATIONS',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_INTERVAL',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MAX_PER_DETECTOR',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MAX_TOKENS_PER_CANDIDATE',
    validate: isPositiveInteger,
    description: 'positive integer tokens',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_DAILY_TOKEN_BUDGET',
    validate: isPositiveInteger,
    description: 'positive integer tokens',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_LEASE_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_MAX_ATTEMPTS',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_RETRY_BASE_MS',
    validate: isPositiveInteger,
    description: 'positive integer milliseconds',
  },
  {
    variable: 'KOOKR_FINDING_REVIEW_SAMPLER_CANDIDATE_READ_LIMIT',
    validate: isPositiveInteger,
    description: POSITIVE_INTEGER_DESCRIPTION,
  },
];

export async function runConfigPreflight(
  env: NodeJS.ProcessEnv = process.env,
  deps: ConfigPreflightDeps = {},
): Promise<ConfigPreflightResult> {
  const accessFn = deps.access ?? access;
  const statFn = deps.stat ?? stat;
  const cwd = deps.cwd ?? process.cwd();
  const pathEnv = deps.pathEnv ?? env.PATH ?? '';
  const issues: ConfigPreflightIssue[] = [];

  for (const binary of AGENT_BINARIES) {
    const issue = await validateAgentBinary(binary, env, { access: accessFn, stat: statFn, cwd, pathEnv });
    if (issue) issues.push(issue);
  }

  issues.push(...validateEnvConstraints(env));
  issues.push(...validateEnvPrecedencePairs(env));

  return { issues };
}

export function formatConfigPreflightIssue(issue: ConfigPreflightIssue): string {
  const prefix = issue.severity === 'fatal' ? '[fatal]' : '[warning]';
  return `${prefix} ${issue.message}\n  Fix: ${issue.remediation}`;
}

export function hasFatalConfigPreflightIssues(result: ConfigPreflightResult): boolean {
  return result.issues.some((issue) => issue.severity === 'fatal');
}

export function formatConfigPreflightCliOutput(result: ConfigPreflightResult): string {
  if (result.issues.length === 0) return 'OK\tstartup configuration is valid';
  return result.issues.map((issue) => {
    const status = issue.severity === 'fatal' ? 'FAIL' : 'WARN';
    return `${status}\t${issue.message} Fix: ${issue.remediation}`;
  }).join('\n');
}

export async function runStartupConfigPreflightOrExit(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const result = await runConfigPreflight(env);
  for (const issue of result.issues.filter((entry) => entry.severity === 'warning')) {
    console.warn(`[preflight] ${formatConfigPreflightIssue(issue)}`);
  }

  const fatalIssues = result.issues.filter((entry) => entry.severity === 'fatal');
  if (fatalIssues.length === 0) {
    return;
  }

  console.error(
    ['[preflight] Startup configuration preflight failed:', ...fatalIssues.map(formatConfigPreflightIssue)]
      .join('\n'),
  );
  process.exit(1);
}

async function validateAgentBinary(
  spec: BinarySpec,
  env: NodeJS.ProcessEnv,
  deps: Required<Pick<ConfigPreflightDeps, 'access' | 'stat' | 'cwd' | 'pathEnv'>>,
): Promise<ConfigPreflightIssue | null> {
  const raw = env[spec.variable];
  const explicitlyConfigured = raw != null && raw !== '';
  if (explicitlyConfigured && raw !== raw.trim()) {
    return {
      severity: 'fatal',
      variable: spec.variable,
      message: `${spec.variable}=${JSON.stringify(raw)} contains leading or trailing whitespace.`,
      remediation: `Remove the surrounding whitespace from ${spec.variable}; startup uses the value exactly as configured.`,
    };
  }
  const command = explicitlyConfigured ? raw : spec.defaultCommand;

  const resolved = await resolveExecutable(command, deps);
  if (resolved.ok) return null;

  const source = explicitlyConfigured ? `${spec.variable}=${JSON.stringify(command)}` : `default "${command}"`;
  const severity: ConfigPreflightSeverity = explicitlyConfigured ? 'fatal' : 'warning';
  const remediation = explicitlyConfigured
    ? `Set ${spec.variable} to an executable ${spec.label} binary, or unset it to use "${spec.defaultCommand}" from PATH.`
    : `Install ${spec.label}, or set ${spec.variable} to its executable path if you plan to launch ${spec.label} tasks.`;

  return {
    severity,
    variable: spec.variable,
    message: `${source} does not resolve to an executable ${spec.label} binary (${resolved.reason}).`,
    remediation,
  };
}

async function resolveExecutable(
  command: string,
  deps: Required<Pick<ConfigPreflightDeps, 'access' | 'stat' | 'cwd' | 'pathEnv'>>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (looksLikePath(command)) {
    const candidate = isAbsolute(command) ? command : resolve(deps.cwd, command);
    return await checkExecutable(candidate, deps.access, deps.stat);
  }

  for (const entry of deps.pathEnv.split(delimiter)) {
    const dir = entry === '' ? deps.cwd : entry;
    const candidate = join(dir, command);
    const result = await checkExecutable(candidate, deps.access, deps.stat);
    if (result.ok) return result;
  }

  return { ok: false, reason: `not found on PATH as "${command}"` };
}

async function checkExecutable(
  path: string,
  accessFn: (path: string, mode?: number) => Promise<void>,
  statFn: (path: string) => Promise<{ isFile(): boolean }>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await accessFn(path, constants.X_OK);
    const stats = await statFn(path);
    if (!stats.isFile()) return { ok: false, reason: `${path} is not a file` };
    return { ok: true };
  } catch (err) {
    const code = typeof err === 'object' && err && 'code' in err ? String(err.code) : '';
    if (code === 'EACCES') return { ok: false, reason: `${path} exists but is not executable` };
    if (code === 'ENOENT') return { ok: false, reason: `${path} does not exist` };
    return { ok: false, reason: `${path} is not executable or cannot be accessed` };
  }
}

function validateEnvConstraints(env: NodeJS.ProcessEnv): ConfigPreflightIssue[] {
  const issues: ConfigPreflightIssue[] = [];

  for (const constraint of ENV_CONSTRAINTS) {
    const raw = env[constraint.variable];
    if (raw == null || raw.trim() === '') continue;
    if (constraint.validate(raw)) continue;
    issues.push({
      severity: 'fatal',
      variable: constraint.variable,
      message: `${constraint.variable}=${JSON.stringify(raw)} violates the documented constraint: ${constraint.description}.`,
      remediation: `Set ${constraint.variable} to a valid ${constraint.description}, or unset it to use the documented default.`,
    });
  }

  const backend = env.KOOKR_BACKEND;
  if (backend != null && backend.trim() !== '' && backend.trim() !== 'dtach') {
    issues.push({
      severity: 'fatal',
      variable: 'KOOKR_BACKEND',
      message: `KOOKR_BACKEND=${JSON.stringify(backend)} is not supported; the only accepted value is "dtach".`,
      remediation: 'Remove KOOKR_BACKEND or set KOOKR_BACKEND=dtach.',
    });
  }

  return issues;
}

function validateEnvPrecedencePairs(env: NodeJS.ProcessEnv): ConfigPreflightIssue[] {
  const pairs = [
    {
      variables: ['KOOKR_CONTEXT_ADVISORY_ENABLED', 'KOOKR_CONTEXT_ADVISORY_DISABLED'] as const,
      remediation: 'Set only one context-advisory flag; KOOKR_CONTEXT_ADVISORY_DISABLED takes precedence when both are set.',
    },
    {
      variables: ['KOOKR_AUTO_CATCHUP', 'KOOKR_NO_CATCHUP'] as const,
      remediation: 'Set only one schedule catch-up flag; KOOKR_NO_CATCHUP takes precedence when both are set.',
    },
    // issue #1900: catch-up precedence is KOOKR_NO_CATCHUP > KOOKR_MANUAL_CATCHUP
    // > KOOKR_AUTO_CATCHUP (default auto). Warn on the two remaining conflicting
    // combinations so a silently-resolved conflict is still operator-visible.
    {
      variables: ['KOOKR_MANUAL_CATCHUP', 'KOOKR_NO_CATCHUP'] as const,
      remediation: 'Set only one schedule catch-up flag; KOOKR_NO_CATCHUP takes precedence when both are set.',
    },
    {
      variables: ['KOOKR_AUTO_CATCHUP', 'KOOKR_MANUAL_CATCHUP'] as const,
      remediation: 'Set only one schedule catch-up flag; KOOKR_MANUAL_CATCHUP takes precedence over KOOKR_AUTO_CATCHUP.',
    },
  ];

  return pairs.flatMap(({ variables, remediation }) => {
    const [first, second] = variables;
    if (!isSet(env[first]) || !isSet(env[second])) return [];
    return [{
      severity: 'warning' as const,
      variable: `${first}/${second}`,
      message: `${first} and ${second} are both set; startup will use the documented precedence rule.`,
      remediation,
    }];
  });
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes('/') || value.includes(sep);
}

function isSet(value: string | undefined): boolean {
  return value != null && value.trim() !== '';
}

function isPort(raw: string): boolean {
  return isIntegerInRange(raw, 1, 65_535);
}

function isIntegerInRange(raw: string, min: number, max: number): boolean {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function isPositiveInteger(raw: string): boolean {
  return isIntegerInRange(raw, 1, Number.MAX_SAFE_INTEGER);
}

function isNonNegativeInteger(raw: string): boolean {
  return isIntegerInRange(raw, 0, Number.MAX_SAFE_INTEGER);
}

function isPositiveNumber(raw: string): boolean {
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function isNonNegativeNumber(raw: string): boolean {
  const parsed = Number(raw.trim());
  return Number.isFinite(parsed) && parsed >= 0;
}
