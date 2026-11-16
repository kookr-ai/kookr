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
// Prints JSON: { related, tests, hookTests, commands, deferred, unmapped, capped, summary }.
//   related   source files; `vitest related` runs the tests that import them
//   tests     test files to run directly
//   hookTests .claude/hooks-tests/*.test.sh suites to run one by one
//   commands  lane commands to run (e.g. `pnpm test:hooks`)
//   deferred  paths only the integration train verifies (build config, suite setup)
//   unmapped  paths with no rule and nothing selected; logged, never fatal
//   capped    [{ path, estimate }] non-code files whose references would pull in
//             more than CAP_TESTS test files; only tests naming the full path run
//   summary   { estimate, top: [{ path, estimate }] } estimated test files and the
//             three changed paths that select the most (for the one-line report)
// The lists are sorted and unique.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_RE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const TEST_RE = /\.(test|spec)\.(ts|tsx|mts|mjs|js|cjs)$/;
const REF_SOURCE_PATHSPECS = ['*.ts', '*.tsx', '*.mts', '*.mjs'];
const HOOK_TEST_DIR = '.claude/hooks-tests/';
const HOOK_TEST_RE = /^\.claude\/hooks-tests\/[^/]+\.test\.sh$/;
/** A non-code file whose references select more test files than this runs only the tests naming its full path. */
export const CAP_TESTS = 40;

