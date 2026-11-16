import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Type-checks the browser dashboard under src/frontend (issue #3648).
//
// The root tsconfig.json excludes src/frontend and Vite strips types without
// checking them, so for a long time no gate type-checked frontend code. A new
// member of a shared union such as AgentType then left the frontend's
// exhaustive `Record<AgentType, ...>` maps incomplete, and the dashboard
// crashed at runtime on an undefined lookup.
//
// tsconfig.frontend.json checks the frontend's production files (tests are
// excluded). The frontend already had type errors when this gate was added,
// so this script compares tsc's errors against a committed baseline and fails
// only when there are more errors than the baseline allows:
//
//   - The baseline counts errors per (file, TS error code). Line numbers move
//     on every edit and messages embed whole types, so neither is part of the
//     key: a new error shows up as a higher count for its file and code.
//   - Fewer errors than the baseline also fails, so a fixed error cannot come
//     back unnoticed. Shrink the baseline with
//     `pnpm check:frontend --update-baseline`.
//   - If tsc fails without reporting any error we can parse (a broken config,
//     a crash), the check fails rather than reading that as "no new errors".

export const BASELINE_PATH = 'scripts/frontend-type-baseline.json';
export const TSCONFIG_PATH = 'tsconfig.frontend.json';

/** Error counts keyed by file path (as tsc prints it), then by TS error code. */
export type ErrorCounts = Record<string, Record<string, number>>;

export interface ParsedTscOutput {
  counts: ErrorCounts;
  /** First line of each diagnostic, used to show the errors behind a new count. */
  diagnostics: Array<{ file: string; code: string; line: string }>;
}

// `src/frontend/App.tsx(117,47): error TS2322: Type ...` (--pretty false).
const FILE_DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error (TS\d+): /;
// Errors with no file, such as `error TS5083: Cannot read file ...`.
const GLOBAL_DIAGNOSTIC = /^error (TS\d+): /;
export const GLOBAL_FILE_KEY = '<no file>';

export function parseTscOutput(output: string): ParsedTscOutput {
  const counts: ErrorCounts = {};
  const diagnostics: ParsedTscOutput['diagnostics'] = [];
  for (const line of output.split(/\r?\n/)) {
    let file: string;
    let code: string;
    const fileMatch = FILE_DIAGNOSTIC.exec(line);
    if (fileMatch) {
      file = fileMatch[1].replace(/\\/g, '/');
      code = fileMatch[2];
    } else {
      const globalMatch = GLOBAL_DIAGNOSTIC.exec(line);
      if (!globalMatch) continue;
      file = GLOBAL_FILE_KEY;
      code = globalMatch[1];
    }
    const byCode = (counts[file] ??= {});
    byCode[code] = (byCode[code] ?? 0) + 1;
    diagnostics.push({ file, code, line });
  }
  return { counts: sortCounts(counts), diagnostics };
}

export interface CountChange {
  file: string;
  code: string;
  baseline: number;
  current: number;
}

export interface BaselineComparison {
  /** (file, code) pairs with more errors than the baseline allows. */
  added: CountChange[];
  /** (file, code) pairs with fewer errors than the baseline records. */
  removed: CountChange[];
}

export function compareToBaseline(current: ErrorCounts, baseline: ErrorCounts): BaselineComparison {
  const added: CountChange[] = [];
  const removed: CountChange[] = [];
  const files = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const codes = new Set([...Object.keys(current[file] ?? {}), ...Object.keys(baseline[file] ?? {})]);
    for (const code of [...codes].sort()) {
      const now = current[file]?.[code] ?? 0;
      const before = baseline[file]?.[code] ?? 0;
      if (now > before) added.push({ file, code, baseline: before, current: now });
      else if (now < before) removed.push({ file, code, baseline: before, current: now });
    }
  }
  return { added, removed };
}

export function sortCounts(counts: ErrorCounts): ErrorCounts {
  const out: ErrorCounts = {};
  for (const file of Object.keys(counts).sort()) {
    const byCode: Record<string, number> = {};
    for (const code of Object.keys(counts[file]).sort()) byCode[code] = counts[file][code];
    out[file] = byCode;
  }
  return out;
}

export function totalErrors(counts: ErrorCounts): number {
  let total = 0;
  for (const byCode of Object.values(counts)) for (const n of Object.values(byCode)) total += n;
  return total;
}

export interface CheckResult {
  ok: boolean;
  /** Lines to print, in order. */
  report: string[];
}

/**
 * Decides the check's outcome from one tsc run. `tscStatus` is tsc's exit
 * status (null when it was killed by a signal).
 */
export function evaluate(tscStatus: number | null, tscOutput: string, baseline: ErrorCounts): CheckResult {
  const parsed = parseTscOutput(tscOutput);
  const total = totalErrors(parsed.counts);
  if (tscStatus === null || (tscStatus !== 0 && total === 0)) {
    return {
      ok: false,
      report: [
        tscStatus === null
          ? 'Frontend type-check could not run: tsc was killed by a signal or did not start, so its output may be partial.'
          : `Frontend type-check could not run: tsc exited with status ${tscStatus} and reported no type errors.`,
        'tsc output:',
        tscOutput.trimEnd() || '(empty)',
      ],
    };
  }

  const { added, removed } = compareToBaseline(parsed.counts, baseline);
  const report: string[] = [];
  if (added.length > 0) {
    report.push('New frontend type errors (more than the baseline allows):');
    for (const change of added) {
      report.push(`  ${change.file} ${change.code}: ${change.current} now, baseline allows ${change.baseline}`);
      for (const d of parsed.diagnostics) {
        if (d.file === change.file && d.code === change.code) report.push(`    ${d.line}`);
      }
    }
    report.push('Fix these errors. Do not add them to the baseline.');
  }
  if (removed.length > 0) {
    report.push('Fewer frontend type errors than the baseline records:');
    for (const change of removed) {
      report.push(`  ${change.file} ${change.code}: ${change.current} now, baseline records ${change.baseline}`);
    }
    report.push(`Shrink the baseline so these errors cannot come back: pnpm check:frontend --update-baseline`);
  }
  if (added.length === 0 && removed.length === 0) {
    report.push(`Frontend type-check: ${total} known error(s), all in ${BASELINE_PATH}; no new errors.`);
    return { ok: true, report };
  }
  return { ok: false, report };
}

function readBaseline(path: string): ErrorCounts {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as ErrorCounts;
}

function runTsc(repoRoot: string): { status: number | null; output: string } {
  const tscBin = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tscBin, '-p', join(repoRoot, TSCONFIG_PATH), '--pretty', 'false'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { status: null, output: String(result.error) };
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function main(argv: string[]): number {
  const repoRoot = process.cwd();
  const baselinePath = resolve(repoRoot, BASELINE_PATH);
  const { status, output } = runTsc(repoRoot);

  if (argv.includes('--update-baseline')) {
    const parsed = parseTscOutput(output);
    if (status === null || (status !== 0 && totalErrors(parsed.counts) === 0)) {
      console.error(evaluate(status, output, {}).report.join('\n'));
      return 1;
    }
    writeFileSync(baselinePath, `${JSON.stringify(parsed.counts, null, 2)}\n`);
    console.log(`Wrote ${BASELINE_PATH}: ${totalErrors(parsed.counts)} error(s).`);
    return 0;
  }

  const result = evaluate(status, output, readBaseline(baselinePath));
  (result.ok ? console.log : console.error)(result.report.join('\n'));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
