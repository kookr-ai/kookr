import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitHubRateLimit } from '../core/github-types.js';

const execFile = promisify(execFileCb);

/**
 * gh CLI transport.
 *
 * Owns the subprocess lifecycle, retry timing, timeout classification, and
 * rate-limit parsing for `gh` invocations, separated from the domain mapping
 * in {@link ./github-fetcher.ts}. The domain fetcher calls {@link execGh} and
 * {@link spawnGhWithStdin} and interprets their results; it does not spawn or
 * retry processes itself.
 *
 * The retry (timing) and spawn (process) seams are injectable so retry
 * count/delay and stderr/exit-code mapping can be exercised deterministically
 * in tests without real subprocesses or wall-clock delays.
 */

export const DEFAULT_RATE_LIMIT_RETRY_AFTER_MS = 60_000;
export const DEFAULT_GH_MAX_ATTEMPTS = 3;
export const DEFAULT_GH_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/** Injectable timing/attempt seams for {@link withGhRetry}. */
export interface GhRetryOptions {
  /** Total attempts before the last error propagates. Default {@link DEFAULT_GH_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Delay before each retry, indexed by prior-attempt count; last value repeats. */
  retryDelaysMs?: readonly number[];
  /** Sleep seam. Default {@link delay} (real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Observability seam invoked before each retry sleep. */
  onRetry?: (info: { args: string[]; attempt: number; maxAttempts: number; error: unknown }) => void;
}

/** Signature of the injectable process seam used by {@link spawnGhWithStdinOnce}. */
export type SpawnFn = typeof spawn;

/** Run `gh` with the given args, retrying transient failures. */
export async function execGh(
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return withGhRetry(args, () => execFile('gh', args, options));
}

/**
 * Spawn `gh` with the given args and pipe `stdinData` into its stdin. Returns
 * stdout. Avoids ARG_MAX issues at large query sizes. Rejects on non-zero exit
 * or timeout.
 */
export async function spawnGhWithStdin(args: string[], stdinData: string, timeoutMs: number): Promise<string> {
  return withGhRetry(args, () => spawnGhWithStdinOnce(args, stdinData, timeoutMs));
}

/**
 * Run `operation`, retrying while it fails with a transient error. Retry count
 * and per-retry delay come from `opts`, defaulting to the module constants.
 */
export async function withGhRetry<T>(
  args: string[],
  operation: () => Promise<T>,
  opts: GhRetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_GH_MAX_ATTEMPTS;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_GH_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? delay;
  const onRetry = opts.onRetry ?? defaultOnRetry;
  let attempt = 1;
  for (;;) {
    try {
      return await operation();
    } catch (err) {
      if (attempt >= maxAttempts || !isTransientGhError(err)) throw err;
      onRetry({ args, attempt, maxAttempts, error: err });
      await sleep(retryDelaysMs[attempt - 1] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0);
      attempt++;
    }
  }
}

function defaultOnRetry(info: { args: string[]; attempt: number; maxAttempts: number; error: unknown }): void {
  console.warn('[github] transient gh CLI failure; retrying', {
    args: info.args,
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    error: info.error instanceof Error ? info.error.message : String(info.error),
  });
}

/**
 * Spawn `gh` once with `stdinData` on stdin. Resolves stdout on exit code 0,
 * rejects with an error carrying `{ stdout, stderr }` on non-zero exit, and
 * SIGKILLs then rejects on timeout. `spawnFn` is the injectable process seam.
 */
export function spawnGhWithStdinOnce(
  args: string[],
  stdinData: string,
  timeoutMs: number,
  spawnFn: SpawnFn = spawn,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, out: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`gh ${args.join(' ')} timed out after ${timeoutMs}ms`), '');
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish(err, ''));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(Object.assign(new Error(`gh exited ${code}: ${stderr.trim() || '(no stderr)'}`), { stdout, stderr }), '');
    });
    child.stdin?.write(stdinData);
    child.stdin?.end();
  });
}

