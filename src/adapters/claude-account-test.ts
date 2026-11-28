/**
 * Probe a named Claude account with one tiny `claude -p` request and classify
 * the answer (shared by `kookr account test` and `POST /api/claude-accounts/:name/test`).
 *
 * Async on purpose: the server must not block its event loop for the seconds a
 * probe takes. Lives in `src/adapters` because it builds the account's process
 * environment, which names provider secrets.
 */
import { spawn } from 'node:child_process';
import type { ClaudeAccountRegistry } from '../core/claude-accounts.js';
import { assertKnownAccount } from '../core/claude-accounts.js';
import { redactSecrets } from '../core/redact-secrets.js';
import type {
  ClaudeAccountQuota,
  ClaudeAccountQuotaWindow,
  ClaudeAccountTestOutcome,
} from '../shared/contracts/claude-accounts.js';
import { claudeAccountLaunchEnv, stripInheritedClaudeAccountEnv } from './claude-account-env.js';

export const CLAUDE_ACCOUNT_TEST_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface ClaudeProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the probe; may be sync or async so tests can stub it simply. */
export type ClaudeProbeRunner = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => ClaudeProbeResult | Promise<ClaudeProbeResult>;

export interface ClaudeAccountTestResult {
  outcome: ClaudeAccountTestOutcome;
  /** One secret-free line, at most 300 characters. */
  message: string;
  /** The account's 5-hour/7-day usage from the probe's last `rate_limit_event`, when it sent one. */
  quota?: ClaudeAccountQuota;
}

export interface ClaudeAccountTestOptions {
  env?: NodeJS.ProcessEnv;
  run?: ClaudeProbeRunner;
  timeoutMs?: number;
}

// Hooks off: the probe tests the account's credentials, not the operator's hook
// setup. A user Stop hook that blocks the stop adds a second turn, which
// `--max-turns 1` reports as "Reached max turns (1)" even though the account
// answered; SessionStart and prompt hooks also make every probe slower and dearer.
// stream-json: the final `result` line says whether the request failed, and a
// `rate_limit_event` line carries the account's 5-hour and 7-day usage (#4251).
const PROBE_ARGS = [
  '-p', 'Reply with the single word OK.',
  '--max-turns', '1',
  '--model', 'haiku',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--output-format', 'stream-json',
  '--verbose',
];

// Text fallbacks, used on the `result` line's text when its structured fields
// do not settle the outcome, and on the whole output when no `result` line came
// (CLI missing, timeout, a CLI too old for stream-json).
// Plan quota exhausted. Wording seen from Claude Code: "Claude AI usage limit
// reached", "5-hour limit reached - resets 3pm", "You've hit your weekly limit",
// "Your limit will reset at ...", API "rate_limit_error".
const USAGE_LIMIT_RE =
  /usage limit|limit will reset|rate[_ ]?limit|5-hour limit|weekly limit|hit your (?:[\w-]+ )?limit|limit reached/i;
// Billing and credit problems are a different failure (the account is not out of plan quota).
const BILLING_RE = /billing|credit balance|insufficient credits|out of credits?|payment/i;
const AUTH_RE =
  /failed to authenticate|\b40[13]\b|invalid (?:x-)?api[ _-]?key|invalid (?:bearer |oauth |access )?token|authentication_error|token (?:has )?(?:expired|been revoked)/i;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJsonLine(line: string): JsonObject | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function firstLineOf(text: string): string | undefined {
  return text.split('\n').find((line) => line.trim() !== '')?.trim();
}

