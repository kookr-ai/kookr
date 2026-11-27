// PR Checklist Contract — engine (P1).
//
// `verifyChecklist` is pure orchestration over already-gathered inputs.
// `collectAndVerify` is the impure entry that reads the diff (git) and the
// declared env file + test corpus (fs), with path confinement (S4) and size
// caps (S8). Fail-closed on repo-input errors is the caller's job (the CLI maps
// a thrown collect error to a verification failure, not a soft skip — S2).

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  compileTestGlobs,
  evaluateAttestation,
  evaluateStructural,
  evaluateTemplatePresence,
  evaluateTemplateRequiredButMissing,
  findUnparsedMarkerIds,
  isSourceFile,
  parseChecklist,
  sourceBaseName,
} from './checklist.js';
import {
  classifyCommitlintConfig,
  COMMITLINT_CONFIG_PATHS,
  evaluateTitle,
  packageJsonCommitlintText,
  type CommitlintConfig,
} from './commitlint.js';
import { parseChecklistConfig } from './config.js';
import { ChecklistInputError } from './errors.js';
import { collectDiffFacts, execGit, type GitRunner } from './git.js';
import { scaffoldBody, type ScaffoldResult } from './scaffold.js';
import type { DiffFacts, VerifyReport } from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ENV_FILE_BYTES = 256 * 1024;
export const MAX_TEST_FILE_BYTES = 512 * 1024;
export const MAX_CONFIG_BYTES = 64 * 1024;

export interface VerifyInput {
  /** PR body text, or null when unavailable (attestation rules then skip). */
  body: string | null;
  facts: DiffFacts;
  envFileText: string;
  /** The names of the new source modules that some test file mentions, one per line (see `readTestCorpus`). */
  testCorpus: string;
  /** The repo's PR-template text, or '' when it ships none (presence rule then no-ops). */
  templateText: string;
  /** Rule ids the repo disabled via .kookr/pr-checklist.json (P4a). Only removes checks. */
  disabled?: ReadonlySet<string>;
  /** The repo's declared test globs (`testGlobs`), compiled; they add to the built-in test patterns. */
  testPatterns?: readonly RegExp[];
  /** Non-fatal notes from parsing the repo config, surfaced in the report. */
  configNotes?: readonly string[];
  /**
   * Set (with `body: null`) when the body is one the command cannot show us and
   * gh would build without the template (`--fill*`, no body flag). If the repo
   * template declares markers this fails; the value is the human reason.
   */
  templateRequiredReason?: string;
  /** PR title to check against the repo's commit-lint rule, or null/absent to skip. */
  title?: string | null;
  /** The repo's commit-lint config, or null when it has none (title check then no-ops). */
  commitlint?: CommitlintConfig | null;
}

/** Pure: evaluate attestation + structural rules and aggregate. */
export function verifyChecklist(input: VerifyInput): VerifyReport {
  const notes: string[] = [];
  const rows = input.body === null ? [] : parseChecklist(input.body);
  const bodyChecked = input.body !== null;
  if (!bodyChecked) notes.push('no PR body provided — attestation checks skipped');

  // Presence before attestation: "was the checklist even included" is more
  // fundamental than "are the ticked boxes honest". With no body we only fail
  // when the caller says gh would build a template-less body (`--fill`, no body
  // flag); other unseen bodies (stdin, other expansions) stay degraded, not failed.
  const presence = bodyChecked
    ? evaluateTemplatePresence(input.templateText, rows, findUnparsedMarkerIds(input.body ?? '', rows))
    : input.templateRequiredReason !== undefined
      ? evaluateTemplateRequiredButMissing(input.templateText, input.templateRequiredReason)
      : [];

  const testPatterns = input.testPatterns ?? [];
  const attest = evaluateAttestation(rows, input.facts.changedPaths, input.templateText, testPatterns);
  notes.push(...attest.notes);

  const structural = evaluateStructural(input.facts, input.envFileText, input.testCorpus, attest.waived, testPatterns);

  // The title check is REPORTED, never enforced, in verify (#3651): verify is
  // the local gh-pr-create gate, and a text-only re-implementation of
  // commitlint can never be proven identical to the repo's real one, so a
  // mismatch must not deny a PR. A failing title becomes a warning note.
  const title = evaluateTitle(input.title, input.commitlint ?? null);
  notes.push(...title.notes);
  for (const r of title.results) {
    if (r.status === 'fail') notes.push(`⚠ ${r.summary} (reported only — the gate does not block on the title)`);
  }
  const titleResults = title.results.filter((r) => r.status !== 'fail');

  const allResults = [...presence, ...attest.results, ...structural, ...titleResults];

  // P4a: drop results for rules the repo disabled in .kookr/pr-checklist.json.
  // This can only REMOVE checks, never add a fail — a repo relaxing its own gate.
  const disabled = input.disabled ?? EMPTY_DISABLED;
  const results = disabled.size === 0 ? allResults : allResults.filter((r) => !disabled.has(r.id));
  if (disabled.size > 0) {
    const droppedIds = new Set(allResults.filter((r) => disabled.has(r.id)).map((r) => r.id));
    for (const id of droppedIds) notes.push(`rule "${id}" disabled by .kookr/pr-checklist.json`);
  }
  if (input.configNotes && input.configNotes.length > 0) notes.push(...input.configNotes);

  const ok = !results.some((r) => r.status === 'fail');
  return { ok, bodyChecked, results, notes };
}

