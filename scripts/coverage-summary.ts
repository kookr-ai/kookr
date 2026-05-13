#!/usr/bin/env node
// Render Vitest V8 coverage JSON into a compact Markdown summary suitable for
// $GITHUB_STEP_SUMMARY. See docs/rfc/rfc-testing-surfacing.md (Change 3) for
// the exit-code contract; see docs/testing.md for the runbook.
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number | string;
}

interface FileCoverage {
  lines: CoverageMetric;
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
}

type CoverageSummary = { total: FileCoverage } & Record<string, FileCoverage>;

interface Layer {
  name: string;
  patterns: string[];
}

const LAYERS: Layer[] = [
  {
    name: 'Orchestration',
    patterns: ['orchestrat', 'event-pipeline', 'event-projection', 'launch-service'],
  },
  {
    name: 'Hooks',
    patterns: ['hook-watcher', 'hook-runner', 'hook-event', '/hooks/'],
  },
  {
    name: 'Process lifecycle',
    patterns: ['lifecycle', 'crash-recovery'],
  },
  {
    name: 'Terminal sessions',
    patterns: ['terminal-backend', 'dtach-backend', 'session-bridge', 'terminal-bridge'],
  },
  {
    name: 'WebSocket state',
    patterns: ['/ws-', '/ws.ts', 'ws-handlers', 'ws-connection'],
  },
];

const TOP_LINES_THRESHOLD = 80;
const TOP_BRANCHES_THRESHOLD = 70;
const TOP_N = 10;

function emitAnnotation(level: 'notice' | 'error', message: string): void {
  process.stderr.write(`::${level}::${message.replace(/\r?\n/g, ' ')}\n`);
}

function fmtPct(pct: number | string): string {
  return typeof pct === 'number' ? `${pct.toFixed(1)}%` : '—';
}

function renderTotalTable(total: FileCoverage): string {
  return [
    '| Metric | Covered | Total | Percent |',
    '|---|---:|---:|---:|',
    `| Lines | ${total.lines.covered} | ${total.lines.total} | ${fmtPct(total.lines.pct)} |`,
    `| Statements | ${total.statements.covered} | ${total.statements.total} | ${fmtPct(total.statements.pct)} |`,
    `| Branches | ${total.branches.covered} | ${total.branches.total} | ${fmtPct(total.branches.pct)} |`,
    `| Functions | ${total.functions.covered} | ${total.functions.total} | ${fmtPct(total.functions.pct)} |`,
  ].join('\n');
}

function pctFromTotals(covered: number, total: number): number | string {
  return total > 0 ? (covered / total) * 100 : 'Unknown';
}

function aggregateLayer(
  files: Array<[string, FileCoverage]>,
  patterns: string[],
): { files: number; linesPct: number | string; branchesPct: number | string } {
  let lTotal = 0;
  let lCovered = 0;
  let bTotal = 0;
  let bCovered = 0;
  let fileCount = 0;
  for (const [path, cov] of files) {
    if (patterns.some((p) => path.includes(p))) {
      fileCount += 1;
      lTotal += cov.lines.total;
      lCovered += cov.lines.covered;
      bTotal += cov.branches.total;
      bCovered += cov.branches.covered;
    }
  }
  return {
    files: fileCount,
    linesPct: pctFromTotals(lCovered, lTotal),
    branchesPct: pctFromTotals(bCovered, bTotal),
  };
}

function renderLayerTable(fileEntries: Array<[string, FileCoverage]>): string {
  const rows = LAYERS.map((layer) => {
    const a = aggregateLayer(fileEntries, layer.patterns);
    if (a.files === 0) return `| ${layer.name} | 0 | — | — |`;
    return `| ${layer.name} | ${a.files} | ${fmtPct(a.linesPct)} | ${fmtPct(a.branchesPct)} |`;
  });
  return [
    '| Layer | Files | Lines % | Branches % |',
    '|---|---:|---:|---:|',
    ...rows,
  ].join('\n');
}

