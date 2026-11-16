#!/usr/bin/env node
// verify-report - the machine-readable result of one scripts/verify.sh run (issue #3995).
//
// When a verify run is red, the integration train wants to know which part
// failed (a lane, and for the unit lane its test files) without parsing the
// free-text log. scripts/verify.sh records each step it starts and each step
// that passes in a small tab-separated file; on exit it calls this script,
// which turns that record into JSON:
//
//   {
//     "version": 1,
//     "head": "<sha the run checked>",
//     "status": "passed" | "failed",
//     "exitCode": <exit status of verify.sh>,
//     "failures": [
//       { "lane": "unit_lane", "step": "Running tests", "command": "unit_tests",
//         "testFiles": ["src/core/a.test.ts"] }
//     ]
//   }
//
// - `lane` is the lane function in scripts/verify.sh (build_server_lane,
//   static_checks, unit_lane, integration_lane, faa_lane, smoke_lane,
//   hooks_lane, stt_lane); `step` is the label it prints after `==>`;
//   `command` is what the step runs (`pnpm check:cycles`, or `unit_tests` for
//   the unit lane).
// - A failure is a step that started and never passed. Several can fail when
//   the train runs lanes at the same time.
// - `testFiles` is set on the unit lane only, and only when the Vitest run
//   summary names every failing file: no unhandled error, no crashed worker,
//   at least one file marked failed. Otherwise it is left out, because a
//   partial list would send a narrow re-run after the wrong files.
// - A failed run with an empty `failures` list failed outside any step (or
//   was killed): the failing part is unknown.
//
// Usage: node scripts/verify-report.mjs --steps <file> --exit-code <n> --out <file>
//          [--head <sha>] [--unit-summary <file>]
// The steps file has one line per event: `start|pass <TAB> lane <TAB> step <TAB> command`.
// The unit summary is the one test/rerun-gate.reporter.mjs writes.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const UNFINISHED_STATES = new Set(['pending', 'queued']);

/**
 * Every failing test file a Vitest run summary names, or null when the summary
 * cannot be trusted to name them all.
 * @param {unknown} summary
 * @param {string} cwd
 * @returns {string[] | null}
 */
export function failedTestFiles(summary, cwd) {
  const s = /** @type {any} */ (summary);
  if (!s || typeof s !== 'object' || !Array.isArray(s.modules)) return null;
  if (s.reason !== 'failed' || s.unhandledErrors !== 0) return null;
  if (s.modules.some((m) => m && UNFINISHED_STATES.has(m.state))) return null;
  const files = s.modules
    .filter((m) => m && m.state === 'failed' && typeof m.file === 'string')
    .map((m) => relative(cwd, m.file) || m.file);
  return files.length > 0 ? [...new Set(files)].sort() : null;
}

/**
 * @param {object} input
 * @param {string} input.steps the steps file's contents
 * @param {number} input.exitCode verify.sh's exit status
 * @param {string} [input.head]
 * @param {unknown} [input.unitSummary] parsed unit-lane run summary, if any
 * @param {string} [input.cwd] directory test file paths are made relative to
 */
export function buildVerifyReport({ steps, exitCode, head = '', unitSummary = null, cwd = process.cwd() }) {
  const started = new Map();
  const passed = new Set();
  for (const line of steps.split('\n')) {
    const [event, lane, step, command = ''] = line.split('\t');
    if (!lane || !step) continue;
    const key = `${lane}\t${step}`;
    if (event === 'start' && !started.has(key)) started.set(key, { lane, step, command });
    else if (event === 'pass') passed.add(key);
  }
  const failures = [];
  if (exitCode !== 0) {
    for (const [key, s] of started) {
      if (passed.has(key)) continue;
      const failure = { lane: s.lane, step: s.step, command: s.command };
      if (s.lane === 'unit_lane') {
        const files = failedTestFiles(unitSummary, cwd);
        if (files) failure.testFiles = files;
      }
      failures.push(failure);
    }
  }
  return { version: 1, head, status: exitCode === 0 ? 'passed' : 'failed', exitCode, failures };
}

function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, '');
    opts[name] = argv[++i] ?? '';
  }
  const exitCode = Number(opts['exit-code']);
  if (!opts.out || !opts.steps || !Number.isInteger(exitCode)) {
    process.stderr.write('usage: verify-report.mjs --steps <file> --exit-code <n> --out <file> [--head <sha>] [--unit-summary <file>]\n');
    return 2;
  }
  let steps = '';
  try { steps = readFileSync(opts.steps, 'utf8'); } catch { /* no step started */ }
  let unitSummary = null;
  if (opts['unit-summary']) {
    try { unitSummary = JSON.parse(readFileSync(opts['unit-summary'], 'utf8')); } catch { /* no usable summary */ }
  }
  const report = buildVerifyReport({ steps, exitCode, head: opts.head ?? '', unitSummary });
  // Write then rename, so a reader never sees half a file.
  const tmp = `${opts.out}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, opts.out);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
