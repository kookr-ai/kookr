import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BASELINE_PATH,
  GLOBAL_FILE_KEY,
  TSCONFIG_PATH,
  compareToBaseline,
  evaluate,
  parseTscOutput,
  type ErrorCounts,
} from './check-frontend-types.js';

// Output shaped like `tsc --pretty false`: one line per diagnostic, plus
// indented continuation lines that must not be counted.
const TSC_OUTPUT = [
  "src/frontend/App.tsx(117,47): error TS2322: Type 'Promise<...>' is not assignable to type 'Promise<...>'.",
  "  Type '{ default: never; }' is not assignable to type '{ default: ComponentType<unknown>; }'.",
  "src/frontend/App.tsx(2065,25): error TS7006: Parameter 'fromPrefill' implicitly has an 'any' type.",
  "src/frontend/App.tsx(2103,31): error TS7006: Parameter 'settings' implicitly has an 'any' type.",
  "src/frontend/presentation.ts(39,7): error TS2741: Property '\"new-agent\"' is missing in type '{...}'.",
].join('\n');

// What a new AgentType member does: the exhaustive maps in presentation.ts
// gain TS2741 errors while every pre-existing error stays as it was.
const BASELINE: ErrorCounts = {
  'src/frontend/App.tsx': { TS2322: 1, TS7006: 2 },
};

describe('parseTscOutput', () => {
  it('counts one error per diagnostic line, keyed by file and code', () => {
    const parsed = parseTscOutput(TSC_OUTPUT);
    expect(parsed.counts).toEqual({
      'src/frontend/App.tsx': { TS2322: 1, TS7006: 2 },
      'src/frontend/presentation.ts': { TS2741: 1 },
    });
    expect(parsed.diagnostics).toHaveLength(4);
  });

  it('counts errors that tsc reports without a file', () => {
    const parsed = parseTscOutput("error TS5083: Cannot read file '/x/tsconfig.json'.");
    expect(parsed.counts).toEqual({ [GLOBAL_FILE_KEY]: { TS5083: 1 } });
  });

  it('normalizes Windows path separators so the baseline matches on every OS', () => {
    const parsed = parseTscOutput("src\\frontend\\App.tsx(1,1): error TS2322: Type 'a' is not assignable to type 'b'.");
    expect(parsed.counts).toEqual({ 'src/frontend/App.tsx': { TS2322: 1 } });
  });
});

describe('compareToBaseline', () => {
  it('reports a higher count for a known file and code as added', () => {
    const { added, removed } = compareToBaseline({ 'a.ts': { TS2322: 3 } }, { 'a.ts': { TS2322: 2 } });
    expect(added).toEqual([{ file: 'a.ts', code: 'TS2322', baseline: 2, current: 3 }]);
    expect(removed).toEqual([]);
  });

  it('reports a new code in a known file as added', () => {
    const { added } = compareToBaseline({ 'a.ts': { TS2322: 1, TS2741: 1 } }, { 'a.ts': { TS2322: 1 } });
    expect(added).toEqual([{ file: 'a.ts', code: 'TS2741', baseline: 0, current: 1 }]);
  });

  it('reports a lower count, or a file with no errors left, as removed', () => {
    const { added, removed } = compareToBaseline(
      { 'a.ts': { TS2322: 1 } },
      { 'a.ts': { TS2322: 2 }, 'b.ts': { TS7006: 1 } },
    );
    expect(added).toEqual([]);
    expect(removed).toEqual([
      { file: 'a.ts', code: 'TS2322', baseline: 2, current: 1 },
      { file: 'b.ts', code: 'TS7006', baseline: 1, current: 0 },
    ]);
  });
});

describe('evaluate', () => {
  it('fails on an error the baseline does not allow and prints that error', () => {
    const result = evaluate(2, TSC_OUTPUT, BASELINE);
    expect(result.ok).toBe(false);
    const report = result.report.join('\n');
    expect(report).toContain('src/frontend/presentation.ts TS2741: 1 now, baseline allows 0');
    expect(report).toContain("src/frontend/presentation.ts(39,7): error TS2741: Property '\"new-agent\"' is missing");
    // Errors that match the baseline are not listed as new.
    expect(report).not.toContain('src/frontend/App.tsx TS7006');
  });

  it('passes when the errors match the baseline exactly', () => {
    const withoutNew = TSC_OUTPUT.split('\n').filter((l) => !l.includes('presentation.ts')).join('\n');
    const result = evaluate(2, withoutNew, BASELINE);
    expect(result.ok).toBe(true);
    expect(result.report.join('\n')).toContain('3 known error(s)');
  });

  it('passes when tsc reports no errors and the baseline is empty', () => {
    expect(evaluate(0, '', {}).ok).toBe(true);
  });

  it('fails when an error was fixed but the baseline still records it', () => {
    const result = evaluate(0, '', BASELINE);
    expect(result.ok).toBe(false);
    expect(result.report.join('\n')).toContain('pnpm check:frontend --update-baseline');
  });

  it('fails closed when tsc exits non-zero without a parsable error', () => {
    const result = evaluate(1, 'Something went wrong while loading the config.', BASELINE);
    expect(result.ok).toBe(false);
    expect(result.report.join('\n')).toContain('could not run');
    expect(result.report.join('\n')).toContain('Something went wrong while loading the config.');
  });

  it('fails closed when tsc was killed by a signal, even if its partial output matches the baseline', () => {
    const matchingBaseline = TSC_OUTPUT.split('\n').filter((l) => !l.includes('presentation.ts')).join('\n');
    // Same output passes with a normal exit status (see above); only the signal makes it fail.
    expect(evaluate(2, matchingBaseline, BASELINE).ok).toBe(true);
    const result = evaluate(null, matchingBaseline, BASELINE);
    expect(result.ok).toBe(false);
    expect(result.report.join('\n')).toContain('could not run: tsc was killed by a signal');
  });
});

describe('committed files', () => {
  const repoRoot = process.cwd();

  it('the baseline is sorted, so --update-baseline produces no diff on an unchanged tree', () => {
    const raw = readFileSync(join(repoRoot, BASELINE_PATH), 'utf8');
    const counts = JSON.parse(raw) as ErrorCounts;
    expect(Object.keys(counts)).toEqual(Object.keys(counts).sort());
    for (const byCode of Object.values(counts)) {
      expect(Object.keys(byCode)).toEqual(Object.keys(byCode).sort());
      for (const n of Object.values(byCode)) expect(n).toBeGreaterThan(0);
    }
  });

  it('the frontend tsconfig checks src/frontend with JSX and DOM types', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, TSCONFIG_PATH), 'utf8')) as {
      compilerOptions: { jsx?: string; lib?: string[]; noEmit?: boolean };
      include: string[];
    };
    expect(config.compilerOptions.jsx).toBe('react-jsx');
    expect(config.compilerOptions.lib).toContain('DOM');
    expect(config.compilerOptions.noEmit).toBe(true);
    expect(config.include).toEqual(['src/frontend/**/*.ts', 'src/frontend/**/*.tsx']);
  });
});