// ---------------------------------------------------------------------------
// Rule table. One line per rule; the first matching `deferred` rule wins and
// stops all other handling of that path (so a TS suite-setup file under test/
// is never handed to `vitest related`, where vitest would treat it as a force
// re-run trigger and run the whole suite). Every other matching rule adds its
// effects. A path that matches any rule counts as "mapped" (not reported as
// unmapped), whichever fields the rule has.
//
//   re       matches the repo-relative path; a rule with only `re` marks the path
//            as mapped (nothing to run, e.g. prose the hook's validators cover)
//   deferred true: nothing to run now, the integration train verifies it
//   command  lane command to run
//   hookTests true: run the hook test suites that belong to or mention the path
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
  { re: /(^|\/)vite(st)?[^/]*\.config\.[^/]+$/, deferred: true },
  { re: /(^|\/)tsconfig[^/]*\.json$/, deferred: true },
  { re: /^test\/(?!.*\.test\.[^/]+$)/, deferred: true },
  // Hook and shell tooling: the hook test suites for the changed file (see
  // hookTestsFor); the whole lane only when the runner or a shared helper changes.
  { re: /^(\.hooks|hooks|plugin\/hooks|\.claude\/hooks|\.claude\/hooks-tests)\//, hookTests: true },
  { re: /^scripts\/.*\.sh$/, hookTests: true },
  {
    re: /^(scripts\/run-hook-tests\.sh|scripts\/lib\/[^/]+\.sh|(hooks|plugin\/hooks|\.claude\/hooks)\/lib\/.+|\.claude\/hooks-tests\/(?![^/]+\.test\.sh$).+)$/,
    command: 'pnpm test:hooks',
  },
  { re: /^stt\//, command: 'pnpm test:stt' },
  // Server and core code, and the smoke scripts: the local-only smoke gate, which
  // starts a real server on a temp data directory and fails on any state file it
  // does not expect there (issue #3995). It takes about 65 s on the shared
  // 16-core host under load (about 85 s with two pushes at once), so it runs
  // for every such change rather than guessing which ones write state; test
  // files alone do not trigger it.
  {
    re: /^(?!.*\.(test|spec)\.[^/]+$)(src\/(server|core)\/|scripts\/local-only-smoke[^/]*\.ts$)/,
    command: 'pnpm test:smoke',
  },
  // Styling: the design-token tests read the CSS.
  { re: /\.css$/, tests: (_p, tracked) => tracked.filter((f) => /^src\/frontend\/.*design-tokens.*\.test\./.test(f)) },
  // Skills, agents and playbooks: their own tests plus the validators.
  { re: /^plugin\/skills\//, tests: unitTests(/^(plugin\/skills\/[^/]+)\//) },
  { re: /^plugin\/(agents|hooks|playbooks)\//, tests: unitTests(/^(plugin\/(?:agents|hooks|playbooks))\//) },
  { re: /^plugin\//, tests: validatorTests },
  { re: /^(\.claude\/(skills|agents|playbooks)|\.kookr\/playbooks)\//, tests: validatorTests },
  { re: /^\.claude\/skills\//, tests: unitTests(/^(\.claude\/skills\/[^/]+)\//) },
  // Prose: the hook's validators already ran.
  { re: /^docs\// },
  { re: /\.md$/ },
];

const GENERIC_BASENAMES = new Set(['README.md', 'SKILL.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json']);
const MIN_DISTINCTIVE = 8;

/**
 * Strings to look for in TS sources that reference a non-code path, strongest first:
 *   strong  the repo-relative path and its suffixes of two or more segments
 *           (`reference/api.md` for `docs/reference/api.md`)
 *   weak    the bare base name, only when no other tracked file has it and it is
 *           distinctive (8+ characters, not README.md, index.*, ...)
 * SKILL.md is searched by `<dir>/SKILL.md` (strong) and a long `<dir>` (weak).
 * @param {string} path
 * @param {string[]} [tracked] every tracked path; without it the base name is never used
 */
export function referenceNeedles(path, tracked = []) {
  const segs = path.split('/');
  const strong = new Set([path]);
  for (let i = 1; i <= segs.length - 2; i += 1) strong.add(segs.slice(i).join('/'));
  const weak = new Set();
  const base = basename(path);
  if (base === 'SKILL.md') {
    const dir = basename(dirname(path));
    if (dir.length >= MIN_DISTINCTIVE) weak.add(dir);
  } else if (base.length >= MIN_DISTINCTIVE && !GENERIC_BASENAMES.has(base) && !/^index\./.test(base)) {
    const sameName = tracked.filter((f) => f === base || f.endsWith(`/${base}`));
    if (tracked.length > 0 && sameName.every((f) => f === path)) weak.add(base);
  }
  return { strong: [...strong], weak: [...weak].filter((n) => !strong.has(n)) };
}

/** Hook test suites named after a changed file: `<stem>.test.sh` and `<stem>-*.test.sh`. */
export function hookTestsFor(path, tracked) {
  if (HOOK_TEST_RE.test(path)) return tracked.includes(path) ? [path] : [];
  const stem = basename(path).replace(/\.(sh|bash|mjs|js|ts|cjs)$/, '');
  if (!stem) return [];
  const own = `${HOOK_TEST_DIR}${stem}.test.sh`;
  const prefix = `${HOOK_TEST_DIR}${stem}-`;
  return tracked.filter((f) => HOOK_TEST_RE.test(f) && (f === own || f.startsWith(prefix)));
}

const uniqSorted = (xs) => [...new Set(xs)].sort();

const isDeferred = (path) => RULES.some((r) => r.deferred && r.re.test(path));

/**
 * @param {object} input
 * @param {string[]} input.changed repo-relative changed paths, deleted ones included
 * @param {(path: string) => boolean} input.exists is the path still on disk
 * @param {(needles: string[]) => string[]} input.findReferences tracked .ts/.tsx/.mts/.mjs files mentioning any needle
 * @param {string[]} input.tracked every tracked path (for rules that pick tests by location)
 * @param {(needles: string[]) => string[]} [input.findHookTestReferences] hook test suites mentioning any needle
 * @param {(files: string[]) => number} [input.countTests] estimated test files `vitest related` runs for these
 *   files; without it no cap applies and sizes count selected files
 */
export function selectFastGate({ changed, exists, findReferences, tracked, findHookTestReferences = () => [], countTests }) {
  const related = [];
  const tests = [];
  const hookTests = [];
  const commands = [];
  const deferred = [];
  const unmapped = [];
  const capped = [];
  const contributions = [];
  const estimate = (files) => (countTests ? countTests(files) : new Set(files).size);

  for (const path of uniqSorted(changed)) {
    const matched = RULES.filter((r) => r.re.test(path));
    if (matched.some((r) => r.deferred)) {
      deferred.push(path);
      continue;
    }
    const mine = { related: [], tests: [], hook: [], commands: [] };
    for (const r of matched) {
      if (r.command) mine.commands.push(r.command);
      if (r.tests) mine.tests.push(...r.tests(path, tracked));
      if (r.hookTests) {
        mine.hook.push(...hookTestsFor(path, tracked));
        mine.hook.push(...findHookTestReferences(referenceNeedles(path).strong).filter((f) => HOOK_TEST_RE.test(f)));
      }
    }
    if (CODE_RE.test(path)) {
      if (exists(path)) mine.related.push(path);
    } else {
      // A config or suite-setup hit would make `vitest related` run everything.
      const usable = (hits) => hits.filter((f) => f !== path && !isDeferred(f));
      const { strong, weak } = referenceNeedles(path, tracked);
      const strongHits = usable(findReferences(strong));
      const hits = [...new Set([...strongHits, ...(weak.length ? usable(findReferences(weak)) : [])])];
      const size = estimate(hits);
      if (countTests && size > CAP_TESTS) {
        capped.push({ path, estimate: size });
        mine.tests.push(...usable(findReferences([path])).filter((f) => TEST_RE.test(f)));
      } else {
        for (const hit of hits) (TEST_RE.test(hit) ? mine.tests : mine.related).push(hit);
      }
    }
    mine.hook = uniqSorted(mine.hook);
    related.push(...mine.related);
    tests.push(...mine.tests);
    hookTests.push(...mine.hook);
    commands.push(...mine.commands);
    // Mapped: a rule other than the hook-test lookup claims the path (prose, a
    // lane, a test rule), or something was selected for it. A hook or shell file
    // whose lookup found no suite is unmapped, so it shows in the unmapped log.
    const selectedSomething = mine.related.length + mine.tests.length + mine.hook.length + mine.commands.length > 0;
    const claimed = CODE_RE.test(path) || matched.some((r) => !r.hookTests) || capped.some((c) => c.path === path);
    if (!selectedSomething && !claimed) unmapped.push(path);
    contributions.push({ path, estimate: estimate([...mine.related, ...mine.tests]) + mine.hook.length });
  }

  const vitestFiles = [...related, ...tests];
  return {
    related: uniqSorted(related),
    tests: uniqSorted(tests),
    hookTests: uniqSorted(hookTests),
    commands: uniqSorted(commands),
    deferred: uniqSorted(deferred),
    unmapped: uniqSorted(unmapped),
    capped: capped.sort((a, b) => a.path.localeCompare(b.path)),
    summary: {
      estimate: estimate(vitestFiles) + uniqSorted(hookTests).length,
      top: contributions
        .filter((c) => c.estimate > 0)
        .sort((a, b) => b.estimate - a.estimate || a.path.localeCompare(b.path))
        .slice(0, 3),
    },
  };
}

function gitLines(root, args) {
  const out = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

const IMPORT_RES = [
  /(?:^|[\n;])\s*import\s+(?:[^'"`;]*?\sfrom\s*)?['"](\.[^'"]+)['"]/g,
  /(?:^|[\n;])\s*export\s+[^'"`;]*?\sfrom\s*['"](\.[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.cjs'];

/**
 * Estimate how many test files `vitest related` runs for a set of files: walk a
 * reverse graph of relative imports (regex over the sources, type-only imports
 * included, so it errs high) and count the test files reached. Used only to size
 * a selection (the cap and the one-line report), never to pick tests.
 * @param {string[]} tracked every tracked path
 * @param {(path: string) => string | null} read file contents, null when unreadable
 * @returns {(files: string[]) => number}
 */
export function buildTestCounter(tracked, read) {
  const trackedSet = new Set(tracked);
  const importers = new Map();
  const resolveSpec = (from, spec) => {
    const base = normalize(join(dirname(from), spec.replace(/\?.*$/, '')));
    const stripped = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    const candidates = [base, ...RESOLVE_EXTS.map((e) => stripped + e), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => trackedSet.has(c)) ?? null;
  };
  for (const file of tracked) {
    if (!CODE_RE.test(file)) continue;
    const src = read(file);
    if (src == null) continue;
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const target = resolveSpec(file, m[1]);
        if (!target || target === file) continue;
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target).add(file);
      }
    }
  }
  return (files) => {
    const seen = new Set(files);
    const stack = [...seen];
    let count = 0;
    while (stack.length) {
      const f = stack.pop();
      if (TEST_RE.test(f)) count += 1;
      for (const imp of importers.get(f) ?? []) {
        if (!seen.has(imp)) {
          seen.add(imp);
          stack.push(imp);
        }
      }
    }
    return count;
  };
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
  const grep = (pathspecs) => (needles) => {
    if (needles.length === 0) return [];
    const args = ['grep', '-l', '-F', '--no-color'];
    for (const n of needles) args.push('-e', n);
    args.push('--', ...pathspecs);
    try {
      return gitLines(root, args);
    } catch (err) {
      if (err && err.status === 1) return []; // git grep: no match
      throw err;
    }
  };
  const read = (p) => {
    try {
      return readFileSync(resolve(root, p), 'utf8');
    } catch {
      return null;
    }
  };
  const result = selectFastGate({
    changed,
    exists: (p) => existsSync(resolve(root, p)),
    findReferences: grep(REF_SOURCE_PATHSPECS),
    findHookTestReferences: grep([`${HOOK_TEST_DIR}*.test.sh`]),
    tracked,
    countTests: buildTestCounter(tracked, read),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
