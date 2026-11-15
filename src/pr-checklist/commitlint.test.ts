import { describe, expect, it } from 'vitest';
import {
  classifyCommitlintConfig,
  CONVENTIONAL_HEADER_MAX,
  evaluateTitle,
  lintConventionalTitle,
  packageJsonCommitlintText,
} from './commitlint.js';

// Verdicts from real commitlint (@commitlint/cli 21 with config-conventional,
// loaded through @commitlint/load so the conventionalcommits parser preset
// applies) on 2026-11-15. The local re-implementation must agree on every one.
const COMMITLINT_ORACLE: [string, boolean][] = [
  ["fix(cli): README typo", false],
  ["feat: API key rotation", false],
  ["fix: GitHub token refresh", false],
  ["fix: 2FA", true],
  ["fix: `ABC` X", true],
  ["feat: add x ", false],
  ["  feat: add x", false],
  ["feat: Add x", false],
  ["fix(ui): iOS crash", true],
  ["chore: v2 bump", true],
  ["feat(cli): add scaffold", true],
  ["feat(CLI): add scaffold", true],
  ["Feat: add x", false],
  ["feature: add x", false],
  ["feat: ADD X", false],
  ["feat: add x.", false],
  ["feat:  ", false],
  ["feat: ", false],
  ["feat:add", false],
  ["feat(a,b)!: add x", true],
  ["fix: \"Foo\" bar", true],
  ["fix: \u00c9LAN thing", false],
  ["fix: \u00e9lan thing", true],
  ["feat: a `B`", true],
  ["fix: 123", true],
  ["Add scaffold", false],
  ["feat: x\nbody", true],
  ["fix: aPI", true],
  ["fix: \u00c4pfel", false],
  ["revert: \"feat: x\"", true],
  ["feat(): add x", true],
  ["(x): add", false],
];

describe('lintConventionalTitle (config-conventional header rules)', () => {
  it.each(COMMITLINT_ORACLE)('agrees with real commitlint on %j (valid: %s)', (title, valid) => {
    expect(lintConventionalTitle(title)).toEqual(valid ? [] : expect.arrayContaining([expect.any(String)]));
  });

  it('pins the header-length boundary at exactly 100 characters', () => {
    const at = (n: number) => `feat: ${'a'.repeat(n - 'feat: '.length)}`;
    expect(lintConventionalTitle(at(CONVENTIONAL_HEADER_MAX))).toEqual([]);
    expect(lintConventionalTitle(at(CONVENTIONAL_HEADER_MAX + 1))).toEqual(['it is 101 characters; the limit is 100']);
  });

  it.each([
    ['Add a scaffold subcommand', /type\(scope\): subject/],
    ['feature: add scaffold', /type "feature" is not one of/],
    ['Feat: add scaffold', /type "Feat" must be lower-case/],
    ['feat: Add scaffold', /must not start with a capital/],
    ['feat: ADD SCAFFOLD', /must not start with a capital letter or be all upper-case/],
    ['feat: add scaffold.', /full stop/],
    ['feat: add scaffold ', /leading or trailing whitespace/],
    ['feat:  ', /subject after the colon is empty/],
  ])('names the problem for %j', (title, problem) => {
    expect(lintConventionalTitle(title).join('; ')).toMatch(problem);
  });

  it('does not judge scope case (config-conventional has no scope-case rule)', () => {
    expect(lintConventionalTitle('feat(CLI): add scaffold')).toEqual([]);
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
