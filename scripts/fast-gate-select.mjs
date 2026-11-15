#!/usr/bin/env node
// fast-gate-select - pick the tests a push has to run (issue #3788).
//
// The fast pre-push gate runs the static checks, then only the tests related to
// the diff; the full suite runs on the integration train. This module decides
// "related to the diff". It is pure apart from the CLI at the bottom: the file
// lookups (is this path still on disk, which tracked files mention this string,
// which files are tracked) are injected so unit tests need no git.
//
// Usage: node scripts/fast-gate-select.mjs --base <merge-base-sha> [--root <dir>]
// Prints JSON: { related, tests, commands, deferred, unmapped } (each sorted, unique).
//   related   source files; `vitest related` runs the tests that import them
//   tests     test files to run directly
//   commands  lane commands to run (e.g. `pnpm test:hooks`)
//   deferred  paths only the integration train verifies (build config, suite setup)
//   unmapped  non-TS paths with no rule and no reference hit; logged, never fatal

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_RE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|cjs)$/;
const REF_SOURCE_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.mjs'];

// ---------------------------------------------------------------------------
// Rule table. One line per rule; the first matching `deferred` rule wins and
// stops all other handling of that path (so a TS suite-setup file under test/
// is never handed to `vitest related`, where vitest would treat it as a force
// re-run trigger and run the whole suite). Every other matching rule adds its
// effects. A path that matches any rule counts as "mapped".
//
//   re       matches the repo-relative path
//   deferred true: nothing to run now, the integration train verifies it
//   command  lane command to run
//   mapped   true: matching is the whole effect (checked by the hook's validators)
//   tests    (path, tracked) => test files to run
// ---------------------------------------------------------------------------
const unitTests = (unitRe) => (path, tracked) => {
  const m = unitRe.exec(path);
  if (!m) return [];
  const prefix = `${m[1]}/`;
  return tracked.filter((f) => f.startsWith(prefix) && TEST_RE.test(f));
};
const validatorTests = (_path, tracked) => tracked.filter((f) => /^scripts\/validate-[^/]*\.test\.ts$/.test(f));

export const RULES = [
  // Build configuration and suite setup: not selectable, verified on the train.
  { re: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/, deferred: true },
  { re: /(^|\/)vitest[^/]*\.config\.[^/]+$/, deferred: true },
  { re: /(^|\/)tsconfig[^/]*\.json$/, deferred: true },
  { re: /^test\/(?!.*\.test\.[^/]+$)/, deferred: true },
  // Hook and shell tooling.
  { re: /^(\.hooks|hooks|plugin\/hooks|\.claude\/hooks|\.claude\/hooks-tests)\//, command: 'pnpm test:hooks' },
  { re: /^scripts\/.*\.sh$/, command: 'pnpm test:hooks' },
  { re: /^stt\//, command: 'pnpm test:stt' },
  // Styling: the design-token tests read the CSS.
  { re: /\.css$/, tests: (_p, tracked) => tracked.filter((f) => /^src\/frontend\/.*design-tokens.*\.test\./.test(f)) },
  // Skills, agents and playbooks: their own tests plus the validators.
  { re: /^plugin\/skills\//, tests: unitTests(/^(plugin\/skills\/[^/]+)\//) },
  { re: /^plugin\/(agents|hooks|playbooks)\//, tests: unitTests(/^(plugin\/(?:agents|hooks|playbooks))\//) },
  { re: /^plugin\//, tests: validatorTests },
  { re: /^(\.claude\/(skills|agents|playbooks)|\.kookr\/playbooks)\//, tests: validatorTests },
  { re: /^\.claude\/skills\//, tests: unitTests(/^(\.claude\/skills\/[^/]+)\//) },
  // Prose: the hook's validators already ran.
  { re: /^docs\//, mapped: true },
  { re: /\.md$/, mapped: true },
];

const GENERIC_BASENAMES = new Set(['README.md', 'SKILL.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json']);
const MIN_DISTINCTIVE = 8;

/** Strings to look for in TS sources that reference a non-code path. */
export function referenceNeedles(path) {
  const needles = new Set([path]);
  const base = basename(path);
  if (base === 'SKILL.md') {
    const dir = basename(dirname(path));
    needles.add(`${dir}/SKILL.md`);
    if (dir.length >= MIN_DISTINCTIVE) needles.add(dir);
  } else if (base.length >= MIN_DISTINCTIVE && !GENERIC_BASENAMES.has(base) && !/^index\./.test(base)) {
    needles.add(base);
  }
  return [...needles];
}

const uniqSorted = (xs) => [...new Set(xs)].sort();

/**
 * @param {object} input
 * @param {string[]} input.changed repo-relative changed paths, deleted ones included
 * @param {(path: string) => boolean} input.exists is the path still on disk
 * @param {(needles: string[]) => string[]} input.findReferences tracked .ts/.tsx/.mts/.mjs files mentioning any needle
 * @param {string[]} input.tracked every tracked path (for rules that pick tests by location)
 */
export function selectFastGate({ changed, exists, findReferences, tracked }) {
  const related = [];
  const tests = [];
  const commands = [];
  const deferred = [];
  const unmapped = [];

  for (const path of uniqSorted(changed)) {
    const matched = RULES.filter((r) => r.re.test(path));
    if (matched.some((r) => r.deferred)) {
      deferred.push(path);
      continue;
    }
    for (const r of matched) {
      if (r.command) commands.push(r.command);
      if (r.tests) tests.push(...r.tests(path, tracked));
    }
    if (CODE_RE.test(path)) {
      if (exists(path)) related.push(path);
      continue;
    }
    const hits = findReferences(referenceNeedles(path)).filter((f) => f !== path);
    for (const hit of hits) (TEST_RE.test(hit) ? tests : related).push(hit);
    if (matched.length === 0 && hits.length === 0) unmapped.push(path);
  }

  return {
    related: uniqSorted(related),
    tests: uniqSorted(tests),
    commands: uniqSorted(commands),
    deferred: uniqSorted(deferred),
    unmapped: uniqSorted(unmapped),
  };
}

function gitLines(root, args) {
  const out = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

function main(argv) {
  let base = '';
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base') base = argv[++i] ?? '';
    else if (argv[i] === '--root') root = resolve(argv[++i] ?? '.');
    else {
      process.stderr.write(`fast-gate-select: unknown argument ${argv[i]}\n`);
      return 2;
    }
  }
  if (!base) {
    process.stderr.write('usage: fast-gate-select.mjs --base <merge-base-sha> [--root <dir>]\n');
    return 2;
  }
  const changed = gitLines(root, ['diff', '--name-only', '--no-renames', '--relative', base, 'HEAD']);
  const tracked = gitLines(root, ['ls-files']);
  const findReferences = (needles) => {
    const args = ['grep', '-l', '-F', '--no-color'];
    for (const n of needles) args.push('-e', n);
    args.push('--', ...REF_SOURCE_PATHSPECS);
    try {
      return gitLines(root, args);
    } catch (err) {
      if (err && err.status === 1) return []; // git grep: no match
      throw err;
    }
  };
  const result = selectFastGate({ changed, exists: (p) => existsSync(resolve(root, p)), findReferences, tracked });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
