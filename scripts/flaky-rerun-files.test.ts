import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { selectRerunFiles } from './flaky-rerun-files.mjs';

const cwd = '/repo';
const mod = (name: string, state: string) => ({ file: `/repo/${name}`, state });
const summary = (modules: Array<{ file: string; state: string }>, extra: Record<string, unknown> = {}) => ({
  reason: 'failed',
  unhandledErrors: 0,
  modules,
  ...extra,
});

describe('selectRerunFiles', () => {
  it('returns the failed files, relative and sorted, when few failed', () => {
    const s = summary([mod('src/b.test.ts', 'failed'), mod('src/ok.test.ts', 'passed'), mod('src/a.test.ts', 'failed')]);
    expect(selectRerunFiles(s, { cwd })).toEqual({ ok: true, files: ['src/a.test.ts', 'src/b.test.ts'] });
  });

  it('ignores skipped files', () => {
    const s = summary([mod('src/a.test.ts', 'failed'), mod('src/skip.test.ts', 'skipped')]);
    expect(selectRerunFiles(s, { cwd })).toEqual({ ok: true, files: ['src/a.test.ts'] });
  });

  it('re-runs exactly the cap, and refuses one more', () => {
    const failed = (n: number) => summary(Array.from({ length: n }, (_, i) => mod(`src/f${i}.test.ts`, 'failed')));
    expect(selectRerunFiles(failed(5), { cwd, maxFiles: 5 })).toMatchObject({ ok: true });
    expect(selectRerunFiles(failed(6), { cwd, maxFiles: 5 }).ok).toBe(false);
  });

  it('refuses when the run also had an unhandled error, even with a failed file to re-run', () => {
    // An unhandled rejection leaves its own file "passed", so a re-run of the
    // failed file alone would hide it.
    const s = summary([mod('src/a.test.ts', 'passed'), mod('src/b.test.ts', 'failed')], { unhandledErrors: 1 });
    expect(selectRerunFiles(s, { cwd })).toMatchObject({ ok: false, reason: expect.stringContaining('unhandled') });
  });

  it('refuses when a file never finished (crashed worker)', () => {
    const s = summary([mod('src/b.test.ts', 'failed'), mod('src/c.test.ts', 'pending')]);
    expect(selectRerunFiles(s, { cwd })).toMatchObject({ ok: false, reason: expect.stringContaining('never finished') });
    expect(selectRerunFiles(summary([mod('src/b.test.ts', 'failed'), mod('src/d.test.ts', 'queued')]), { cwd }).ok).toBe(false);
  });

  it('refuses an interrupted run', () => {
    expect(selectRerunFiles(summary([mod('src/b.test.ts', 'failed')], { reason: 'interrupted' }), { cwd }).ok).toBe(false);
  });

  it('refuses when no file is marked failed', () => {
    expect(selectRerunFiles(summary([mod('src/ok.test.ts', 'passed')]), { cwd }).ok).toBe(false);
  });

  it('refuses a malformed summary', () => {
    expect(selectRerunFiles({}, { cwd }).ok).toBe(false);
    expect(selectRerunFiles(null, { cwd }).ok).toBe(false);
    expect(selectRerunFiles({ reason: 'failed', modules: [mod('src/b.test.ts', 'failed')] }, { cwd }).ok).toBe(false);
  });
});

describe('flaky-rerun-files CLI', () => {
  const script = join(process.cwd(), 'scripts/flaky-rerun-files.mjs');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('prints one file per line and exits 0, or exits 3 when a rerun is not worth it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flaky-rerun-'));
    try {
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify(summary([{ file: join(process.cwd(), 'src/x.test.ts'), state: 'failed' }])));
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