const EMPTY_DISABLED: ReadonlySet<string> = new Set();

export interface CollectDeps {
  cwd: string;
  base: string;
  body: string | null;
  /** See `VerifyInput.templateRequiredReason`; only meaningful with `body: null`. */
  templateRequiredReason?: string;
  /** PR title to check against the repo's commit-lint rule (null/absent: not checked). */
  title?: string | null;
  gitRunner?: GitRunner;
  readFileText?: (absPath: string, cap: number) => Promise<string>;
}

/** Impure: gather diff facts + env template + test corpus, then verify. */
export async function collectAndVerify(deps: CollectDeps): Promise<VerifyReport> {
  const runner = deps.gitRunner ?? execGit(deps.cwd);
  const read = deps.readFileText ?? ((p, cap) => readConfined(deps.cwd, p, cap));

  // Opt-in is template-driven: a repo takes part by shipping a PR template that
  // declares `kookr:check` markers, or a tracked `.kookr/pr-checklist.json`.
  // Read both first (cheap; no diff needed) so a repo with neither — e.g. an
  // upstream OSS repo — gets no opinion at all, not the structural rules.
  const templateText = await readTemplate(runner, read, deps.cwd);
  // P4a: per-repo declarative rule config (may also disable a rule that would
  // otherwise fire on this very diff).
  const configText = await readTracked(runner, read, deps.cwd, '.kookr/pr-checklist.json', MAX_CONFIG_BYTES);
  const bodyHasMarkers = deps.body !== null && parseChecklist(deps.body).length > 0;
  if (!isChecklistOptedIn(templateText, configText) && !bodyHasMarkers) {
    return {
      ok: true,
      bodyChecked: false,
      results: [],
      notes: [
        'no opinion: the repo PR template declares no kookr:check markers and there is no tracked ' +
          '.kookr/pr-checklist.json — the checklist gate only applies to repos that opt in that way',
      ],
      noOpinion: true,
    };
  }
  const config = parseChecklistConfig(configText);
  const testPatterns = compileTestGlobs(config.testGlobs);

  const facts = await collectDiffFacts(runner, deps.base, testPatterns);

  // Only gather env/test inputs when the diff actually needs them.
  const newSourceFiles = facts.addedFiles.filter((p) => isSourceFile(p, testPatterns));
  const needsEnv = !facts.baseUnresolved && facts.addedSourceLines.length > 0;
  const needsTests = !facts.baseUnresolved && newSourceFiles.length > 0;

  const envFileText = needsEnv ? await readTracked(runner, read, deps.cwd, '.env.example', MAX_ENV_FILE_BYTES) : '';
  const testCorpus = needsTests ? await readTestCorpus(runner, read, deps.cwd, newSourceFiles, testPatterns) : '';

  // A repo that disables `pr-title` gets no title check at all — no warning
  // note either (the disable filter below only removes results).
  const commitlint =
    typeof deps.title === 'string' && !config.disable.has('pr-title')
      ? await readCommitlintConfig(runner, read, deps.cwd)
      : null;

  return verifyChecklist({
    body: deps.body,
    facts,
    envFileText,
    testCorpus,
    templateText,
    disabled: config.disable,
    testPatterns,
    configNotes: config.notes,
    templateRequiredReason: deps.body === null ? deps.templateRequiredReason : undefined,
    title: deps.title,
    commitlint,
  });
}

