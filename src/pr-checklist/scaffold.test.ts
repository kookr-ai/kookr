import { describe, expect, it } from 'vitest';
import { DECIDE_REASON_PLACEHOLDER, parseChecklist, WAIVER_REASON_PLACEHOLDER } from './checklist.js';
import { verifyChecklist } from './engine.js';
import { scaffoldBody } from './scaffold.js';
import type { DiffFacts } from './types.js';

// A template shaped like the real ones: prose, an unmarked row, rows with an
// evidence rule (tests, docs, readme), and a row with none (npm-test).
const TEMPLATE = [
  '<!-- fill me -->',
  '## Summary',
  '',
  '- [ ] Unmarked row stays as written',
  '- [ ] <!-- kookr:check:tests --> Tests were added or updated',
  '- [ ] <!-- kookr:check:docs --> Docs under `docs/` are consistent — see the guide',
  '  - [ ] <!-- kookr:check:readme --> README reflects user-visible changes',
  '- [ ] <!-- kookr:check:npm-test --> `npm test` passes',
].join('\n');

function facts(changedPaths: string[]): DiffFacts {
  return { changedPaths, addedFiles: [], addedSourceLines: [], addedScannableLines: [], baseUnresolved: false };
}

function verify(body: string, changedPaths: string[]) {
  return verifyChecklist({ body, facts: facts(changedPaths), envFileText: '', testCorpus: '', templateText: TEMPLATE });
}

const fill = (body: string) =>
  body.replaceAll(WAIVER_REASON_PLACEHOLDER, 'not applicable here').replaceAll(DECIDE_REASON_PLACEHOLDER, 'not run');

describe('scaffoldBody', () => {
  const changed = ['src/x.test.ts', 'docs/guide.md'];

  it('ticks rows whose evidence changed, strikes the rest, and sorts out rows with no rule', () => {
    const r = scaffoldBody(TEMPLATE, changed);
    expect(r.checked).toEqual(['tests', 'docs']);
    expect(r.struck).toEqual(['readme']);
    expect(r.undecided).toEqual(['npm-test']);
    const lines = r.body.split('\n');
    expect(lines[4]).toBe('- [x] <!-- kookr:check:tests --> Tests were added or updated');
    expect(lines[5]).toBe('- [x] <!-- kookr:check:docs --> Docs under `docs/` are consistent — see the guide');
    expect(lines[6]).toBe(`  - [ ] ~~<!-- kookr:check:readme --> README reflects user-visible changes~~ — ${WAIVER_REASON_PLACEHOLDER}`);
    expect(lines[7]).toBe(`- [ ] ~~<!-- kookr:check:npm-test --> \`npm test\` passes~~ — ${DECIDE_REASON_PLACEHOLDER}`);
  });

  it('passes every non-marker template line through unchanged', () => {
    const out = scaffoldBody(TEMPLATE, changed).body.split('\n');
    const src = TEMPLATE.split('\n');
    for (const i of [0, 1, 2, 3]) expect(out[i]).toBe(src[i]);
    expect(out).toHaveLength(src.length);
  });

  // Acceptance criterion 1: scaffold output passes verify once the reasons are filled.
  it('passes verify once the reason placeholders are filled', () => {
    const body = fill(scaffoldBody(TEMPLATE, changed).body);
    const report = verify(body, changed);
    expect(report.results.filter((x) => x.status === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.results.map((x) => `${x.id}:${x.status}`)).toEqual([
      'tests:pass', 'docs:pass', 'readme:waived', 'npm-test:waived',
    ]);
  });

  it('fails verify while any placeholder is left in, naming each unfilled row', () => {
    const report = verify(scaffoldBody(TEMPLATE, changed).body, changed);
    expect(report.ok).toBe(false);
    const failed = report.results.filter((x) => x.status === 'fail');
    expect(failed.map((x) => x.id)).toEqual(['readme', 'npm-test']);
    expect(failed[0].summary).toMatch(/scaffold placeholder reason/);
  });

  it('with an empty diff strikes every rule-backed row, and the filled body still passes', () => {
    const r = scaffoldBody(TEMPLATE, []);
    expect(r.checked).toEqual([]);
    expect(r.struck).toEqual(['tests', 'docs', 'readme']);
    expect(verify(fill(r.body), []).ok).toBe(true);
  });

  it('keeps CRLF line endings and reads a row already struck in the template by its label only', () => {
    const template = '- [ ] ~~<!-- pr:readme --> README~~ — template note\r\nplain\r\n';
    const r = scaffoldBody(template, ['README.md']);
    expect(r.body).toBe('- [x] <!-- pr:readme --> README\r\nplain\r\n');
    expect(parseChecklist(r.body)).toEqual([{ id: 'readme', checked: true, struck: false, reason: '' }]);
  });

  it('renders a label-less marker row without a dangling space', () => {
    expect(scaffoldBody('- [ ] <!-- kookr:check:mbse -->', []).body).toBe(
      `- [ ] ~~<!-- kookr:check:mbse -->~~ — ${WAIVER_REASON_PLACEHOLDER}`,
    );
  });

  it('returns a marker-less template unchanged', () => {
    const r = scaffoldBody('## Summary\n- [ ] a plain box', ['README.md']);
    expect(r).toEqual({ body: '## Summary\n- [ ] a plain box', checked: [], struck: [], undecided: [] });
  });
});
