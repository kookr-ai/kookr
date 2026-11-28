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
import type { ClaudeAccountTestOutcome } from '../shared/contracts/claude-accounts.js';
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
const PROBE_ARGS = [
  '-p', 'Reply with the single word OK.',
  '--max-turns', '1',
  '--model', 'haiku',
  '--settings', JSON.stringify({ disableAllHooks: true }),
];

// Plan quota exhausted. Wording seen from Claude Code: "Claude AI usage limit
// reached", "5-hour limit reached - resets 3pm", "You've hit your weekly limit",
// "Your limit will reset at ...", API "rate_limit_error".
const USAGE_LIMIT_RE =
  /usage limit|limit will reset|rate[_ ]?limit|5-hour limit|weekly limit|hit your (?:[\w-]+ )?limit|limit reached/i;
// Billing and credit problems are a different failure (the account is not out of plan quota).
const BILLING_RE = /billing|credit balance|insufficient credits|out of credits?|payment/i;
const AUTH_RE =
  /failed to authenticate|\b40[13]\b|invalid (?:x-)?api[ _-]?key|invalid (?:bearer |oauth |access )?token|authentication_error|token (?:has )?(?:expired|been revoked)/i;

/** Pure classifier over a probe result; exported for tests. */
export function classifyClaudeProbe(res: ClaudeProbeResult): ClaudeAccountTestResult {
  const output = `${res.stdout}\n${res.stderr}`.trim();
  const firstLine = output.split('\n').find((line) => line.trim() !== '')?.trim();
  const message = redactSecrets(firstLine ?? `exit status ${String(res.status)}`).slice(0, MAX_MESSAGE_LENGTH);
  if (!BILLING_RE.test(output) && USAGE_LIMIT_RE.test(output)) return { outcome: 'usage_limited', message };
  if (AUTH_RE.test(output)) return { outcome: 'auth_failed', message };
  if (res.status === 0) return { outcome: 'ok', message };
  return { outcome: 'error', message };
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
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString('utf-8'); });
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