export type ScaffoldOutcome =
  | { kind: 'no-template' }
  | { kind: 'base-unresolved' }
  | { kind: 'ok'; scaffold: ScaffoldResult; noMarkers: boolean; title: { results: VerifyReport['results']; notes: string[] } };

/**
 * Impure: read the repo PR template and the diff against `base`, then build the
 * body `verify` accepts (see scaffold.ts). Also checks `title` against the
 * repo's commit-lint rule when one is given.
 */
export async function collectScaffold(deps: Omit<CollectDeps, 'body' | 'templateRequiredReason'>): Promise<ScaffoldOutcome> {
  const runner = deps.gitRunner ?? execGit(deps.cwd);
  const read = deps.readFileText ?? ((p, cap) => readConfined(deps.cwd, p, cap));
  const templateText = await readTemplate(runner, read, deps.cwd);
  if (!templateText.trim()) return { kind: 'no-template' };
  // Honour the repo's disable list exactly as verify does, so the two verbs agree.
  const config = parseChecklistConfig(
    await readTracked(runner, read, deps.cwd, '.kookr/pr-checklist.json', MAX_CONFIG_BYTES),
  );
  const noMarkers = parseChecklist(templateText).length === 0;
  // Without a diff every row would be struck — refuse rather than mislead.
  const facts = noMarkers ? null : await collectDiffFacts(runner, deps.base);
  if (facts?.baseUnresolved) return { kind: 'base-unresolved' };
  const commitlint =
    typeof deps.title === 'string' && !config.disable.has('pr-title')
      ? await readCommitlintConfig(runner, read, deps.cwd)
      : null;
  const title = evaluateTitle(deps.title, commitlint);
  return {
    kind: 'ok',
    scaffold: scaffoldBody(templateText, facts?.changedPaths ?? [], config.disable, compileTestGlobs(config.testGlobs)),
    noMarkers,
    title: { results: title.results, notes: [...title.notes, ...config.notes] },
  };
}

/**
 * The repo's commit-lint config, found by tracked file name (then the
 * package.json `commitlint` key), or null. Read as text only — never executed (S1).
 */
async function readCommitlintConfig(
  runner: GitRunner,
  read: (absPath: string, cap: number) => Promise<string>,
  cwd: string,
): Promise<CommitlintConfig | null> {
  // Same order as @commitlint/load: package.json / package.yaml (only with a
  // `commitlint` key) first, then the config files.
  const pkg = await readTracked(runner, read, cwd, 'package.json', MAX_BODY_BYTES);
  const key = pkg ? packageJsonCommitlintText(pkg) : null;
  if (key !== null) return classifyCommitlintConfig('package.json', key);
  const pkgYaml = await readTracked(runner, read, cwd, 'package.yaml', MAX_BODY_BYTES);
  if (/^commitlint:/m.test(pkgYaml)) {
    // Not parsed: the key's YAML is never matched against the plain shapes.
    return { ...classifyCommitlintConfig('package.yaml', pkgYaml), plain: false };
  }
  for (const path of COMMITLINT_CONFIG_PATHS) {
    const text = await readTracked(runner, read, cwd, path, MAX_CONFIG_BYTES);
    if (text.trim()) return classifyCommitlintConfig(path, text);
  }
  return null;
}

/** Pure: does the repo opt in to the checklist gate (marker template or rule config)? */
export function isChecklistOptedIn(templateText: string, configText: string): boolean {
  return parseChecklist(templateText).length > 0 || configText.trim() !== '';
}

/**
 * GitHub's accepted single-file PR-template locations (root / `.github/` /
 * `docs/`, either case). First tracked, non-empty match wins. The
 * `.github/PULL_REQUEST_TEMPLATE/` *directory* form (multiple named templates,
 * selected per-PR via `?template=`) is intentionally not handled here — which
 * of several templates applies is not statically knowable from the command, so
 * the presence rule stays a no-op for that layout rather than guessing.
 */
const PR_TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
];

