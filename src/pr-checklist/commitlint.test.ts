import { describe, expect, it } from 'vitest';
import {
  classifyCommitlintConfig,
  CONVENTIONAL_HEADER_MAX,
  evaluateTitle,
  lintConventionalTitle,
  packageJsonCommitlintText,
} from './commitlint.js';

describe('lintConventionalTitle (config-conventional header rules)', () => {
  it.each([
    'feat(cli): add a scaffold subcommand',
    'fix: handle an empty diff',
    'refactor(pr-checklist)!: rename the row renderer',
    'docs: update README examples', // first word not sentence-case
    'chore(deps): bump vitest to 4',
  ])('accepts %s', (title) => {
    expect(lintConventionalTitle(title)).toEqual([]);
  });

  it.each([
    ['Add a scaffold subcommand', /type\(scope\): subject/],
    ['feature: add scaffold', /type "feature" is not one of/],
    ['Feat: add scaffold', /must be lower-case/],
    ['feat(CLI): add scaffold', /scope "CLI" must be lower-case/],
    ['feat: Add scaffold', /must not start with a capital/],
    ['feat: ADD SCAFFOLD', /must not start with a capital/],
    ['feat: add scaffold.', /full stop/],
    ['feat:  ', /subject after the colon is empty/],
    [`feat: ${'a'.repeat(CONVENTIONAL_HEADER_MAX)}`, /characters; the limit is 100/],
  ])('rejects %s', (title, problem) => {
    expect(lintConventionalTitle(title).join('; ')).toMatch(problem);
  });
});

describe('classifyCommitlintConfig / packageJsonCommitlintText', () => {
  it('recognises a config-conventional JS config without evaluating it', () => {
    expect(classifyCommitlintConfig('commitlint.config.cjs', 'module.exports = { extends: ["@commitlint/config-conventional"] };'))
      .toEqual({ path: 'commitlint.config.cjs', conventional: true, customRules: false });
  });

  it('flags custom rules and non-conventional presets', () => {
    expect(classifyCommitlintConfig('.commitlintrc.json', '{"extends":["@commitlint/config-conventional"],"rules":{}}').customRules).toBe(true);
    expect(classifyCommitlintConfig('.commitlintrc.yml', 'extends:\n  - "@commitlint/config-angular"').conventional).toBe(false);
  });

  it('reads only the commitlint key of package.json, tolerating bad JSON', () => {
    expect(packageJsonCommitlintText('{"name":"x","commitlint":{"extends":["@commitlint/config-conventional"]}}'))
      .toBe('{"extends":["@commitlint/config-conventional"]}');
    expect(packageJsonCommitlintText('{"name":"x"}')).toBeNull();
    expect(packageJsonCommitlintText('{not json')).toBeNull();
  });
});

describe('evaluateTitle', () => {
  const conventional = { path: 'commitlint.config.cjs', conventional: true, customRules: false };

  it('is a no-op without a config or without a title', () => {
    expect(evaluateTitle('Add things', null)).toEqual({ results: [], notes: [] });
    expect(evaluateTitle(null, conventional)).toEqual({ results: [], notes: [] });
  });

  it('fails a title the repo commit-lint rule would reject, naming the config and the fix', () => {
    const { results } = evaluateTitle('Add a scaffold subcommand', conventional);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'pr-title', status: 'fail' });
    expect(results[0].summary).toMatch(/commitlint\.config\.cjs, config-conventional/);
    expect(results[0].summary).toMatch(/"type\(scope\): subject"/);
    expect(results[0].summary).not.toContain('Add a scaffold subcommand'); // S6: the title is not echoed
  });

  it('passes a conforming title', () => {
    expect(evaluateTitle('feat(cli): add scaffold', conventional).results).toEqual([
      { id: 'pr-title', status: 'pass', summary: 'PR title passes the repo commit-lint rule' },
    ]);
  });

  it('notes (never fails) a config it cannot evaluate', () => {
    const r = evaluateTitle('anything at all', { path: '.commitlintrc.js', conventional: false, customRules: true });
    expect(r.results).toEqual([]);
    expect(r.notes[0]).toMatch(/does not extend config-conventional — PR title not checked/);
  });

  it('checks against the defaults and says so when the config adds rules', () => {
    const r = evaluateTitle('feat: add x', { ...conventional, customRules: true });
    expect(r.results[0].status).toBe('pass');
    expect(r.notes[0]).toMatch(/custom rules; .*defaults only/);
  });
});
