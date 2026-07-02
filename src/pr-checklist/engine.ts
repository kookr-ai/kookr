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
  evaluateAttestation,
  evaluateStructural,
  evaluateTemplatePresence,
  isSourceFile,
  parseChecklist,
} from './checklist.js';
import { ChecklistInputError } from './errors.js';
import { collectDiffFacts, execGit, type GitRunner } from './git.js';
import type { DiffFacts, VerifyReport } from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ENV_FILE_BYTES = 256 * 1024;
export const MAX_TEST_FILE_BYTES = 512 * 1024;
export const MAX_TEST_CORPUS_BYTES = 16 * 1024 * 1024;

export interface VerifyInput {
  /** PR body text, or null when unavailable (attestation rules then skip). */
  body: string | null;
  facts: DiffFacts;
  envFileText: string;
  testCorpus: string;
  /** The repo's PR-template text, or '' when it ships none (presence rule then no-ops). */
  templateText: string;
}

/** Pure: evaluate attestation + structural rules and aggregate. */
export function verifyChecklist(input: VerifyInput): VerifyReport {
  const notes: string[] = [];
  const rows = input.body === null ? [] : parseChecklist(input.body);
  const bodyChecked = input.body !== null;
  if (!bodyChecked) notes.push('no PR body provided — attestation checks skipped (CI is authoritative)');

  // Presence before attestation: "was the checklist even included" is more
  // fundamental than "are the ticked boxes honest". Skipped when no body was
  // provided — CI stays authoritative rather than us guessing at an absent body.
  const presence = bodyChecked ? evaluateTemplatePresence(input.templateText, rows) : [];

  const attest = evaluateAttestation(rows, input.facts.changedPaths);
  notes.push(...attest.notes);

  const structural = evaluateStructural(input.facts, input.envFileText, input.testCorpus, attest.waived);

  const results = [...presence, ...attest.results, ...structural];
  const ok = !results.some((r) => r.status === 'fail');
  return { ok, bodyChecked, results, notes };
}

export interface CollectDeps {
  cwd: string;
  base: string;
  body: string | null;
  gitRunner?: GitRunner;
  readFileText?: (absPath: string, cap: number) => Promise<string>;
}

/** Impure: gather diff facts + env template + test corpus, then verify. */
export async function collectAndVerify(deps: CollectDeps): Promise<VerifyReport> {
  const runner = deps.gitRunner ?? execGit(deps.cwd);
  const read = deps.readFileText ?? ((p, cap) => readConfined(deps.cwd, p, cap));

  const facts = await collectDiffFacts(runner, deps.base);

  // Only gather env/test inputs when the diff actually needs them.
  const needsEnv = !facts.baseUnresolved && facts.addedSourceLines.length > 0;
  const needsTests = !facts.baseUnresolved && facts.addedFiles.some(isSourceFile);

  const envFileText = needsEnv ? await readTracked(runner, read, deps.cwd, '.env.example', MAX_ENV_FILE_BYTES) : '';
  const testCorpus = needsTests ? await readTestCorpus(runner, read, deps.cwd) : '';

  // Only meaningful when a body was provided — the presence rule compares the
  // body against the template, and needs no diff (so it runs even when the
  // base is unresolved).
  const templateText = deps.body !== null ? await readTemplate(runner, read, deps.cwd) : '';

  return verifyChecklist({ body: deps.body, facts, envFileText, testCorpus, templateText });
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
    const text = await readTracked(runner, read, cwd, path, MAX_BODY_BYTES);
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

async function readTestCorpus(
  runner: GitRunner,
  read: (absPath: string, cap: number) => Promise<string>,
  cwd: string,
): Promise<string> {
  const listed = await runner(['ls-files', '--', '*.test.ts', '*.test.js', '*/__tests__/*', 'test/*']);
  if (listed.exitCode !== 0) return '';
  const files = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const parts: string[] = [];
  let total = 0;
  for (const rel of files) {
    if (total >= MAX_TEST_CORPUS_BYTES) break;
    const text = await read(resolve(cwd, rel), MAX_TEST_FILE_BYTES).catch(() => '');
    total += text.length;
    parts.push(text);
  }
  return parts.join('\n');
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
