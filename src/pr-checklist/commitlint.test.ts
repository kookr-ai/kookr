import { describe, expect, it } from 'vitest';
import {
  classifyCommitlintConfig,
  CONVENTIONAL_HEADER_MAX,
  evaluateTitle,
  isDefaultIgnored,
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
  ["fix: ÉLAN thing", false],
  ["fix: élan thing", true],
  ["feat: a `B`", true],
  ["fix: 123", true],
  ["Add scaffold", false],
  ["feat: x\nbody", true],
  ["fix: aPI", true],
  ["fix: Äpfel", false],
  ["revert: \"feat: x\"", true],
  ["feat(): add x", true],
  ["(x): add", false],
  ["feat: wip...", true],
  ["feat: x..", false],
  ["feat: done.", false],
  ["feat(Scope): add x", true],
  ["fix: Über alles", false],
  ["fix: état", true],
  ["Revert \"feat: add x\"", true],
  ["Reapply \"feat: x\"", true],
  ["Merge branch 'main' into feat", true],
  ["Merge pull request #1 from a/b", true],
  ["fixup! feat: x", true],
  ["squash! fix: y", true],
  ["amend! fix: z", true],
  ["v1.2.3", true],
  ["1.2.3", true],
  ["chore: 1.2.3", true],
  ["chore(release): v2.0.0-rc.1", true],
  ["Merged PR 12: thing", true],
  ["Automatic merge from x", true],
  ["WIP draft scaffold", false],
  ["revert: feat: x", true],
  ["feat(api)!: remove legacy endpoints (v1): Clients must migrate", true],
  ["feat(api): remove legacy endpoints (v1): Clients must migrate", false],
  ["feat!: drop node 18", true],
  ["fix(a)!: x (b): y", true],
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
    ['feature: add scaffold', /type before the colon is not one of/],
    ['Feat: add scaffold', /type before the colon must be lower-case/],
    ['feat: Add scaffold', /must not start with a capital/],
    ['feat: ADD SCAFFOLD', /must not start with a capital letter or be all upper-case/],
    ['feat: add scaffold.', /full stop/],
    ['feat: add scaffold ', /leading or trailing whitespace/],
    ['feat:  ', /subject after the colon is empty/],
  ])('names the problem for %j', (title, problem) => {
    expect(lintConventionalTitle(title).join('; ')).toMatch(problem);
  });

  it('splits a breaking-change header the way the conventionalcommits parser does', () => {
    // Greedy `!?` alone would take "api)!: remove legacy endpoints (v1" as the scope.
    expect(lintConventionalTitle('feat(api)!: remove legacy endpoints (v1): Clients must migrate')).toEqual([]);
    expect(lintConventionalTitle('feat(api): remove legacy endpoints (v1): Clients must migrate')).not.toEqual([]);
  });

  it('treats an empty title as not checked', () => {
    expect(evaluateTitle('', { path: 'c', conventional: true, plain: true })).toEqual({ results: [], notes: [] });
  });

  it('does not judge scope case (config-conventional has no scope-case rule)', () => {
    expect(lintConventionalTitle('feat(CLI): add scaffold')).toEqual([]);
  });
});

