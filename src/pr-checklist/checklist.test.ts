import { describe, expect, it } from 'vitest';
import {
  evaluateAttestation,
  evaluateStructural,
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
