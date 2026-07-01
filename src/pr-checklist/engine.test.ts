import { describe, expect, it } from 'vitest';
import { collectAndVerify, verifyChecklist } from './engine.js';
import type { GitRunner } from './git.js';
import type { DiffFacts } from './types.js';

function facts(overrides: Partial<DiffFacts> = {}): DiffFacts {
  return {
    changedPaths: [],
    addedFiles: [],
    addedSourceLines: [],
    addedScannableLines: [],
    baseUnresolved: false,
    ...overrides,
  };
}

describe('verifyChecklist (pure)', () => {
  it('skips attestation when no body is provided but still runs structural checks', () => {
    const report = verifyChecklist({
      body: null,
      facts: facts({ addedSourceLines: ['x = process.env.NEW'] }),
      envFileText: '',
      testCorpus: '',
    });
    expect(report.bodyChecked).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.results.some((r) => r.id === 'env' && r.status === 'fail')).toBe(true);
  });

  it('passes when every marked box is waived and no structural fault exists', () => {
    const body = ['- [ ] ~~<!-- kookr:check:mbse -->~~ — N/A', '- [x] <!-- kookr:check:readme --> done'].join('\n');
    const report = verifyChecklist({ body, facts: facts({ changedPaths: ['README.md'] }), envFileText: '', testCorpus: '' });
    expect(report.ok).toBe(true);
  });

  it('fails a checked box whose evidence is absent from the diff', () => {
    const body = '- [x] <!-- kookr:check:mbse --> refreshed';
    const report = verifyChecklist({ body, facts: facts({ changedPaths: ['src/x.ts'] }), envFileText: '', testCorpus: '' });
    expect(report.ok).toBe(false);
  });
});

// A fake git runner keyed on the argv it receives.
function fakeGit(map: Record<string, { stdout?: string; exitCode?: number }>): GitRunner {
  return async (args) => {
    const key = args.join(' ');
    const hit = map[key];
    return { stdout: hit?.stdout ?? '', stderr: '', exitCode: hit?.exitCode ?? (hit ? 0 : 1) };
  };
}

describe('collectAndVerify (with injected git + fs)', () => {
  const base = 'BASE';
  const range = 'BASE...HEAD';

  it('reports baseUnresolved as a skip, never a bogus verdict (S2)', async () => {
    const git = fakeGit({}); // every merge-base attempt fails
    const report = await collectAndVerify({ cwd: '/repo', base: 'main', body: null, gitRunner: git });
    expect(report.results.some((r) => r.status === 'skipped')).toBe(true);
    expect(report.ok).toBe(true);
  });

  it('flags a new undocumented env var end-to-end', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: base },
      [`diff --name-status ${range}`]: { stdout: 'M\tsrc/config.ts' },
      [`diff --unified=0 ${range}`]: { stdout: '+++ b/src/config.ts\n+const k = process.env.BRAND_NEW' },
      'ls-files -- .env.example': { stdout: '.env.example' },
    });
    const report = await collectAndVerify({
      cwd: '/repo',
      base: 'main',
      body: null,
      gitRunner: git,
      readFileText: async () => 'EXISTING=1\n',
    });
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.id === 'env')?.summary).toMatch(/BRAND_NEW/);
  });

  it('passes a clean structural diff', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: base },
      [`diff --name-status ${range}`]: { stdout: 'M\tREADME.md' },
      [`diff --unified=0 ${range}`]: { stdout: '+++ b/README.md\n+docs' },
    });
    const report = await collectAndVerify({ cwd: '/repo', base: 'main', body: null, gitRunner: git });
    expect(report.ok).toBe(true);
  });
});
