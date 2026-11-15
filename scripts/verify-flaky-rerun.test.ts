// scripts/verify.sh unit lane with KOOKR_VERIFY_FLAKY_RERUN=1 (issue #3790).
// The integration train sets the flag so its full verify applies the pre-push
// hook's flaky policy. `pnpm` is a stub on PATH: `pnpm test` fails and writes the
// run summary test/rerun-gate.reporter.mjs would write; the re-run
// (`pnpm exec vitest run <files>`) passes or fails as each test asks. The real
// scripts/flaky-rerun-files.mjs decides what to re-run. git runs only in a
// mkdtemp repository.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { gitExecEnv } from '../src/core/git-helpers.js';

const VERIFY = join(resolve(dirname(fileURLToPath(import.meta.url))), 'verify.sh');
const ENV_BASE = { ...gitExecEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(failedFiles: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'verify-flaky-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: ENV_BASE });
  const summary = {
    reason: 'failed',
    unhandledErrors: 0,
    modules: [
      ...failedFiles.map((f) => ({ file: join(repo, f), state: 'failed' })),
      { file: join(repo, 'src/fine.test.ts'), state: 'passed' },
    ],
  };
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary));
  const log = join(root, 'pnpm.log');
  writeFileSync(join(bin, 'pnpm'), [
    '#!/usr/bin/env bash',
    `printf '%s | summary=%s\\n' "$*" "\${VITEST_RERUN_SUMMARY_FILE:+set}" >> "${log}"`,
    'if [ "$1" = test ]; then',
    `  [ -n "\${VITEST_RERUN_SUMMARY_FILE:-}" ] && cp "${join(root, 'summary.json')}" "$VITEST_RERUN_SUMMARY_FILE"`,
    '  exit 1',
    'fi',
    'if [ "$1" = exec ]; then exit "${RERUN_EXIT:-0}"; fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'pnpm'), 0o755);
  const run = (env: Record<string, string>) => {
    const r = spawnSync('bash', [VERIFY], {
      cwd: repo, encoding: 'utf8', // Clear what a parent run (the pre-push hook, the train) may have set.
      env: {
        ...ENV_BASE, KOOKR_VERIFY_FLAKY_RERUN: '', VITEST_RERUN_SUMMARY_FILE: '',
        PATH: `${bin}:${process.env.PATH ?? ''}`, ...env,
      },
    });
    return {
      status: r.status,
      stdout: r.stdout,
      calls: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
    };
  };
  const flakyLog = join(repo, '.git/kookr-flaky-tests.log');
  return { run, flakyLog };
}

describe('verify.sh flaky re-run (KOOKR_VERIFY_FLAKY_RERUN)', () => {
  it('re-runs the few failed files once; a pass is logged as flaky and verify continues', () => {
    const s = setup(['src/flaky.test.ts']);
    const r = s.run({ KOOKR_VERIFY_FLAKY_RERUN: '1' });
    expect(r.status, r.stdout).toBe(0);
    expect(r.calls).toContain('test | summary=set');
    expect(r.calls).toContain('exec vitest run src/flaky.test.ts | summary=');
    expect(r.calls).toContain('test:integration | summary='); // the lanes after it still ran
    expect(readFileSync(s.flakyLog, 'utf8')).toMatch(/\tsrc\/flaky\.test\.ts\n$/);
  });

  it('fails, and stops, when the re-run fails again', () => {
    const s = setup(['src/broken.test.ts']);
    const r = s.run({ KOOKR_VERIFY_FLAKY_RERUN: '1', RERUN_EXIT: '1' });
    expect(r.status).not.toBe(0);
    // Train mode runs the static checks beside the unit lane (#3794), so their
    // calls interleave; what matters is the re-run happened and nothing after it.
    expect(r.calls).toContain('exec vitest run src/broken.test.ts | summary=');
    expect(r.calls).not.toContain('test:integration | summary=');
    expect(existsSync(s.flakyLog)).toBe(false);
  });

  it('does not re-run when more than five files failed', () => {
    const s = setup(['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `src/${n}.test.ts`));
    const r = s.run({ KOOKR_VERIFY_FLAKY_RERUN: '1' });
    expect(r.status).not.toBe(0);
    expect(r.calls).toContain('test | summary=set');
    expect(r.calls.some((c) => c.startsWith('exec vitest run'))).toBe(false);
    expect(r.calls).not.toContain('test:integration | summary=');
  });

  it('leaves a plain pnpm verify unchanged: one unit run, no summary, no re-run', () => {
    const s = setup(['src/flaky.test.ts']);
    const r = s.run({});
    expect(r.status).not.toBe(0);
    expect(r.calls.at(-1)).toBe('test | summary=');
    expect(r.calls.some((c) => c.startsWith('exec '))).toBe(false);
  });
});
