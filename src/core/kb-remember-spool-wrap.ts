/**
 * Wrap a real `kb remember` invocation: on runtime failure for a lesson
 * write, append to the durable spool instead of dropping the lesson.
 *
 * Used by the PATH-level `bin/kb` shim so agent-facing `kb remember` calls
 * get write-behind behaviour without playbook changes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  KB_LESSON_WRITE_NOT_RECORDED_MARKER,
  KB_LESSON_WRITE_RECORDED_MARKER,
} from './kb-lesson-classifier.js';
import {
  appendLessonWrite,
  buildLessonEntry,
  defaultSpoolDir,
  extractRememberKb,
  extractRememberTitle,
  isLessonRememberArgv,
} from './lesson-write-spool.js';

/**
 * One-line hint printed after a suppressed/failed lesson remember so the agent
 * knows how to turn it into a recorded decision (the #1538 gate will keep
 * refusing completion-ready until then).
 */
const NOT_RECORDED_HINT =
  `[kookr] No lesson stored. Either re-run with --force (override the similarity `
  + `guard) or --append=<file> to extend the similar note, or declare an explicit `
  + `skip: printf 'No generic KB lesson: %s\\n' '<one-line reason>'.\n`;

/**
 * Detect the real `kb` tool's `write_performed` envelope field in captured
 * output. Returns the boolean when present, or null when absent (e.g. a
 * non-lesson remember summary, which omits it).
 */
function detectWritePerformed(output: string): boolean | null {
  if (/"write_performed"\s*:\s*true/.test(output)) return true;
  if (/"write_performed"\s*:\s*false/.test(output)) return false;
  return null;
}

export interface WrapRememberOptions {
  /** Full argv after the binary name (starts with `remember`). */
  argv: string[];
  /** Body already read from stdin (may be empty). */
  stdinBody: string;
  /** Absolute path to the real `kb` binary. */
  realKbBin: string;
  env?: NodeJS.ProcessEnv;
  spoolDir?: string;
  taskId?: string;
  /** Timeout for the real kb process. Default 60s. */
  timeoutMs?: number;
  /** Writable streams for pass-through output. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface WrapRememberResult {
  exitCode: number;
  spooled: boolean;
  contentHash?: string;
  reason?: string;
}

/**
 * Exit codes that mean "do not spool" — caller/argv/template error or an
 * intentional similarity-guard refusal. Only runtime failures (1, signals,
 * ENOENT after we already resolved the binary, timeouts) land in the spool.
 */
const NO_SPOOL_EXIT_CODES = new Set([2, 3]);

export async function wrapLessonRemember(opts: WrapRememberOptions): Promise<WrapRememberResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const env = opts.env ?? process.env;

  if (!isLessonRememberArgv(opts.argv)) {
    // Caller should not use this path for non-lesson remember; pass through.
    const code = await runPassthrough(opts.realKbBin, opts.argv, opts.stdinBody, env, stdout, stderr, opts.timeoutMs);
    return { exitCode: code, spooled: false };
  }

  const title = extractRememberTitle(opts.argv);
  const kb = extractRememberKb(opts.argv);
  const run = await runCapturing(opts.realKbBin, opts.argv, opts.stdinBody, env, opts.timeoutMs);

  // Emit the outcome marker at the HEAD of our stdout — before echoing kb's own
  // (possibly large) output. The #1538 gate reads this marker out of the hook
  // trail's captured `tool_response`, which the agent runtime may truncate; a
  // leading marker survives a tail-truncated capture, a trailing one may not.
  if (run.exitCode === 0) {
    // Exit 0 is almost always a genuine lesson write (`write_performed: true`),
    // but guard against a future `kb` that reports a suppressed no-op with a
    // clean exit: only confirm when the envelope does not say otherwise.
    if (detectWritePerformed(run.stdout + '\n' + run.stderr) === false) {
      stdout.write(`${KB_LESSON_WRITE_NOT_RECORDED_MARKER} (kb reported write_performed: false)\n`);
      stdout.write(NOT_RECORDED_HINT);
      echoRun(stdout, stderr, run);
      return { exitCode: 0, spooled: false, reason: 'not-recorded' };
    }
    stdout.write(`${KB_LESSON_WRITE_RECORDED_MARKER}\n`);
    echoRun(stdout, stderr, run);
    return { exitCode: 0, spooled: false };
  }

  if (NO_SPOOL_EXIT_CODES.has(run.exitCode) || !title || !opts.stdinBody.trim()) {
    // Similarity guard (exit 3) / lesson-validation (exit 2) / caller error:
    // nothing was stored and nothing is spoolable. Tell the agent (and the
    // gate) explicitly that no lesson was recorded.
    stdout.write(`${KB_LESSON_WRITE_NOT_RECORDED_MARKER} (kb exit ${run.exitCode})\n`);
    stdout.write(NOT_RECORDED_HINT);
    echoRun(stdout, stderr, run);
    return { exitCode: run.exitCode, spooled: false, reason: 'not-spoolable' };
  }

  const spoolDir = opts.spoolDir ?? defaultSpoolDir(env);
  const entry = buildLessonEntry({
    kb,
    title,
    body: opts.stdinBody,
    taskId: opts.taskId ?? env.KOOKR_TASK_ID,
    source: 'kb-remember',
    lastError: (run.stderr || run.stdout || `exit ${run.exitCode}`).slice(0, 500),
  });
  const appended = await appendLessonWrite(spoolDir, entry);

  // The lesson is durably captured (spool is the source of truth until drain
  // succeeds), so confirm it to the #1538 gate just like a direct write.
  stdout.write(`${KB_LESSON_WRITE_RECORDED_MARKER} (durable spool ${entry.contentHash.slice(0, 12)}…)\n`);
  echoRun(stdout, stderr, run);
  stderr.write(
    `[kookr] kb remember failed (exit ${run.exitCode}); ` +
    `lesson ${appended.reason === 'duplicate' ? 'already in' : 'appended to'} ` +
    `durable spool (${entry.contentHash.slice(0, 12)}…). ` +
    `Will replay on KB recovery.\n`,
  );

  // Exit 0 so agents/playbooks treat the lesson as durably captured.
  // The spool is the source of truth until drain succeeds.
  return {
    exitCode: 0,
    spooled: true,
    contentHash: entry.contentHash,
    reason: appended.reason,
  };
}

/** Echo the real kb process output after our leading outcome marker. */
function echoRun(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  run: { stdout: string; stderr: string },
): void {
  if (run.stdout) stdout.write(run.stdout);
  if (run.stderr) stderr.write(run.stderr);
}

async function runCapturing(
  bin: string,
  argv: string[],
  stdinBody: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(bin, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({
        exitCode: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      stderr += c;
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr || `timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({
        exitCode: err.code === 'ENOENT' ? 127 : 1,
        stdout,
        stderr: err.message,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      finish({
        exitCode: code ?? (signal ? 1 : 0),
        stdout,
        stderr,
      });
    });

    // Ignore EPIPE when the child exits before consuming stdin.
    child.stdin?.on('error', () => {});
    try {
      child.stdin?.end(stdinBody, 'utf8');
    } catch (err) {
      clearTimeout(timer);
      finish({
        exitCode: 1,
        stdout,
        stderr: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

async function runPassthrough(
  bin: string,
  argv: string[],
  stdinBody: string,
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  timeoutMs = 60_000,
): Promise<number> {
  const result = await runCapturing(bin, argv, stdinBody, env, timeoutMs);
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  return result.exitCode;
}
