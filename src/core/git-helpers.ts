/**
 * Shared git subprocess helpers.
 *
 * Thin wrappers around execFile for running git commands.
 * Used by repo-policy-resolver and cleanup-inspector.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;
export const DEFAULT_GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const DEFAULT_GIT_MAX_ATTEMPTS = 3;
const DEFAULT_GIT_RETRY_DELAYS_MS = [1_000, 3_000];

/** Git environment variables that can redirect a subprocess away from cwd. */
export const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

/** Make cwd/explicit -C the authority for a Git subprocess. */
export function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
}

export type GitRunResult =
  | { kind: 'ok'; stdout: string }
  | { kind: 'failed' }
  | { kind: 'timed_out' }
  | { kind: 'max_buffer_exceeded' };

export type GitFailureKind = Exclude<GitRunResult['kind'], 'ok'>;

/** Run a git command in a specific directory and return trimmed stdout, or null on failure. */
export async function gitIn(cwd: string, ...args: string[]): Promise<string | null> {
  const result = await runGitIn(cwd, args);
  return result.kind === 'ok' ? result.stdout : null;
}

export async function runGitIn(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_GIT_MAX_ATTEMPTS);
  let lastKind: GitFailureKind = 'failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        env: gitExecEnv(),
        timeout: timeoutMs,
        maxBuffer,
      });
      return { kind: 'ok', stdout: stdout.trim() };
    } catch (err) {
      const kind = classifyGitError(err);
      lastKind = kind;
      if (kind !== 'failed') {
        console.warn('[git-helpers] git subprocess guard tripped', {
          kind,
          cwd,
          args,
          timeoutMs,
          maxBuffer,
          attempt,
          maxAttempts,
        });
      }
      if (attempt >= maxAttempts || !shouldRetryGitFailure(args, kind, err)) {
        return { kind };
      }
      await delay(retryDelayMs(options, attempt));
    }
  }
  return { kind: lastKind };
}

export function classifyGitError(err: unknown): GitFailureKind {
  const error = err as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown } | null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const signal = typeof error?.signal === 'string' ? error.signal : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 'ETIMEDOUT' || (error?.killed === true && signal === 'SIGTERM') || /timed out/i.test(message)) {
    return 'timed_out';
  }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(message)) {
    return 'max_buffer_exceeded';
  }
  return 'failed';
}

function shouldRetryGitFailure(args: string[], kind: GitFailureKind, err: unknown): boolean {
  if (!isRetryableGitCommand(args)) return false;
  if (kind === 'timed_out') return true;
  return kind === 'failed' && isTransientGitError(err);
}

function isRetryableGitCommand(args: string[]): boolean {
  const op = args.find((arg) => !arg.startsWith('-'));
  return op === 'fetch' || op === 'ls-remote';
}

function isTransientGitError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; stderr?: unknown } | null;
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = [
    typeof error?.message === 'string' ? error.message : '',
    typeof error?.stderr === 'string' ? error.stderr : '',
  ].join('\n');
  return code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EAI_AGAIN'
    || code === 'ENOTFOUND'
    || /remote end hung up|connection reset|connection refused|could not resolve host|network is unreachable|TLS|HTTP 5\d\d/i.test(message);
}

function retryDelayMs(options: GitRunOptions, attempt: number): number {
  if (options.retryDelayMs) return Math.max(0, options.retryDelayMs(attempt));
  return DEFAULT_GIT_RETRY_DELAYS_MS[attempt - 1] ?? DEFAULT_GIT_RETRY_DELAYS_MS[DEFAULT_GIT_RETRY_DELAYS_MS.length - 1]!;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
