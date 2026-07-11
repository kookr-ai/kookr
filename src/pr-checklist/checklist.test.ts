import { describe, expect, it } from 'vitest';
import {
  evaluateAttestation,
  evaluateStructural,
  evaluateTemplatePresence,
  findMissingEnv,
  findUntested,
  isSourceFile,
  parseChecklist,
  parseEnvKeys,
  scanSecrets,
} from './checklist.js';
import type { DiffFacts } from './types.js';

const AWS_KEY = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join(''); // split so this file isn't itself flagged

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

describe('parseChecklist', () => {
  it('reads checkbox state and strike-through, for both marker prefixes', () => {
    const body = [
      '- [ ] <!-- kookr:check:env --> .env.example updated',
      '- [x] <!-- pr:readme --> README updated',
      '- [ ] ~~<!-- kookr:check:mbse --> MBSE~~ — N/A, docs-only',
      '- [x] no marker here',
    ].join('\n');
    const rows = parseChecklist(body);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === 'env')).toMatchObject({ checked: false, struck: false });
    expect(rows.find((r) => r.id === 'readme')?.checked).toBe(true);
    const mbse = rows.find((r) => r.id === 'mbse');
    expect(mbse?.struck).toBe(true);
    expect(mbse?.reason).toMatch(/N\/A, docs-only/);
  });

  it('is stateless across calls (shared /g regex)', () => {
    const body = '- [x] <!-- kookr:check:env --> x';
    expect(parseChecklist(body)).toHaveLength(1);
    expect(parseChecklist(body)).toHaveLength(1);
  });

  it('does not mistake a struck checklist label for a waiver reason', () => {
    const withoutReason = parseChecklist(
      '~~- [ ] <!-- kookr:check:tests --> Tests were added or updated~~',
    )[0];
    expect(withoutReason).toMatchObject({ struck: true, reason: '' });

    const withReason = parseChecklist(
      '~~- [ ] <!-- kookr:check:tests --> Tests were added or updated~~ — docs-only change',
    )[0];
    expect(withReason).toMatchObject({ struck: true, reason: 'docs-only change' });
  });
});

describe('evaluateAttestation', () => {
  it('fails a checked box with no matching diff', () => {
    const { results } = evaluateAttestation(
      [{ id: 'readme', checked: true, struck: false, reason: '' }],
      ['src/foo.ts'],
    );
    expect(results[0]).toMatchObject({ id: 'readme', status: 'fail' });
  });

  it('passes a checked box backed by a real change', () => {
    const { results } = evaluateAttestation(
      [{ id: 'readme', checked: true, struck: false, reason: '' }],
      ['README.md'],
    );
    expect(results[0].status).toBe('pass');
  });

  it('fails a blank marked box', () => {
    const { results } = evaluateAttestation(
      [{ id: 'env', checked: false, struck: false, reason: '' }],
      [],
    );
    expect(results[0].status).toBe('fail');
  });

  it('waives a struck box and records the reason', () => {
    const { results, waived } = evaluateAttestation(
      [{ id: 'mbse', checked: false, struck: true, reason: 'N/A, docs-only' }],
      [],
    );
    expect(results[0]).toMatchObject({ status: 'waived', reason: 'N/A, docs-only' });
    expect(waived.has('mbse')).toBe(true);
  });

  it('rejects a struck box without a waiver reason', () => {
    const { results, waived } = evaluateAttestation(
      [{ id: 'docs', checked: false, struck: true, reason: '' }],
      [],
    );
    expect(results[0]).toMatchObject({ id: 'docs', status: 'fail' });
    expect(results[0].summary).toMatch(/waiver reason/);
    expect(waived.has('docs')).toBe(false);
  });

  it.each([
    ['tests', 'src/core/example.test.ts'],
    ['tests', 'src/core/example.spec.tsx'],
    ['new-tests', 'test/example.test.ts'],
    ['integration-tests', 'tests/integration/example.test.ts'],
    ['e2e-tests', 'tests/e2e/example.spec.ts'],
    ['docs', 'docs/operations/local-services.md'],
    ['mbse', 'docs/rfc/legacy-contract.md'],
    ['mbse', 'docs/rfcs/021-contextual-prefaces.md'],
    ['mbse', 'docs/adr/004-index-layout.md'],
    ['mbse', 'docs/system-models/runtime.md'],
    ['changelog', 'CHANGELOG.md'],
    ['benchmarks', 'benchmark/smoke.ts'],
    ['benchmarks', 'benchmarks/compare/model-quality.test.ts'],
  ])('accepts conventional %s evidence at %s', (id, changedPath) => {
    const { results } = evaluateAttestation([{ id, checked: true, struck: false, reason: '' }], [changedPath]);
    expect(results[0]).toMatchObject({ id, status: 'pass' });
  });

  it.each(['changelog', 'benchmarks'])('rejects checked %s without matching evidence', (id) => {
    const { results } = evaluateAttestation([{ id, checked: true, struck: false, reason: '' }], ['src/index.ts']);
    expect(results[0]).toMatchObject({ id, status: 'fail' });
  });

  it.each([
    ['docs', 'README.md'],
    ['mbse', 'docs/operations/local-services.md'],
    ['tests', 'src/core/example.ts'],
    ['integration-tests', 'src/core/example.test.ts'],
    ['e2e-tests', 'src/core/example.spec.ts'],
  ])('rejects %s evidence from a non-matching path %s', (id, changedPath) => {
    const { results } = evaluateAttestation([{ id, checked: true, struck: false, reason: '' }], [changedPath]);
    expect(results[0]).toMatchObject({ id, status: 'fail' });
  });

  it('treats an unknown checked id as a bare attestation (pass) and notes it', () => {
    const { results, notes } = evaluateAttestation(
      [{ id: 'custom-thing', checked: true, struck: false, reason: '' }],
      [],
    );
    expect(results[0].status).toBe('pass');
    expect(notes.join(' ')).toMatch(/unknown checklist id/);
  });
});

