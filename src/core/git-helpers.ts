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

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
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
  try {
    // Strip GIT_DIR/GIT_WORK_TREE so the cwd is authoritative.
    // These vars leak from git hooks (e.g. pre-push) and override --work-tree/cwd.
    const env = { ...process.env };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: timeoutMs, maxBuffer });
    return { kind: 'ok', stdout: stdout.trim() };
  } catch (err) {
    const kind = classifyGitError(err);
    if (kind !== 'failed') {
      console.warn('[git-helpers] git subprocess guard tripped', {
        kind,
        cwd,
        args,
        timeoutMs,
        maxBuffer,
      });
    }
    return { kind };
  }
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
