import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectRerunFiles } from './flaky-rerun-files.mjs';

const cwd = '/repo';
const result = (name: string, status: string) => ({ name: `/repo/${name}`, status });

describe('selectRerunFiles', () => {
  it('returns the failed files, relative and sorted, when few failed', () => {
    const report = {
      testResults: [result('src/b.test.ts', 'failed'), result('src/ok.test.ts', 'passed'), result('src/a.test.ts', 'failed')],
    };
    expect(selectRerunFiles(report, { cwd })).toEqual({ ok: true, files: ['src/a.test.ts', 'src/b.test.ts'] });
  });

  it('refuses when more files failed than the cap', () => {
    const report = { testResults: Array.from({ length: 6 }, (_, i) => result(`src/f${i}.test.ts`, 'failed')) };
    const out = selectRerunFiles(report, { cwd, maxFiles: 5 });
    expect(out.ok).toBe(false);
  });

  it('refuses when no file is marked failed (an error outside the tests)', () => {
    expect(selectRerunFiles({ testResults: [result('src/ok.test.ts', 'passed')] }, { cwd }).ok).toBe(false);
  });

  it('refuses a report without testResults', () => {
    expect(selectRerunFiles({}, { cwd }).ok).toBe(false);
    expect(selectRerunFiles(null, { cwd }).ok).toBe(false);
  });
});

describe('flaky-rerun-files CLI', () => {
  const script = join(process.cwd(), 'scripts/flaky-rerun-files.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('prints one file per line and exits 0, or exits 3 when a rerun is not worth it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-rerun-'));
    try {
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify({ testResults: [{ name: join(process.cwd(), 'src/x.test.ts'), status: 'failed' }] }));
      const ok = run(good);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toBe('src/x.test.ts\n');

      expect(run(join(dir, 'missing.json')).status).toBe(3);
      expect(run(good, '--max-files', '0').status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
