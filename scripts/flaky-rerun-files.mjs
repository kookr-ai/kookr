#!/usr/bin/env node
// flaky-rerun-files — decide which test files the pre-push hook may re-run.
//
// When the unit suite fails, the pre-push hook re-runs only the failed files,
// once, instead of making the agent push again and pay for the whole suite. A
// file that passes on the re-run is a flake: the push goes through and the hook
// records it so someone can fix it. A file that fails again is a real failure.
//
// Usage: node scripts/flaky-rerun-files.mjs <run-summary.json> [--max-files N]
//
// The summary is written by test/rerun-gate.reporter.mjs. Prints the failed
// test files (relative to the current directory), one per line, and exits 0
// when a re-run is worth trying. Exits 3 with a reason on stderr when it is
// not, so the hook rejects the push as before:
//   - the summary is missing or unreadable (the run crashed before writing it);
//   - the run was interrupted, or reported unhandled errors (these are not tied
//     to a file that a re-run would cover, so a re-run could hide them);
//   - a file never finished (its worker crashed: state pending or queued);
//   - nothing is marked failed;
//   - more than N files failed (default 5), which looks like a real break.
// Exits 2 on bad usage.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_FILES = 5;

const UNFINISHED_STATES = new Set(['pending', 'queued']);

/**
 * @param {unknown} summary Parsed run summary from test/rerun-gate.reporter.mjs.
 * @param {{ maxFiles?: number, cwd?: string }} [opts]
 * @returns {{ ok: true, files: string[] } | { ok: false, reason: string }}
 */
export function selectRerunFiles(summary, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const cwd = opts.cwd ?? process.cwd();
  const s = /** @type {any} */ (summary);
  if (!s || typeof s !== 'object' || !Array.isArray(s.modules)) {
    return { ok: false, reason: 'run summary has no modules array' };
  }
  if (s.reason !== 'failed') return { ok: false, reason: `run ended as "${String(s.reason)}", not as a test failure` };
  if (s.unhandledErrors !== 0) {
    return { ok: false, reason: `the run reported ${String(s.unhandledErrors)} unhandled error(s); a file re-run cannot clear them` };
  }
  const unfinished = s.modules.filter((m) => m && UNFINISHED_STATES.has(m.state));
  if (unfinished.length > 0) {
    return { ok: false, reason: `${unfinished.length} test file(s) never finished (crashed worker?)` };
  }
  const failed = s.modules
    .filter((m) => m && m.state === 'failed' && typeof m.file === 'string')
    .map((m) => relative(cwd, m.file) || m.file);
  const files = [...new Set(failed)].sort();
  if (files.length === 0) return { ok: false, reason: 'no test file is marked failed' };
  if (files.length > maxFiles) {
    return { ok: false, reason: `${files.length} test files failed (more than ${maxFiles}); not treating this as flakiness` };
  }
  return { ok: true, files };
}

function main(argv) {
  const [summaryPath, ...rest] = argv;
  let maxFiles = DEFAULT_MAX_FILES;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--max-files') maxFiles = Number(rest[++i]);
  }
  if (!summaryPath || !Number.isInteger(maxFiles) || maxFiles < 1) {
    console.error('usage: flaky-rerun-files.mjs <run-summary.json> [--max-files N]');
    return 2;
  }
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch (err) {
    console.error(`flaky-rerun-files: cannot read ${summaryPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  const result = selectRerunFiles(summary, { maxFiles });
  if (!result.ok) {
    console.error(`flaky-rerun-files: ${result.reason}`);
    return 3;
  }
  process.stdout.write(`${result.files.join('\n')}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
