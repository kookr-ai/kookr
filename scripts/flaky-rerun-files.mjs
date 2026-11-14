#!/usr/bin/env node
// flaky-rerun-files — decide which test files the pre-push hook may re-run.
//
// When the unit suite fails, the pre-push hook re-runs only the failed files,
// once, instead of making the agent push again and pay for the whole suite. A
// file that passes on the re-run is a flake: the push goes through and the hook
// records it so someone can fix it. A file that fails again is a real failure.
//
// Usage: node scripts/flaky-rerun-files.mjs <vitest-json-report> [--max-files N]
//
// Prints the failed test files (relative to the current directory), one per
// line, and exits 0 when a re-run is worth trying. Exits 3 with a reason on
// stderr when it is not, so the hook rejects the push as before:
//   - the report is missing or unreadable (the run crashed before writing it);
//   - nothing is marked failed (e.g. an unhandled error outside any test);
//   - more than N files failed (default 5), which looks like a real break.
// Exits 2 on bad usage.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MAX_FILES = 5;

/**
 * @param {unknown} report Parsed vitest JSON report.
 * @param {{ maxFiles?: number, cwd?: string }} [opts]
 * @returns {{ ok: true, files: string[] } | { ok: false, reason: string }}
 */
export function selectRerunFiles(report, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const cwd = opts.cwd ?? process.cwd();
  const results = report && typeof report === 'object' ? /** @type {any} */ (report).testResults : undefined;
  if (!Array.isArray(results)) return { ok: false, reason: 'report has no testResults array' };
  const failed = results
    .filter((r) => r && r.status === 'failed' && typeof r.name === 'string')
    .map((r) => relative(cwd, r.name) || r.name);
  const files = [...new Set(failed)].sort();
  if (files.length === 0) return { ok: false, reason: 'no test file is marked failed (an error outside the tests?)' };
  if (files.length > maxFiles) {
    return { ok: false, reason: `${files.length} test files failed (more than ${maxFiles}); not treating this as flakiness` };
  }
  return { ok: true, files };
}

function main(argv) {
  const [reportPath, ...rest] = argv;
  let maxFiles = DEFAULT_MAX_FILES;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--max-files') maxFiles = Number(rest[++i]);
  }
  if (!reportPath || !Number.isInteger(maxFiles) || maxFiles < 1) {
    console.error('usage: flaky-rerun-files.mjs <vitest-json-report> [--max-files N]');
    return 2;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.error(`flaky-rerun-files: cannot read ${reportPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  const result = selectRerunFiles(report, { maxFiles });
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
