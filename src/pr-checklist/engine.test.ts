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
      templateText: '',
    });
    expect(report.bodyChecked).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.results.some((r) => r.id === 'env' && r.status === 'fail')).toBe(true);
  });

  it('passes when every marked box is waived and no structural fault exists', () => {
    const body = ['- [ ] ~~<!-- kookr:check:mbse -->~~ — N/A', '- [x] <!-- kookr:check:readme --> done'].join('\n');
    const report = verifyChecklist({ body, facts: facts({ changedPaths: ['README.md'] }), envFileText: '', testCorpus: '', templateText: '' });
    expect(report.ok).toBe(true);
  });

  it('fails a checked box whose evidence is absent from the diff', () => {
    const body = '- [x] <!-- kookr:check:mbse --> refreshed';
    const report = verifyChecklist({ body, facts: facts({ changedPaths: ['src/x.ts'] }), envFileText: '', testCorpus: '', templateText: '' });
    expect(report.ok).toBe(false);
  });

  it('fails when an inline body drops the template checklist entirely (the #835 bypass)', () => {
    const template = ['- [ ] <!-- kookr:check:readme --> README', '- [ ] <!-- kookr:check:tests --> tests'].join('\n');
    const report = verifyChecklist({
      body: 'Summary only — no checklist markers at all.',
      facts: facts({ changedPaths: ['src/x.ts'] }),
      envFileText: '',
      testCorpus: '',
      templateText: template,
    });
    const presence = report.results.find((r) => r.id === 'pr-template');
    expect(presence?.status).toBe('fail');
    expect(presence?.summary).toMatch(/readme/);
    expect(presence?.summary).toMatch(/tests/);
    expect(report.ok).toBe(false);
  });

  it('passes template presence when the body reproduces every template marker (struck counts as present)', () => {
    const template = ['- [ ] <!-- kookr:check:readme --> README', '- [ ] <!-- kookr:check:mbse --> arch'].join('\n');
    const body = [
      '- [x] <!-- kookr:check:readme --> done',
      '- [ ] ~~<!-- kookr:check:mbse -->~~ — N/A',
    ].join('\n');
    const report = verifyChecklist({
      body,
      facts: facts({ changedPaths: ['README.md'] }),
      envFileText: '',
      testCorpus: '',
      templateText: template,
    });
    expect(report.results.some((r) => r.id === 'pr-template')).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('does not enforce presence when no body was provided (CI stays authoritative)', () => {
    const template = '- [ ] <!-- kookr:check:readme --> README';
    const report = verifyChecklist({ body: null, facts: facts(), envFileText: '', testCorpus: '', templateText: template });
    expect(report.results.some((r) => r.id === 'pr-template')).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('P4a: a disabled rule id drops its results and turns a fail into a pass (repo relaxing its own gate)', () => {
    const base = {
      body: null,
      facts: facts({ addedSourceLines: ['x = process.env.NEW'], addedFiles: ['src/orphan.ts'] }),
      envFileText: '',
      testCorpus: '',
      templateText: '',
    };
    // Without config: env (+ new-tests) fail.
    const before = verifyChecklist(base);
    expect(before.ok).toBe(false);
    expect(before.results.some((r) => r.id === 'env' && r.status === 'fail')).toBe(true);

    // Disabling env drops the env result; new-tests still fails.
    const partial = verifyChecklist({ ...base, disabled: new Set(['env']) });
    expect(partial.results.some((r) => r.id === 'env')).toBe(false);
    expect(partial.results.some((r) => r.id === 'new-tests' && r.status === 'fail')).toBe(true);
    expect(partial.ok).toBe(false);
    expect(partial.notes.join(' ')).toMatch(/rule "env" disabled/);

    // Disabling both → clean pass.
    const both = verifyChecklist({ ...base, disabled: new Set(['env', 'new-tests']) });
    expect(both.ok).toBe(true);
    expect(both.results.some((r) => r.id === 'env' || r.id === 'new-tests')).toBe(false);
  });

  it('P4a: disabling a rule that never fired adds no spurious note', () => {
    const report = verifyChecklist({
      body: null,
      facts: facts({ changedPaths: ['README.md'] }),
      envFileText: '',
      testCorpus: '',
      templateText: '',
      disabled: new Set(['env']),
    });
    expect(report.notes.join(' ')).not.toMatch(/disabled/);
    expect(report.ok).toBe(true);
  });

  it('P4a: config parse notes surface in the report', () => {
    const report = verifyChecklist({
      body: null,
      facts: facts(),
      envFileText: '',
      testCorpus: '',
      templateText: '',
      configNotes: ['.kookr/pr-checklist.json: unknown key "command" ignored'],
    });
    expect(report.notes.join(' ')).toMatch(/unknown key "command"/);
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

  it('reads the repo PR template and fails an inline body that dropped it (end-to-end)', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: base },
      [`diff --name-status ${range}`]: { stdout: 'M\tsrc/x.ts' },
      [`diff --unified=0 ${range}`]: { stdout: '+++ b/src/x.ts\n+const y = 1' },
      'ls-files -- .github/PULL_REQUEST_TEMPLATE.md': { stdout: '.github/PULL_REQUEST_TEMPLATE.md' },
    });
    const report = await collectAndVerify({
      cwd: '/repo',
      base: 'main',
      body: 'Just a summary, no checklist.',
      gitRunner: git,
      readFileText: async () => '- [ ] <!-- kookr:check:readme --> README\n- [ ] <!-- kookr:check:tests --> tests\n',
    });
    expect(report.results.find((r) => r.id === 'pr-template')?.status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('no-ops the presence rule when the repo ships no PR template', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: base },
      [`diff --name-status ${range}`]: { stdout: 'M\tREADME.md' },
      [`diff --unified=0 ${range}`]: { stdout: '+++ b/README.md\n+docs' },
      // no ls-files entry for any template path → readTracked returns ''
    });
    const report = await collectAndVerify({
      cwd: '/repo',
      base: 'main',
      body: 'Summary with no markers.',
      gitRunner: git,
    });
    expect(report.results.some((r) => r.id === 'pr-template')).toBe(false);
    expect(report.ok).toBe(true);
  });

  it('P4a: reads .kookr/pr-checklist.json and honors { disable: ["env"] } end-to-end', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: base },
      [`diff --name-status ${range}`]: { stdout: 'M\tsrc/config.ts' },
      [`diff --unified=0 ${range}`]: { stdout: '+++ b/src/config.ts\n+const k = process.env.KB_BRAND_NEW' },
      'ls-files -- .env.example': { stdout: '' }, // no env file → env rule would fail...
      'ls-files -- .kookr/pr-checklist.json': { stdout: '.kookr/pr-checklist.json' },
    });
    const report = await collectAndVerify({
      cwd: '/repo',
      base: 'main',
      body: null,
      gitRunner: git,
      readFileText: async (p) => (p.endsWith('.kookr/pr-checklist.json') ? '{ "disable": ["env"] }' : ''),
    });
    // ...but the repo disabled it, so no env fail and the note explains why.
    expect(report.results.some((r) => r.id === 'env')).toBe(false);
    expect(report.notes.join(' ')).toMatch(/rule "env" disabled/);
    expect(report.ok).toBe(true);
  });
});
