import { describe, expect, it } from 'vitest';
import {
  evaluateAttestation,
  evaluateStructural,
  evaluateTemplatePresence,
  findMissingEnv,
  findUnparsedMarkerIds,
  findUntested,
  hasEvidence,
  isSourceFile,
  isTestFile,
  parseChecklist,
  parseEnvKeys,
  parseTemplateRows,
  renderRow,
  scanSecrets,
  testGlobToRegExp,
  WAIVER_REASON_PLACEHOLDER,
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

  // #3735: a row struck from the leading dash keeps its marker but is not a
  // parseable row; it must read as malformed, not as an omitted template item.
  it('reports a marker on an unparseable line as a malformed row, not an omission', () => {
    const body = [
      '- ~~- [ ] <!-- kookr:check:readme --> README~~ — N/A',
      '- ~~- [ ] <!-- pr:tests --> tests~~ — N/A',
    ].join('\n');
    const rows = parseChecklist(body);
    expect(rows).toHaveLength(0);
    const results = evaluateTemplatePresence(template, rows, findUnparsedMarkerIds(body, rows));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'pr-template', status: 'fail' });
    expect(results[0].summary).toMatch(/2 template checklist row\(s\) \(readme, tests\) present but not in a recognised/);
    expect(results[0].expected).toEqual([
      '- [x] <!-- kookr:check:readme --> README',
      '- [ ] ~~<!-- kookr:check:readme --> README~~ — TODO: one-line reason',
      '- [x] <!-- pr:tests --> tests',
      '- [ ] ~~<!-- pr:tests --> tests~~ — TODO: one-line reason',
    ]);
    expect(results[0].summary).not.toMatch(/omits/);
  });

  it('splits malformed rows from genuinely omitted ones', () => {
    const body = '- ~~- [ ] <!-- kookr:check:readme --> README~~ — N/A';
    const rows = parseChecklist(body);
    const results = evaluateTemplatePresence(template, rows, findUnparsedMarkerIds(body, rows));
    expect(results).toHaveLength(2);
    expect(results[0].summary).toMatch(/\(readme\) present but/);
    expect(results[1].summary).toMatch(/omits 1 of 2 .*\(tests\)/);
  });

  it('ignores markers quoted in prose, so a template-less body still reads as omitted', () => {
    const body = 'Fixes how `- [ ] <!-- kookr:check:readme -->` rows parse.\n\nSee <!-- pr:tests --> too.';
    const rows = parseChecklist(body);
    expect(findUnparsedMarkerIds(body, rows)).toEqual([]);
    const results = evaluateTemplatePresence(template, rows, findUnparsedMarkerIds(body, rows));
    expect(results).toHaveLength(1);
    expect(results[0].summary).toMatch(/omits 2 of 2/);
  });

  it('treats a marker on another bullet style as a malformed row', () => {
    const body = ['* [ ] <!-- kookr:check:readme --> README', '1. [x] <!-- pr:tests --> tests'].join('\n');
    const rows = parseChecklist(body);
    expect(findUnparsedMarkerIds(body, rows)).toEqual(['readme', 'tests']);
  });

  it('still accepts the existing struck forms (box first, with or without x, or strike before the dash)', () => {
    const template3 = `${template}\n- [ ] <!-- kookr:check:docs --> docs`;
    const body = [
      '- [ ] ~~<!-- kookr:check:readme --> README~~ — N/A',
      '- [x] ~~<!-- pr:tests --> tests~~ — N/A',
      '~~- [ ] <!-- kookr:check:docs --> docs~~ — N/A',
    ].join('\n');
    const rows = parseChecklist(body);
    expect(rows.map((r) => r.id)).toEqual(['readme', 'tests', 'docs']);
    expect(findUnparsedMarkerIds(body, rows)).toEqual([]);
    expect(evaluateTemplatePresence(template3, rows, findUnparsedMarkerIds(body, rows))).toHaveLength(0);
  });
});