async function readTemplate(
  runner: GitRunner,
  read: (absPath: string, cap: number) => Promise<string>,
  cwd: string,
): Promise<string> {
  for (const path of PR_TEMPLATE_PATHS) {
    const listed = await runner(['ls-files', '--', path]);
    if (listed.exitCode !== 0 || !listed.stdout.trim()) continue;
    // A tracked template that fails the confinement/size guards is repo input
    // we cannot trust: fail CLOSED (S2) rather than report a false "no opinion".
    const text = await read(resolve(cwd, path), MAX_BODY_BYTES).catch((error: unknown) => {
      if (error instanceof ChecklistInputError) {
        throw new ChecklistInputError(`PR template ${path} cannot be read: ${error.message}`);
      }
      // Tracked but deleted from the work tree: nothing to enforce. Any other
      // read failure (e.g. EACCES) is unreadable repo input — fail closed.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
      throw new ChecklistInputError(`PR template ${path} cannot be read: ${(error as Error)?.message ?? String(error)}`);
    });
    if (text.trim()) return text;
  }
  return '';
}

async function readTracked(
  runner: GitRunner,
  read: (absPath: string, cap: number) => Promise<string>,
  cwd: string,
  path: string,
  cap: number,
): Promise<string> {
  const listed = await runner(['ls-files', '--', path]);
  if (listed.exitCode !== 0 || !listed.stdout.trim()) return '';
  return read(resolve(cwd, path), cap).catch(() => '');
}

/**
 * The files whose text counts as "the tests" when a new source module must be referenced by one.
 * They follow `TEST_FILE_PATTERNS` in checklist.ts (`.test.` or `.spec.`, in `.ts`, `.tsx`, `.js` or `.jsx`).
 * The list once had only `*.test.ts` and `*.test.js`, so a new frontend module tested from a `.test.tsx`
 * file was reported as having no test.
 */
export const TEST_CORPUS_PATHSPECS: readonly string[] = [
  '*.test.ts', '*.test.tsx', '*.test.js', '*.test.jsx',
  '*.spec.ts', '*.spec.tsx', '*.spec.js', '*.spec.jsx',
  '*/__tests__/*', 'test/*',
];

/**
 * What the tests say about the new source modules: the names of those modules that at least one test
 * file mentions, joined into the "corpus" `findUntested` looks them up in.
 *
 * Every listed test file is looked at, one at a time, until each name has been found. An earlier
 * version joined the text of the test files up to 16 MiB and stopped there; this
 * repository has more test text than that, so which test files counted depended on where they sort,
 * and a module whose test sorted late (most of `src/server`) was reported as untested. Only the
 * per-file cap is kept: a test file larger than `MAX_TEST_FILE_BYTES` is skipped whole, as before.
 */
async function readTestCorpus(
  runner: GitRunner,
  read: (absPath: string, cap: number) => Promise<string>,
  cwd: string,
  newSourceFiles: readonly string[],
  testPatterns: readonly RegExp[] = [],
): Promise<string> {
  const wanted = new Set(newSourceFiles.map(sourceBaseName).filter((name) => name.length > 0));
  if (wanted.size === 0) return '';
  const listed = await runner(['ls-files', '--', ...TEST_CORPUS_PATHSPECS]);
  if (listed.exitCode !== 0) return '';
  const files = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  if (testPatterns.length > 0) {
    // The repo's declared test globs (#4257) are matched in-process, with the
    // same regexes the evidence rule uses, rather than handed to git as
    // pathspecs, whose `*` semantics differ. Added after the default files.
    const all = await runner(['ls-files']);
    if (all.exitCode === 0) {
      const seen = new Set(files);
      for (const rel of all.stdout.split('\n').map((s) => s.trim())) {
        if (rel && !seen.has(rel) && testPatterns.some((re) => re.test(rel))) files.push(rel);
      }
    }
  }
  const found: string[] = [];
  for (const rel of files) {
    if (wanted.size === 0) break;
    const text = await read(resolve(cwd, rel), MAX_TEST_FILE_BYTES).catch(() => '');
    for (const name of wanted) {
      if (text.includes(name)) {
        found.push(name);
        wanted.delete(name);
      }
    }
  }
  return found.join('\n');
}

/**
 * S4: read a file only if it resolves inside the repo root (after symlink
 * resolution), is a regular file, and is within the size cap. Throws otherwise.
 */
export async function readConfined(root: string, absPath: string, cap: number): Promise<string> {
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    real = resolve(absPath);
  }
  const rel = relative(realRoot, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ChecklistInputError('path escapes repository root');
  }
  const buf = await readFile(real, { encoding: 'utf-8' });
  if (buf.length > cap) throw new ChecklistInputError('file exceeds size cap');
  return buf;
}