describe('classifyCommitlintConfig / packageJsonCommitlintText', () => {
  it.each([
    ['module.exports = {\n  extends: ["@commitlint/config-conventional"],\n};\n'],
    ["export default { extends: ['@commitlint/config-conventional'] };"],
    ['{"extends":["@commitlint/config-conventional"]}'],
    ['extends:\n  - "@commitlint/config-conventional"\n'],
    ['// a comment\nmodule.exports = { extends: "@commitlint/config-conventional" } /* x */'],
    [
      "import type { UserConfig } from '@commitlint/types';\nconst Configuration: UserConfig = {\n  extends: ['@commitlint/config-conventional'],\n};\nexport default Configuration;",
    ],
  ])('treats a bare config-conventional extends as plain (enforced): %j', (text) => {
    expect(classifyCommitlintConfig('c', text)).toEqual({ path: 'c', conventional: true, plain: true });
  });

  it.each([
    ['own rules', 'module.exports = { extends: ["@commitlint/config-conventional"], rules: { "subject-case": [0] } };'],
    ['own ignores', 'module.exports = { extends: ["@commitlint/config-conventional"], ignores: [(m) => m.startsWith("WIP")] };'],
    ['a parser preset', 'module.exports = { extends: ["@commitlint/config-conventional"], parserPreset: "./p" };'],
    ['a second preset', 'module.exports = { extends: ["@commitlint/config-conventional", "@commitlint/config-lerna-scopes"] };'],
    ['a computed config', 'const base = require("@commitlint/config-conventional"); module.exports = { ...base };'],
  ])('treats a config-conventional config with %s as customised (not enforced)', (_, text) => {
    expect(classifyCommitlintConfig('c', text)).toMatchObject({ conventional: true, plain: false });
  });

  it('marks another preset as non-conventional', () => {
    expect(classifyCommitlintConfig('.commitlintrc.yml', 'extends:\n  - "@commitlint/config-angular"').conventional).toBe(false);
  });

  it('reads only the commitlint key of package.json, tolerating bad JSON', () => {
    expect(packageJsonCommitlintText('{"name":"x","commitlint":{"extends":["@commitlint/config-conventional"]}}'))
      .toBe('{"extends":["@commitlint/config-conventional"]}');
    expect(packageJsonCommitlintText('{"name":"x"}')).toBeNull();
    expect(packageJsonCommitlintText('{not json')).toBeNull();
  });
});

describe('isDefaultIgnored (commitlint default ignores)', () => {
  it.each(['Revert "feat: add x"', 'Merge branch \'main\' into feat', 'fixup! feat: x', 'v1.2.3', 'chore(release): 2.0.0'])(
    'skips %j, as commitlint does',
    (title) => {
      expect(isDefaultIgnored(title)).toBe(true);
      expect(lintConventionalTitle(title)).toEqual([]);
    },
  );

  it('does not skip an ordinary title', () => {
    expect(isDefaultIgnored('WIP draft scaffold')).toBe(false);
  });
});

describe('evaluateTitle', () => {
  const plain = { path: 'commitlint.config.cjs', conventional: true, plain: true };

  it('is a no-op without a config or without a title', () => {
    expect(evaluateTitle('Add things', null)).toEqual({ results: [], notes: [] });
    expect(evaluateTitle(null, plain)).toEqual({ results: [], notes: [] });
  });

  it('fails a title a plain config-conventional config would reject, naming the config and the fix', () => {
    const { results } = evaluateTitle('Add a scaffold subcommand', plain);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'pr-title', status: 'fail' });
    expect(results[0].summary).toMatch(/commitlint\.config\.cjs, config-conventional/);
    expect(results[0].summary).toMatch(/"type\(scope\): subject"/);
    expect(results[0].summary).not.toContain('Add a scaffold subcommand'); // S6: the title is not echoed
  });

  it('passes a conforming title', () => {
    expect(evaluateTitle('feat(cli): add scaffold', plain).results).toEqual([
      { id: 'pr-title', status: 'pass', summary: 'PR title passes the repo commit-lint rule' },
    ]);
  });

  it('notes (never fails) a config that does not extend config-conventional', () => {
    const r = evaluateTitle('anything at all', { path: '.commitlintrc.js', conventional: false, plain: false });
    expect(r.results).toEqual([]);
    expect(r.notes[0]).toMatch(/does not extend config-conventional — PR title not checked/);
  });

  // The hook must never deny a title the repo's real commitlint may accept.
  it('turns a failure into a note when the config customises config-conventional', () => {
    const r = evaluateTitle('feat: Add OAuth login', { ...plain, plain: false });
    expect(r.results).toEqual([]);
    expect(r.notes[0]).toMatch(/may fail commit-lint .*customises config-conventional, so this is not enforced/);
    expect(evaluateTitle('feat: add x', { ...plain, plain: false }).results[0].status).toBe('pass');
  });
});
