// PR Checklist Contract — PR-title commit-lint check (#3651).
//
// Repos that squash-merge often lint the PR title as the future commit message
// (commitlint with `@commitlint/config-conventional`). An agent finds out only
// when that CI check goes red. This module reports the same failure up front.
//
// S1: the repo's commitlint config is never executed (it may be JS). We only
// look at its text: a config that extends `config-conventional` gets the
// preset's header rules re-implemented below; any other config is reported as
// "not checked". Only a config that is exactly `extends: [config-conventional]`
// can fail the gate; any customisation (rules, ignores, parser preset, more
// presets) could change the verdict, so a failure there is only a note. For the
// plain preset it reports what commitlint reports, default ignores included
// (see commitlint.test.ts's oracle corpus).
// Pure: strings in, data out. The tracked-file reads live in engine.ts.

import type { CheckResult } from './types.js';

/**
 * Commitlint config file names in @commitlint/load's own search order (its
 * cosmiconfig `searchPlaces`), after `package.json` and `package.yaml`, which
 * come first and count only when they carry a `commitlint` key (engine.ts).
 */
export const COMMITLINT_CONFIG_PATHS = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  '.commitlintrc.ts',
  '.commitlintrc.cts',
  '.commitlintrc.mts',
  'commitlint.config.ts',
  'commitlint.config.cts',
  'commitlint.config.mts',
];

/** What the engine found about the repo's commit-lint setup. */
export interface CommitlintConfig {
  /** Repo-relative file the config came from (`package.json` for the `commitlint` key). */
  path: string;
  /** The config mentions `@commitlint/config-conventional`, so its header rules are a fair guide. */
  conventional: boolean;
  /**
   * The config is ONLY `extends: ['@commitlint/config-conventional']` (one of
   * the recognised plain shapes). Only then do this module's rules equal the
   * repo's verdict, so only then can a failing title fail the gate. Anything
   * else (own `rules`, `ignores`, a parser preset, more presets, computed
   * config) could change the verdict either way; a failure is then a note.
   */
  plain: boolean;
}

const PRESET = '"@commitlint/config-conventional"';
const EXTENDS = `"?extends"?:(?:\\[${PRESET}\\]|${PRESET})`;
/** Plain shapes, matched against the normalised text (see `normaliseConfig`). */
const PLAIN_SHAPES = [
  new RegExp(`^(?:module\\.exports=|exportdefault)\\{${EXTENDS}\\}$`), // JS / TS
  new RegExp(`^\\{${EXTENDS}\\}$`), // JSON, .commitlintrc, package.json key
  new RegExp(`^extends:(?:-${PRESET}|\\[${PRESET}\\])$`), // YAML
  // The TS form commitlint documents: a typed const, then default-exported.
  new RegExp(`^(?:importtype\\{UserConfig\\}from"@commitlint/types")?const(\\w+)(?::UserConfig)?=\\{${EXTENDS}\\}(?:exportdefault|module\\.exports=)\\1$`),
];

/** Comments, whitespace, quote style, trailing commas and semicolons removed. */
function normaliseConfig(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*#.*$/gm, '')
    .replace(/'/g, '"')
    .replace(/\s+/g, '')
    .replace(/;/g, '')
    .replace(/,(?=[\]}])/g, '');
}

/** Classify a commitlint config from its text. Pure; never evaluates it (S1). */
export function classifyCommitlintConfig(path: string, text: string): CommitlintConfig {
  const normalised = normaliseConfig(text);
  return {
    path,
    conventional: /config-conventional/.test(text),
    plain: PLAIN_SHAPES.some((re) => re.test(normalised)),
  };
}

/**
 * commitlint's default ignores (`@commitlint/is-ignored` `wildcards`): titles
 * like these are never linted, so they must never fail here either.
 */
const DEFAULT_IGNORES: RegExp[] = [
  /^((Merge pull request)|(Merge (.*?) into (.*?)|(Merge branch (.*?)))(?:\r?\n)*$)/m,
  /^(Merge tag (.*?))(?:\r?\n)*$/m,
  /^(R|r)evert (.*)/,
  /^(R|r)eapply (.*)/,
  /^(amend|fixup|squash)!/,
  /^(Merged (.*?)(in|into) (.*)|Merged PR (.*): (.*))/,
  /^Merge remote-tracking branch(\s*)(.*)/,
  /^Automatic merge(.*)/,
  /^Auto-merged (.*?) into (.*)/,
];
/** semver.valid() on the first line, after commitlint's chore:/[skip ci] stripping. */
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Would commitlint skip this title entirely (default ignores)? Pure. */
export function isDefaultIgnored(title: string): boolean {
  if (DEFAULT_IGNORES.some((re) => re.test(title))) return true;
  const stripped = title
    .split('\n')[0]
    .replace(/^chore(\([^)]+\))?:/, '')
    .replace(/\[(skip|ci)(-|\s)(ci|skip)\]/i, '')
    .replace(/\((skip|ci)(-|\s)(ci|skip)\)/i, '')
    .trim();
  return SEMVER.test(stripped);
}

