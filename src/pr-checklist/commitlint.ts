// PR Checklist Contract — PR-title commit-lint check (#3651).
//
// Repos that squash-merge often lint the PR title as the future commit message
// (commitlint with `@commitlint/config-conventional`). An agent finds out only
// when that CI check goes red. This module reports the same failure up front.
//
// S1: the repo's commitlint config is never executed (it may be JS). We only
// look at its text: a config that extends `config-conventional` gets the
// preset's header rules re-implemented below; any other config is reported as
// "not checked". Custom `rules` in the config are not evaluated (noted instead),
// so this check can miss a failure a stricter config adds, but it does not
// invent a failure the preset would not report.
// Pure: strings in, data out. The tracked-file reads live in engine.ts.

import type { CheckResult } from './types.js';

/** Commitlint config file names, in commitlint's own lookup order (package.json `commitlint` key handled separately). */
export const COMMITLINT_CONFIG_PATHS = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  '.commitlintrc.cts',
  '.commitlintrc.mts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  'commitlint.config.cts',
  'commitlint.config.mts',
];

/** What the engine found about the repo's commit-lint setup. */
export interface CommitlintConfig {
  /** Repo-relative file the config came from (`package.json` for the `commitlint` key). */
  path: string;
  /** The config extends `@commitlint/config-conventional`, so its header rules apply. */
  conventional: boolean;
  /** The config declares its own `rules`, which this check does not evaluate. */
  customRules: boolean;
}

/** Classify a commitlint config from its text. Pure; never evaluates it (S1). */
export function classifyCommitlintConfig(path: string, text: string): CommitlintConfig {
  return {
    path,
    conventional: /config-conventional/.test(text),
    customRules: /["']?\brules["']?\s*[:=]/.test(text),
  };
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
/** The conventional-commits parser preset's header pattern. */
const HEADER = /^(\w*)(?:\((.*)\))?!?: (.*)$/;

/**
 * Problems `@commitlint/config-conventional` would report for `title` used as a
 * commit header, in plain words; empty when it passes. Pure.
 */
export function lintConventionalTitle(title: string): string[] {
  const header = title.split('\n')[0];
  const problems: string[] = [];
  if (header.length > CONVENTIONAL_HEADER_MAX) {
    problems.push(`it is ${header.length} characters; the limit is ${CONVENTIONAL_HEADER_MAX}`);
  }
  const m = HEADER.exec(header);
  if (!m) {
    problems.push('it does not have the "type(scope): subject" shape');
    return problems;
  }
  const [, type, scope, subject] = m;
  if (!type) problems.push('the type before the colon is empty');
  else if (type !== type.toLowerCase()) problems.push(`the type "${type}" must be lower-case`);
  else if (!CONVENTIONAL_TYPES.includes(type)) {
    problems.push(`the type "${type}" is not one of ${CONVENTIONAL_TYPES.join(', ')}`);
  }
  if (scope !== undefined && scope !== scope.toLowerCase()) problems.push(`the scope "${scope}" must be lower-case`);
  const trimmed = subject.trim();
  if (!trimmed) problems.push('the subject after the colon is empty');
  else {
    if (trimmed.endsWith('.')) problems.push('the subject must not end with a full stop');
    if (isForbiddenSubjectCase(trimmed)) {
      problems.push('the subject must not start with a capital letter (sentence-, start-, pascal- or upper-case)');
    }
  }
  return problems;
}

/** config-conventional's `subject-case: never [sentence, start, pascal, upper]`, as commitlint computes those cases. */
function isForbiddenSubjectCase(subject: string): boolean {
  if (!/[A-Za-z]/.test(subject)) return false;
  if (subject === subject.toUpperCase()) return true; // upper-case
  const [first] = subject.split(' ');
  // sentence-case: first word is Upper + lower rest. Start- and pascal-case
  // subjects also begin with such a word, so this one test covers all three for
  // their usual spellings.
  return first.charAt(0) === first.charAt(0).toUpperCase() && first.charAt(0) !== first.charAt(0).toLowerCase()
    && first.slice(1) === first.slice(1).toLowerCase();
}

/**
 * The `pr-title` result for a PR title against the repo's commit-lint config.
 * No config, or no title to check → no result. A config this check cannot
 * evaluate → a note, never a fail. Pure; never echoes the title (S6).
 */
export function evaluateTitle(
  title: string | null | undefined,
  config: CommitlintConfig | null,
): { results: CheckResult[]; notes: string[] } {
  if (!config || title === null || title === undefined) return { results: [], notes: [] };
  if (!config.conventional) {
    return {
      results: [],
      notes: [`commit-lint config ${config.path} does not extend config-conventional — PR title not checked`],
    };
  }
  const notes = config.customRules
    ? [`commit-lint config ${config.path} declares custom rules; the PR title was checked against config-conventional defaults only`]
    : [];
  const problems = lintConventionalTitle(title);
  if (problems.length === 0) return { results: [{ id: 'pr-title', status: 'pass', summary: 'PR title passes the repo commit-lint rule' }], notes };
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
    notes,
  };
}
