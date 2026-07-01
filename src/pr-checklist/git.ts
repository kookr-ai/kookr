// PR Checklist Contract — git/diff glue (P1).
//
// The only impure dependency of the engine. The runner is injectable so the
// engine is unit-testable without a real repo. Resource caps (S8) bound the
// diff we will read; the default runner uses execFile with a maxBuffer ceiling
// so a pathological diff surfaces as an error, never an OOM.

import { execFile } from 'node:child_process';
import { ChecklistInputError } from './errors.js';
import type { DiffFacts } from './types.js';

export interface GitRunner {
  (args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

// S8: caps. A diff larger than the buffer, or more added lines than the cap,
// is a resource-limit condition the caller treats as a verification failure
// (fail-closed), not a silent pass.
export const MAX_DIFF_BYTES = 8 * 1024 * 1024;
export const MAX_ADDED_LINES = 200_000;

export function execGit(cwd: string): GitRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { maxBuffer: MAX_DIFF_BYTES, encoding: 'utf-8', windowsHide: true, timeout: 30_000 },
        (error, stdout, stderr) => {
          const nodeError = error as NodeJS.ErrnoException | null;
          const exitCode = typeof nodeError?.code === 'number' ? nodeError.code : error ? 1 : 0;
          resolve({ stdout: String(stdout), stderr: String(stderr || error?.message || ''), exitCode });
        },
      );
    });
}

async function ok(runner: GitRunner, args: readonly string[]): Promise<string | null> {
  const r = await runner(args);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** Resolve a merge-base for the diff, falling back conservatively. Null ⇒ unresolved. */
export async function resolveBase(runner: GitRunner, base: string): Promise<string | null> {
  for (const ref of [`origin/${base}`, base]) {
    const mb = await ok(runner, ['merge-base', ref, 'HEAD']);
    if (mb) return mb;
  }
  return null;
}

/** Collect the diff facts the engine needs for the range `<baseSha>...HEAD`. */
export async function collectDiffFacts(runner: GitRunner, base: string): Promise<DiffFacts> {
  const baseSha = await resolveBase(runner, base);
  if (!baseSha) {
    return {
      changedPaths: [],
      addedFiles: [],
      addedSourceLines: [],
      addedScannableLines: [],
      baseUnresolved: true,
    };
  }
  const range = `${baseSha}...HEAD`;

  const nameStatus = (await ok(runner, ['diff', '--name-status', range])) ?? '';
  const changedPaths: string[] = [];
  const addedFiles: string[] = [];
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parts[0][0];
    const path = parts[parts.length - 1]; // rename dest
    changedPaths.push(path);
    if (status === 'A') addedFiles.push(path);
  }

  const unified = (await ok(runner, ['diff', '--unified=0', range])) ?? '';
  const addedSourceLines: string[] = [];
  const addedScannableLines: { file: string; text: string }[] = [];
  let currentFile: string | null = null;
  let count = 0;
  for (const line of unified.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
    } else if (line.startsWith('+') && !line.startsWith('+++') && currentFile) {
      if (++count > MAX_ADDED_LINES) throw new ChecklistInputError('diff exceeds MAX_ADDED_LINES cap');
      const text = line.slice(1);
      if (/^src\/.*\.[jt]s$/.test(currentFile)) addedSourceLines.push(text);
      if (!/^\.env(\.|$)/.test(currentFile) && !/\.md$/.test(currentFile)) {
        addedScannableLines.push({ file: currentFile, text });
      }
    }
  }

  return { changedPaths, addedFiles, addedSourceLines, addedScannableLines, baseUnresolved: false };
}