/** The `commitlint` key of a package.json, re-serialised for `classifyCommitlintConfig`, or null. */
export function packageJsonCommitlintText(packageJsonText: string): string | null {
  try {
    const pkg = JSON.parse(packageJsonText) as { commitlint?: unknown };
    return pkg && typeof pkg === 'object' && pkg.commitlint !== undefined ? JSON.stringify(pkg.commitlint) : null;
  } catch {
    return null;
  }
}

/** `@commitlint/config-conventional`'s `type-enum`. */
export const CONVENTIONAL_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
export const CONVENTIONAL_HEADER_MAX = 100;
/**
 * The conventionalcommits parser preset's header patterns. The parser tries the
 * breaking-change (`!:`) pattern first: with a greedy scope, `!?` alone would
 * split `feat(api)!: drop x (v1): Y` at the later `): `.
 */
const BREAKING_HEADER = /^(\w*)(?:\((.*)\))?!: (.*)$/;
const HEADER = /^(\w*)(?:\((.*)\))?!?: (.*)$/;

/**
 * Problems `@commitlint/config-conventional` would report for `title` used as a
 * commit header, in plain words; empty when it passes. Mirrors the preset's
 * header rules (header-trim, header-max-length, type-empty/-case/-enum,
 * subject-empty, subject-full-stop, subject-case) and commitlint's own case
 * logic; checked against real commitlint on a title corpus. Pure.
 */
export function lintConventionalTitle(title: string): string[] {
  if (isDefaultIgnored(title)) return [];
  const header = title.split('\n')[0];
  const problems: string[] = [];
  if (header !== header.trim()) problems.push('it has leading or trailing whitespace');
  if (header.length > CONVENTIONAL_HEADER_MAX) {
    problems.push(`it is ${header.length} characters; the limit is ${CONVENTIONAL_HEADER_MAX}`);
  }
  const m = BREAKING_HEADER.exec(header) ?? HEADER.exec(header);
  if (!m) {
    problems.push('it does not have the "type(scope): subject" shape');
    return problems;
  }
  const [, type, , subject] = m;
  if (!type) problems.push('the type before the colon is empty');
  else if (type !== type.toLowerCase()) problems.push('the type before the colon must be lower-case');
  else if (!CONVENTIONAL_TYPES.includes(type)) {
    problems.push(`the type before the colon is not one of ${CONVENTIONAL_TYPES.join(', ')}`);
  }
  if (!subject.trim()) problems.push('the subject after the colon is empty');
  else {
    // commitlint exempts a trailing ellipsis from subject-full-stop.
    if (subject.endsWith('.') && !subject.endsWith('...')) problems.push('the subject must not end with a full stop');
    if (isForbiddenSubjectCase(subject)) {
      problems.push('the subject must not start with a capital letter or be all upper-case');
    }
  }
  return problems;
}

/**
 * commitlint's `subject-case: never [sentence, start, pascal, upper]`. As in
 * commitlint, a subject that does not start with a letter is never judged, and
 * quoted / backticked spans are removed first (they may hold proper names).
 * A start- or pascal-case subject begins with a capital, so the sentence-case
 * test (first character upper-case) covers both.
 */
function isForbiddenSubjectCase(subject: string): boolean {
  if (!/^[\p{Ll}\p{Lu}\p{Lt}]/u.test(subject)) return false;
  const input = subject.replace(/`.*?`|".*?"|'.*?'/g, '').trim();
  if (input === '') return true;
  const first = input.charAt(0);
  return first.toUpperCase() === first || input.toUpperCase() === input;
}

/**
 * The `pr-title` result for a PR title against the repo's commit-lint config.
 * No config, or no title to check → no result. Only a plain config-conventional
 * config can fail; a customised one turns a failure into a note (the hook must
 * never deny a title the repo's real commitlint accepts). Pure; never echoes
 * the title (S6).
 */
export function evaluateTitle(
  title: string | null | undefined,
  config: CommitlintConfig | null,
): { results: CheckResult[]; notes: string[] } {
  // An empty title is valid to commitlint (and GitHub rejects it anyway).
  if (!config || title === null || title === undefined || !title.trim()) return { results: [], notes: [] };
  if (!config.conventional) {
    return {
      results: [],
      notes: [`commit-lint config ${config.path} does not extend config-conventional — PR title not checked`],
    };
  }
  const problems = lintConventionalTitle(title);
  if (problems.length === 0) {
    return { results: [{ id: 'pr-title', status: 'pass', summary: 'PR title passes the repo commit-lint rule' }], notes: [] };
  }
  if (!config.plain) {
    return {
      results: [],
      notes: [
        `PR title may fail commit-lint (${config.path} customises config-conventional, so this is not enforced): ` +
          `${problems.join('; ')}`,
      ],
    };
  }
  return {
    results: [
      {
        id: 'pr-title',
        status: 'fail',
        summary:
          `PR title would fail the repo's commit-lint rule (${config.path}, config-conventional): ${problems.join('; ')}. ` +
          `Use "type(scope): subject", e.g. "feat(cli): add a scaffold subcommand".`,
      },
    ],
    notes: [],
  };
}
