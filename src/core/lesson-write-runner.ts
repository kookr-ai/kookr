/**
 * I/O boundary for replaying spooled lesson writes via the real `kb remember`
 * CLI. Pure spool logic stays in `lesson-write-spool.ts`.
 */

import { spawn } from 'node:child_process';
import type { LessonWriteFn } from './lesson-write-spool.js';

export interface RunKbRememberOptions {
  kb: string;
  title: string;
  body: string;
  /** Override binary (tests / alternate install). Default: `kb` on PATH. */
  kbBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunKbRememberResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Invoke `kb remember --kb=<kb> --title=<title> --stdin --yes
 * --no-check-similar` with the body on stdin. Exit 0 succeeds; any nonzero
 * exit preserves the pending lesson for a later retry.
 */
export function runKbRemember(opts: RunKbRememberOptions): Promise<RunKbRememberResult> {
  const bin = opts.kbBin ?? 'kb';
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const args = [
    'remember',
    `--kb=${opts.kb}`,
    `--title=${opts.title}`,
    '--stdin',
    '--yes',
    // Drain path must not block on similarity when the index is recovering.
    // Source writes still go through the agent-facing path (default guard).
    '--no-check-similar',
  ];

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunKbRememberResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      // This boundary already owns retry state. If `kb` resolves to Kookr's
      // write-behind shim, re-spooling a failed replay can turn a duplicate
      // append into exit 0 and make the drain delete an unwritten lesson.
      child = spawn(bin, args, {
        env: {
          ...(opts.env ?? process.env),
          KOOKR_KB_SKIP_SPOOL: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        ok: false,
        exitCode: 127,
        stdout: '',
        stderr: message,
        error: redact(message),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        ok: false,
        exitCode: 124,
        stdout,
        stderr: stderr || `kb remember timed out after ${timeoutMs}ms`,
        error: `kb remember timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        finish({
          ok: false,
          exitCode: 127,
          stdout,
          stderr: err.message,
          error: `kb binary not found (${bin})`,
        });
        return;
      }
      finish({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: err.message,
        error: redact(err.message),
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      const exitCode = code ?? (signal ? 1 : 0);
      if (exitCode === 0) {
        finish({ ok: true, exitCode: 0, stdout, stderr });
        return;
      }
      finish({
        ok: false,
        exitCode,
        stdout,
        stderr,
        error: redact(stderr || stdout || `kb remember exited ${exitCode}`),
      });
    });

    // Ignore EPIPE when the child exits before consuming stdin (common for
    // stub `kb` binaries in tests that exit 0 without reading).
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(opts.body, 'utf8');
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      finish({
        ok: false,
        exitCode: 1,
        stdout,
        stderr: message,
        error: redact(message),
      });
    }
  });
}

export function createKbRememberWriteFn(opts?: {
  kbBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): LessonWriteFn {
  return async (entry) => {
    const result = await runKbRemember({
      kb: entry.kb,
      title: entry.title,
      body: entry.body,
      kbBin: opts?.kbBin,
      timeoutMs: opts?.timeoutMs,
      env: opts?.env,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  };
}

function redact(text: string, max = 500): string {
  const cleaned = text
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\b(token|api[_-]?key|password|secret)=\S+/gi, '$1=<redacted>');
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 3)}...`;
}