function cleanMessage(line: string): string {
  return redactSecrets(line).slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * One `unifiedWindows` entry, converted to the dashboard's units: the probe
 * reports a 0-1 fraction and epoch seconds, `QuotaWindow` wants percent and ISO.
 */
function quotaWindow(raw: unknown): ClaudeAccountQuotaWindow | undefined {
  const obj = asObject(raw);
  const utilization = obj?.utilization;
  const resetsAt = obj?.resetsAt;
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined;
  const status = asString(obj?.status);
  return {
    utilization: Math.round(utilization * 1000) / 10,
    resetsAt: new Date(resetsAt * 1000).toISOString(),
    ...(status ? { status } : {}),
  };
}

/** The 5-hour and 7-day windows of a `rate_limit_event`; undefined when it carries neither. */
export function quotaFromRateLimitEvent(event: JsonObject): ClaudeAccountQuota | undefined {
  const windows = asObject(asObject(event.rate_limit_info)?.unifiedWindows);
  if (!windows) return undefined;
  const fiveHour = quotaWindow(windows.five_hour);
  const sevenDay = quotaWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

function classifyText(text: string, status: number | null): ClaudeAccountTestOutcome {
  if (!BILLING_RE.test(text) && USAGE_LIMIT_RE.test(text)) return 'usage_limited';
  if (AUTH_RE.test(text)) return 'auth_failed';
  return status === 0 ? 'ok' : 'error';
}

/** Outcome of a failed `result` line, from its structured fields first. */
function classifyFailedResult(result: JsonObject, assistantError: string | undefined, rateLimitStatus: string | undefined): ClaudeAccountTestOutcome {
  const apiStatus = result.api_error_status;
  const apiType = result.api_error_type;
  if (assistantError === 'billing_error' || apiType === 'billing_error') return 'error';
  if (assistantError === 'rate_limit' || apiType === 'rate_limit_error' || apiStatus === 429 || rateLimitStatus === 'rejected') {
    return 'usage_limited';
  }
  if (assistantError === 'authentication_failed' || apiType === 'authentication_error' || apiStatus === 401 || apiStatus === 403) {
    return 'auth_failed';
  }
  const text = typeof result.result === 'string' ? result.result : '';
  const fromText = classifyText(text, 1);
  return fromText === 'ok' ? 'error' : fromText;
}

/** Pure classifier over a probe result; exported for tests. */
export function classifyClaudeProbe(res: ClaudeProbeResult): ClaudeAccountTestResult {
  let result: JsonObject | undefined;
  let rateLimitEvent: JsonObject | undefined;
  let assistantError: string | undefined;
  let sawJson = false;
  for (const line of res.stdout.split('\n')) {
    const msg = parseJsonLine(line);
    if (!msg) continue;
    sawJson = true;
    if (msg.type === 'result') result = msg;
    else if (msg.type === 'rate_limit_event') rateLimitEvent = msg;
    else if (msg.type === 'assistant') {
      if (typeof msg.error === 'string') assistantError = msg.error;
      else if (msg.is_api_error_message === true) assistantError ??= 'unknown';
    }
  }
  const quota = rateLimitEvent ? quotaFromRateLimitEvent(rateLimitEvent) : undefined;
  const withQuota = (outcome: ClaudeAccountTestOutcome, message: string): ClaudeAccountTestResult =>
    (quota ? { outcome, message, quota } : { outcome, message });

  if (result) {
    const text = typeof result.result === 'string' ? result.result : '';
    const subtype = typeof result.subtype === 'string' ? result.subtype : undefined;
    const message = cleanMessage(firstLineOf(text) ?? subtype ?? `exit status ${String(res.status)}`);
    // An API error on the assistant line overrides a result that claims success.
    if (result.is_error === false && (subtype === undefined || subtype === 'success') && !assistantError) {
      return withQuota('ok', message);
    }
    const rateLimitStatus = asString(asObject(rateLimitEvent?.rate_limit_info)?.status);
    return withQuota(classifyFailedResult(result, assistantError, rateLimitStatus), message);
  }

  // No `result` line. Once stdout is JSON its lines are not a message (and may
  // be cut mid-line), so the message comes from stderr or the exit status.
  const output = sawJson ? res.stderr.trim() : `${res.stdout}\n${res.stderr}`.trim();
  const message = cleanMessage(firstLineOf(output) ?? `exit status ${String(res.status)}`);
  return withQuota(classifyText(output, sawJson ? null : res.status), message);
}

export const defaultClaudeProbeRunner: ClaudeProbeRunner = (bin, args, env, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null, extraErr = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr: `${stderr}${extraErr}` });
    };
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);
    // stdout keeps its tail: the `result` and `rate_limit_event` lines come last,
    // after a `system/init` line that alone can weigh tens of kilobytes.
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf-8');
      if (stdout.length > MAX_OUTPUT_BYTES) stdout = stdout.slice(-MAX_OUTPUT_BYTES);
    });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString('utf-8'); });
    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code));
  });

const inFlight = new Map<string, Promise<ClaudeAccountTestResult>>();

/**
 * Test `name` (`host` or a registered account). Throws `ClaudeAccountError`
 * (`unknown_account`) for an unregistered name. A second call for the same
 * account while one probe is running awaits that probe instead of spending
 * another request.
 */
export function testClaudeAccount(
  registry: ClaudeAccountRegistry,
  name: string,
  opts: ClaudeAccountTestOptions = {},
): Promise<ClaudeAccountTestResult> {
  assertKnownAccount(registry, name);
  const existing = inFlight.get(name);
  if (existing) return existing;
  const env = opts.env ?? process.env;
  // From an agent shell on another account the inherited token would otherwise answer for `host`.
  const childEnv: NodeJS.ProcessEnv = { ...stripInheritedClaudeAccountEnv(env), ...claudeAccountLaunchEnv(registry, name) };
  delete childEnv.CLAUDE_CODE_CHILD_SESSION;
  const bin = env.KOOKR_AGENT_BIN?.trim() || 'claude';
  const run = opts.run ?? defaultClaudeProbeRunner;
  const promise = (async (): Promise<ClaudeAccountTestResult> => {
    try {
      return classifyClaudeProbe(await run(bin, PROBE_ARGS, childEnv, opts.timeoutMs ?? CLAUDE_ACCOUNT_TEST_TIMEOUT_MS));
    } catch (err) {
      return { outcome: 'error', message: redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, MAX_MESSAGE_LENGTH) };
    }
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, promise);
  return promise;
}