function topByUncovered(
  fileEntries: Array<[string, FileCoverage]>,
  metric: 'lines' | 'branches',
  cwd: string,
  n: number,
): string {
  const ranked = fileEntries
    .map(([path, cov]) => {
      const m = cov[metric];
      return {
        path: relative(cwd, path) || path,
        uncovered: m.total - m.covered,
        pct: m.pct,
      };
    })
    .filter((r) => r.uncovered > 0)
    .sort((a, b) => b.uncovered - a.uncovered)
    .slice(0, n);
  if (ranked.length === 0) {
    return '_All files fully covered for this metric._';
  }
  const rows = ranked.map((r) => `| \`${r.path}\` | ${r.uncovered} | ${fmtPct(r.pct)} |`);
  return ['| File | Uncovered | Percent |', '|---|---:|---:|', ...rows].join('\n');
}

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    emitAnnotation('error', 'coverage-summary.ts: missing path argument');
    process.exit(1);
  }
  const path = resolve(arg);

  if (!existsSync(path)) {
    emitAnnotation(
      'notice',
      `Coverage data unavailable at ${path} — tests likely failed before coverage finalized; see the test step logs.`,
    );
    process.stdout.write(
      '### Coverage summary\n\n_Coverage data unavailable — tests likely failed before coverage finalized._\n',
    );
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    emitAnnotation('error', `coverage-summary.ts: cannot read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (raw.trim().length === 0) {
    emitAnnotation('error', `Coverage JSON empty at ${path}; rerun job or inspect uploaded artifact.`);
    process.exit(1);
  }

  let parsed: CoverageSummary;
  try {
    parsed = JSON.parse(raw) as CoverageSummary;
  } catch (err) {
    emitAnnotation(
      'error',
      `Coverage JSON malformed at ${path}: ${(err as Error).message}; rerun job or inspect uploaded artifact.`,
    );
    process.exit(1);
  }

  if (!parsed.total || typeof parsed.total !== 'object') {
    emitAnnotation(
      'error',
      `Coverage JSON at ${path} has no "total" key; reporter output is incompatible.`,
    );
    process.exit(1);
  }

  const fileEntries = Object.entries(parsed).filter(
    ([k]) => k !== 'total',
  ) as Array<[string, FileCoverage]>;

  const cwd = process.cwd();
  const out: string[] = [];
  out.push('### Coverage summary');
  out.push('');
  out.push(
    '_Current-run coverage (server/core; frontend excluded). Baseline comparison ships in PR 2 of the testing-surfacing RFC._',
  );
  out.push('');
  out.push(renderTotalTable(parsed.total));
  out.push('');
  out.push('#### By risk layer');
  out.push('');
  out.push(
    '_Layers identified in the Problem section of the testing-surfacing RFC. "0" files means no source files matched the layer path patterns in this run._',
  );
  out.push('');
  out.push(renderLayerTable(fileEntries));
  out.push('');

  const lPct = typeof parsed.total.lines.pct === 'number' ? parsed.total.lines.pct : 100;
  const bPct = typeof parsed.total.branches.pct === 'number' ? parsed.total.branches.pct : 100;

  if (lPct < TOP_LINES_THRESHOLD) {
    out.push(`#### Top ${TOP_N} files by uncovered lines`);
    out.push('');
    out.push(topByUncovered(fileEntries, 'lines', cwd, TOP_N));
    out.push('');
  }
  if (bPct < TOP_BRANCHES_THRESHOLD) {
    out.push(`#### Top ${TOP_N} files by uncovered branches`);
    out.push('');
    out.push(topByUncovered(fileEntries, 'branches', cwd, TOP_N));
    out.push('');
  }

  process.stdout.write(`${out.join('\n')}\n`);
}

try {
  main();
} catch (err) {
  emitAnnotation('error', `coverage-summary.ts crashed: ${(err as Error).message}`);
  process.exit(1);
}