// #3651: when verify rejects a row it prints the exact line it would accept,
// rendered from the template row, so nobody has to remember the syntax.
describe('expected lines on a rejected row (#3651)', () => {
  const template = [
    '- [ ] <!-- kookr:check:mbse --> System design documents are up to date',
    '- [ ] <!-- kookr:check:tests --> Tests added',
  ].join('\n');
  const mbseWaive = '- [ ] ~~<!-- kookr:check:mbse --> System design documents are up to date~~ — TODO: one-line reason';
  const mbseTick = '- [x] <!-- kookr:check:mbse --> System design documents are up to date';

  it('a struck row with the checkbox inside the strikethrough shows the accepted form', () => {
    const body = [
      '- ~~[ ] <!-- kookr:check:mbse --> System design documents are up to date~~ — CLI-only change',
      '- [x] <!-- kookr:check:tests --> Tests added',
    ].join('\n');
    const rows = parseChecklist(body);
    expect(rows.map((r) => r.id)).toEqual(['tests']); // the box-inside-strike row does not parse
    const results = evaluateTemplatePresence(template, rows, findUnparsedMarkerIds(body, rows));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'pr-template', status: 'fail' });
    expect(results[0].summary).toMatch(/checkbox inside the strikethrough/);
    expect(results[0].expected).toEqual([mbseTick, mbseWaive]);
    // The accepted form really is accepted once its reason slot is filled.
    expect(parseChecklist(mbseWaive.replace('TODO: one-line reason', 'CLI-only change'))).toEqual([
      { id: 'mbse', checked: false, struck: true, reason: 'CLI-only change' },
    ]);
  });

  it('a reason written inside the strikethrough fails with the line that puts it after the closing ~~', () => {
    const rows = parseChecklist('- [ ] ~~<!-- kookr:check:mbse --> System design — N/A, CLI only~~');
    const { results } = evaluateAttestation(rows, [], template);
    expect(results[0].status).toBe('fail');
    expect(results[0].summary).toMatch(/after the closing ~~/);
    expect(results[0].expected).toEqual([mbseWaive]);
  });

  it('a blank row shows both accepted forms; a ticked row with no evidence shows the waiver form', () => {
    const blank = evaluateAttestation(parseChecklist('- [ ] <!-- kookr:check:mbse --> x'), [], template);
    expect(blank.results[0].expected).toEqual([mbseTick, mbseWaive]);
    const unbacked = evaluateAttestation(parseChecklist('- [x] <!-- kookr:check:mbse --> x'), ['src/a.ts'], template);
    expect(unbacked.results[0].expected).toEqual([mbseWaive]);
  });

  it('rejects an unreplaced scaffold placeholder reason', () => {
    const rows = parseChecklist(`- [ ] ~~<!-- kookr:check:mbse --> x~~ — ${WAIVER_REASON_PLACEHOLDER}`);
    const { results, waived } = evaluateAttestation(rows, [], template);
    expect(results[0]).toMatchObject({ id: 'mbse', status: 'fail' });
    expect(results[0].summary).toMatch(/scaffold placeholder/);
    expect(waived.has('mbse')).toBe(false);
  });

  it('a verify-suggested line pasted unchanged still fails (its reason slot is a placeholder)', () => {
    const blank = evaluateAttestation(parseChecklist('- [ ] <!-- kookr:check:mbse --> x'), [], template);
    const pasted = blank.results[0].expected![1];
    const { results } = evaluateAttestation(parseChecklist(pasted), [], template);
    expect(results[0]).toMatchObject({ id: 'mbse', status: 'fail' });
  });

  it('quotes an indented template row without its indent, and the first of duplicate ids', () => {
    const tpl = '  - [ ] <!-- kookr:check:mbse --> first\n- [ ] <!-- kookr:check:mbse --> second';
    const { results } = evaluateAttestation(parseChecklist('- [ ] <!-- kookr:check:mbse --> x'), [], tpl);
    expect(results[0].expected).toEqual([
      '- [x] <!-- kookr:check:mbse --> first',
      '- [ ] ~~<!-- kookr:check:mbse --> first~~ — TODO: one-line reason',
    ]);
  });

  it('falls back to a bare marker line when the template lacks the row', () => {
    const { results } = evaluateAttestation(parseChecklist('- [ ] <!-- kookr:check:docs --> x'), []);
    expect(results[0].expected).toEqual([
      '- [x] <!-- kookr:check:docs --> <row text>',
      '- [ ] ~~<!-- kookr:check:docs --> <row text>~~ — TODO: one-line reason',
    ]);
  });

  it('parseTemplateRows + renderRow round-trip through parseChecklist for both states', () => {
    const [row] = parseTemplateRows('  - [ ] <!-- kookr:check:readme --> README `x`  ');
    expect(row).toEqual({ line: 0, indent: '  ', id: 'readme', marker: '<!-- kookr:check:readme -->', label: 'README `x`' });
    expect(parseChecklist(renderRow(row, 'checked'))).toEqual([{ id: 'readme', checked: true, struck: false, reason: '' }]);
    expect(parseChecklist(renderRow(row, 'waived', 'no README change'))).toEqual([
      { id: 'readme', checked: false, struck: true, reason: 'no README change' },
    ]);
  });
});