describe('structural helpers', () => {
  it('parseEnvKeys + findMissingEnv flag undocumented env vars', () => {
    const keys = parseEnvKeys('# comment\nFOO=1\nBAR=\nnot_a_key: x');
    expect(keys).toEqual(['FOO', 'BAR']);
    expect(findMissingEnv(['const a = process.env.FOO', 'const b = process.env.NEW_VAR'], keys)).toEqual(['NEW_VAR']);
  });

  it('findUntested flags new modules absent from the test corpus', () => {
    const corpus = "import { a } from '../covered.js'\n";
    expect(findUntested(['src/covered.ts', 'src/orphan.ts'], corpus)).toEqual(['src/orphan.ts']);
  });

  it('isSourceFile excludes tests and __tests__', () => {
    expect(isSourceFile('src/a.ts')).toBe(true);
    expect(isSourceFile('src/a.test.ts')).toBe(false);
    expect(isSourceFile('src/__tests__/a.ts')).toBe(false);
    expect(isSourceFile('docs/a.md')).toBe(false);
  });

  it('scanSecrets catches a key by location only and honors the allowlist pragma (S6)', () => {
    expect(scanSecrets([{ file: 'src/a.ts', text: 'const x = 1' }])).toBeNull();
    const hit = scanSecrets([{ file: 'src/a.ts', text: `const k = "${AWS_KEY}"` }]);
    expect(hit).toMatchObject({ file: 'src/a.ts' });
    expect(JSON.stringify(hit)).not.toContain(AWS_KEY); // never echoes the value
    expect(scanSecrets([{ file: 'x', text: `k="${AWS_KEY}" // pragma: allowlist secret` }])).toBeNull();
  });
});

describe('evaluateStructural', () => {
  it('skips (not fails) when the diff base is unresolved (S2)', () => {
    const results = evaluateStructural(facts({ baseUnresolved: true }), '', '', new Set());
    expect(results[0].status).toBe('skipped');
  });

  it('fails on a new undocumented env var, unless the env box is waived', () => {
    const f = facts({ addedSourceLines: ['x = process.env.NEW_ONE'] });
    expect(evaluateStructural(f, 'OLD=1', '', new Set())[0]).toMatchObject({ id: 'env', status: 'fail' });
    expect(evaluateStructural(f, 'OLD=1', '', new Set(['env']))).toHaveLength(0);
  });

  it('fails on a new untested source module, unless a test box is waived', () => {
    const f = facts({ addedFiles: ['src/orphan.ts'] });
    expect(evaluateStructural(f, '', 'nothing here', new Set())[0]).toMatchObject({ id: 'new-tests', status: 'fail' });
    expect(evaluateStructural(f, '', 'nothing here', new Set(['new-tests']))).toHaveLength(0);
  });
});

describe('evaluateTemplatePresence', () => {
  const template = ['- [ ] <!-- kookr:check:readme --> README', '- [ ] <!-- pr:tests --> tests'].join('\n');

  it('no-ops when the repo ships no template (or one with no markers)', () => {
    expect(evaluateTemplatePresence('', parseChecklist('- [x] <!-- pr:readme --> x'))).toHaveLength(0);
    expect(evaluateTemplatePresence('# Just prose, no markers', [])).toHaveLength(0);
  });

  it('fails, listing every template id the body omits', () => {
    const results = evaluateTemplatePresence(template, parseChecklist('Summary only, no checklist.'));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'pr-template', status: 'fail' });
    expect(results[0].summary).toMatch(/readme/);
    expect(results[0].summary).toMatch(/tests/);
    expect(results[0].summary).toMatch(/2 of 2/);
  });

  it('passes when the body reproduces every marker regardless of checked/struck state', () => {
    const body = ['- [x] <!-- pr:readme --> done', '- [ ] ~~<!-- pr:tests -->~~ — N/A'].join('\n');
    expect(evaluateTemplatePresence(template, parseChecklist(body))).toHaveLength(0);
  });

  it('fails when only some template markers are present', () => {
    const results = evaluateTemplatePresence(template, parseChecklist('- [x] <!-- pr:readme --> done'));
    expect(results[0].status).toBe('fail');
    expect(results[0].summary).toMatch(/tests/);
    expect(results[0].summary).not.toMatch(/readme/); // readme is present, only the missing one is listed
  });
});