/**
 * Classify whether an error from a `gh` invocation is transient (worth
 * retrying). Rate-limit errors are never transient — they are surfaced so
 * callers can honour retry-after — everything else is matched on error code,
 * kill signal, or message text.
 */
export function isTransientGhError(err: unknown): boolean {
  if (classifyGitHubRateLimit(err)) return false;
  const error = err as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown; stderr?: unknown } | null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const signal = typeof error?.signal === 'string' ? error.signal : '';
  const message = [
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  return code === 'ETIMEDOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || (error?.killed === true && signal === 'SIGTERM')
    || /timed out|timeout|network|connection reset|connection refused|TLS|HTTP 5\d\d|stream error/i.test(message);
}

/** Real sleep seam. Resolves immediately for non-positive delays. */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inspect an arbitrary value (error, GraphQL payload, or headers) for evidence
 * of GitHub rate limiting. Returns a normalized {@link GitHubRateLimit} with a
 * retry-after estimate, or null when no rate-limit signal is present.
 */
export function classifyGitHubRateLimit(value: unknown): GitHubRateLimit | null {
  const messages = collectRateLimitMessages(value);
  const explicit = messages.find((message) => isRateLimitMessage(message));
  const zeroRemaining = messages.find((message) => /x-ratelimit-remaining\s*:\s*0/i.test(message));
  const message = explicit ?? zeroRemaining;
  if (!message) return null;

  return {
    kind: 'rate-limited',
    retryAfterMs: parseRetryAfterMs(messages) ?? DEFAULT_RATE_LIMIT_RETRY_AFTER_MS,
    message: message.trim(),
  };
}

function collectRateLimitMessages(value: unknown): string[] {
  const messages: string[] = [];
  const visit = (current: unknown): void => {
    if (typeof current === 'string') {
      const lines = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      messages.push(...(lines.length > 1 ? lines : [current]));
      return;
    }
    if (current instanceof Error) {
      messages.push(current.message);
      if ('stderr' in current && typeof current.stderr === 'string') {
        messages.push(current.stderr);
      }
      if ('stdout' in current && typeof current.stdout === 'string') {
        visit(current.stdout);
      }
      return;
    }
    if (!isRecord(current)) return;

    const type = current.type;
    const message = current.message;
    if (typeof type === 'string' && type.toUpperCase() === 'RATE_LIMITED') {
      messages.push(typeof message === 'string' ? `RATE_LIMITED: ${message}` : 'RATE_LIMITED');
    } else if (typeof message === 'string') {
      messages.push(message);
    }

    const errors = current.errors;
    if (Array.isArray(errors)) {
      for (const err of errors) visit(err);
    }

    const headers = current.headers;
    if (isRecord(headers)) {
      for (const [key, headerValue] of Object.entries(headers)) {
        if (typeof headerValue === 'string' || typeof headerValue === 'number') {
          messages.push(`${key}: ${headerValue}`);
        }
      }
    }
  };

  visit(value);
  return messages;
}

/** Extract the `stdout` string carried on a `gh` error, if any. */
export function ghErrorStdout(err: unknown): string | null {
  return isRecord(err) && typeof err.stdout === 'string' ? err.stdout : null;
}

function isRateLimitMessage(message: string): boolean {
  return /\bRATE_LIMITED\b/i.test(message)
    || /rate limit/i.test(message)
    || /rate-limit/i.test(message)
    || /rate limited/i.test(message)
    || /secondary limit/i.test(message);
}

function parseRetryAfterMs(messages: string[]): number | null {
  for (const message of messages) {
    const retryAfter = message.match(/retry-after\s*:\s*(\d+)/i)
      ?? message.match(/retry_after["'\s:=]+(\d+)/i)
      ?? message.match(/retry after\s+(\d+)\s*(?:seconds?|s)?/i);
    if (!retryAfter) continue;
    const seconds = Number(retryAfter[1]);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }

  for (const message of messages) {
    const reset = message.match(/x-ratelimit-reset\s*:\s*(\d+)/i);
    if (!reset) continue;
    const epochSeconds = Number(reset[1]);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      return Math.max(0, (epochSeconds * 1000) - Date.now());
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