describe('isTestFile / tests evidence (#4226)', () => {
  it('counts shell tests, JS/TS tests and test directories, but not product source', () => {
    expect(isTestFile('.claude/hooks-tests/bash-wait-nudge.test.sh')).toBe(true);
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('test/helpers.ts')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('scripts/run-tests.sh')).toBe(false);
    expect(hasEvidence('tests', ['.claude/hooks-tests/x.test.sh'])).toBe(true);
    expect(hasEvidence('new-tests', ['.claude/hooks-tests/x.test.sh'])).toBe(true);
  });
});

describe('testGlobToRegExp / declared test globs (#4257)', () => {
  const m = (glob: string, path: string) => testGlobToRegExp(glob).test(path);

  it('a glob with no slash matches the file name in any directory; * stays inside one segment', () => {
    expect(m('*.check.ts', 'src/a/b.check.ts')).toBe(true);
    expect(m('*.check.ts', 'b.check.ts')).toBe(true);
    expect(m('*.check.ts', 'src/a/b.check.tsx')).toBe(false);
    expect(m('*.check.ts', 'src/a.check.ts/x.ts')).toBe(false);
  });

  it('a glob with a slash is anchored at the repo root', () => {
    expect(m('checks/*.sh', 'checks/run.sh')).toBe(true);
    expect(m('checks/*.sh', 'sub/checks/run.sh')).toBe(false);
    expect(m('checks/*.sh', 'checks/deep/run.sh')).toBe(false);
  });

  it('** spans any number of segments, including none; a trailing / means the whole directory', () => {
    expect(m('src/**/fixtures/*.sh', 'src/fixtures/a.sh')).toBe(true);
    expect(m('src/**/fixtures/*.sh', 'src/x/y/fixtures/a.sh')).toBe(true);
    expect(m('qa/**', 'qa/a/b/c.ts')).toBe(true);
    expect(m('qa/', 'qa/a/b/c.ts')).toBe(true);
    expect(m('qa/', 'qaz/c.ts')).toBe(false);
  });

  it('? is one character other than /, and regex metacharacters are literal', () => {
    expect(m('t?.sh', 'dir/t1.sh')).toBe(true);
    expect(m('t?.sh', 'dir/t12.sh')).toBe(false);
    expect(m('a.b+(c)', 'a.b+(c)')).toBe(true);
    expect(m('a.b+(c)', 'aXb+(c)')).toBe(false);
    expect(m('a.b+(c)', 'a.bb(c)')).toBe(false);
    expect(m('$x^', 'd/$x^')).toBe(true);
  });

  it('declared patterns add to the built-in test detection, never replace it', () => {
    const extra = [testGlobToRegExp('*.check.ts')];
    expect(isTestFile('src/a.check.ts', extra)).toBe(true);
    expect(isTestFile('src/a.check.ts')).toBe(false);
    expect(isTestFile('src/a.test.ts', extra)).toBe(true);
    expect(isTestFile('src/a.ts', extra)).toBe(false);
  });

  it('only the tests / new-tests rows take declared globs as evidence', () => {
    const extra = [testGlobToRegExp('checks/')];
    expect(hasEvidence('tests', ['checks/run.sh'], extra)).toBe(true);
    expect(hasEvidence('new-tests', ['checks/run.sh'], extra)).toBe(true);
    expect(hasEvidence('tests', ['checks/run.sh'])).toBe(false);
    expect(hasEvidence('integration-tests', ['checks/run.sh'], extra)).toBe(false);
    expect(hasEvidence('docs', ['checks/run.sh'], extra)).toBe(false);
    const rows = parseChecklist('- [x] <!-- kookr:check:tests --> tests');
    expect(evaluateAttestation(rows, ['checks/run.sh'], '', extra).results[0].status).toBe('pass');
    expect(evaluateAttestation(rows, ['checks/run.sh']).results[0].status).toBe('fail');
  });

  it('a file a declared glob names as a test is not a source file', () => {
    const extra = [testGlobToRegExp('*.check.ts')];
    expect(isSourceFile('src/a.check.ts')).toBe(true);
    expect(isSourceFile('src/a.check.ts', extra)).toBe(false);
    expect(isSourceFile('src/a.ts', extra)).toBe(true);
  });
});
