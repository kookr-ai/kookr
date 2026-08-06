#!/usr/bin/env node
/**
 * FAA-mitigation gate (issue #2142).
 *
 * `finishedAwaitingAck` (FAA) is the single highest-churn capacity pattern in
 * the harness: ~10 merged PRs of reclaim / reaper / counter / status-pill /
 * Discord-page plumbing in one 24h window, with the `finishedAwaitingAck_age`
 * anomaly still firing chronically. Every one of those was downstream symptom
 * plumbing; none recorded WHY acks lag.
 *
 * This lightweight, lint-style gate makes the harness stop paving over the
 * symptom: any change that touches an FAA-mitigation surface must cite a
 * *classified root cause* (one of the {@link FAA_ROOT_CAUSES} categories the
 * `/api/health` classifier emits) in its commit messages or PR body — or an
 * explicit, reasoned bypass. It never blocks unrelated changes: it fires only
 * when the diff actually touches the FAA-mitigation surface.
 *
 * Pure core (`evaluateFaaMitigationGate`) + a thin git-driven CLI so the
 * decision logic is unit-testable without a real repo.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { FAA_ROOT_CAUSES } from '../src/core/faa-root-cause.js';

/**
 * Path fragments that mark a file as part of the FAA / completion-ready
 * mitigation surface. A changed file whose repo-relative path contains any of
 * these (case-insensitive) puts the change in scope for the gate.
 */
export const FAA_MITIGATION_PATH_FRAGMENTS: readonly string[] = [
  'completion-ready',
  'completion-signal',
  'capacity-ledger',
  'hung-task-reaper',
  'ack-all-completion-ready',
  'faa-root-cause',
];

/**
 * Regexes that mark a file as FAA-mitigation by naming convention (reclaim /
 * reaper surfaces the fragment list above does not enumerate by exact name).
 */
export const FAA_MITIGATION_PATH_PATTERNS: readonly RegExp[] = [
  /reclaim/i,
  /reaper/i,
];

/** Keywords that put a change in scope even when no obvious file path matched. */
export const FAA_MITIGATION_KEYWORDS: readonly RegExp[] = [
  /finishedawaitingack/i,
  /finished-awaiting-ack/i,
  /\bFAA\b/,
];

/**
 * Marker (with a required reason) that consciously bypasses the gate. Anchored
 * to the start of a line (after optional whitespace) so it must be a DELIBERATE
 * marker on its own line — a mid-sentence prose mention of the syntax (e.g. this
 * doc, or a PR body explaining the gate) does not accidentally trip it.
 */
export const FAA_GATE_BYPASS_RE = /^[ \t]*\[faa-gate-bypass:\s*\S[^\]]*\]/im;

export interface FaaMitigationGateInput {
  /** Repo-relative paths of files changed in the range under evaluation. */
  changedFiles: readonly string[];
  /**
   * Free text where a classified cause (or bypass) may be cited: concatenated
   * commit subjects/bodies for the range, plus any PR body.
   */
  citationText: string;
}

export type FaaMitigationGateResult =
  | { inScope: false }
  | { inScope: true; satisfied: true; reason: 'cause_cited' | 'bypass' }
  | { inScope: true; satisfied: false; matchedFiles: string[]; matchedKeyword: string | null };

function isFaaMitigationFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (FAA_MITIGATION_PATH_FRAGMENTS.some((fragment) => lower.includes(fragment))) return true;
  return FAA_MITIGATION_PATH_PATTERNS.some((re) => re.test(path));
}

/** First FAA keyword found in `text`, or null. */
function firstFaaKeyword(text: string): string | null {
  for (const re of FAA_MITIGATION_KEYWORDS) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

/** True when the text cites at least one classified FAA root-cause category. */
export function citesClassifiedCause(text: string): boolean {
  const lower = text.toLowerCase();
  return FAA_ROOT_CAUSES.some((cause) => lower.includes(cause));
}

/**
 * Pure gate decision. A change is in scope when it touches an FAA-mitigation
 * file OR its citation text uses an FAA keyword. When in scope, it is satisfied
 * only if the citation text either cites a classified cause or carries a
 * reasoned bypass marker.
 */
export function evaluateFaaMitigationGate(input: FaaMitigationGateInput): FaaMitigationGateResult {
  const matchedFiles = input.changedFiles.filter(isFaaMitigationFile);
  const matchedKeyword = firstFaaKeyword(input.citationText);
  const inScope = matchedFiles.length > 0 || matchedKeyword !== null;
  if (!inScope) return { inScope: false };

  if (FAA_GATE_BYPASS_RE.test(input.citationText)) {
    return { inScope: true, satisfied: true, reason: 'bypass' };
  }
  if (citesClassifiedCause(input.citationText)) {
    return { inScope: true, satisfied: true, reason: 'cause_cited' };
  }
  return { inScope: true, satisfied: false, matchedFiles, matchedKeyword };
}

// ---------------------------------------------------------------------------
// CLI: gather the git range + PR body, then evaluate.
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Resolve the diff range, mirroring the pre-push hook's origin/main...HEAD form. */
function resolveRange(): string {
  const explicit = process.env.FAA_GATE_RANGE?.trim();
  if (explicit) return explicit;
  try {
    git(['rev-parse', '--verify', '--quiet', 'origin/main']);
    return 'origin/main...HEAD';
  } catch {
    return 'HEAD';
  }
}

export function collectGateInput(range: string): FaaMitigationGateInput {
  let changedFiles: string[] = [];
  let commitText = '';
  try {
    // Three-dot for diff = changes on HEAD since merge-base(origin/main, HEAD) —
    // only this branch's own files.
    changedFiles = git(['diff', '--name-only', range]).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    changedFiles = [];
  }
  try {
    // %B = raw subject + body for every commit in the range. `git log` treats
    // three-dot as SYMMETRIC difference (commits in either side but not both),
    // which would fold upstream commit messages into the citation text and let
    // an unrelated upstream cause token falsely satisfy the gate. Convert to the
    // two-dot form (`origin/main..HEAD`) so only THIS branch's commits count.
    const logRange = range.replace('...', '..');
    commitText = git(['log', '--format=%B', logRange]);
  } catch {
    commitText = '';
  }
  const prBody = process.env.KOOKR_PR_BODY ?? process.env.FAA_GATE_PR_BODY ?? '';
  return { changedFiles, citationText: `${commitText}\n${prBody}` };
}

const CAUSE_LIST = FAA_ROOT_CAUSES.join(', ');

function main(): void {
  const range = resolveRange();
  const input = collectGateInput(range);
  const result = evaluateFaaMitigationGate(input);

  if (!result.inScope) {
    console.log(`[faa-gate] no FAA-mitigation surface touched in ${range} — gate not applicable.`);
    return;
  }
  if (result.satisfied) {
    const how = result.reason === 'bypass' ? 'reasoned bypass marker' : 'classified root cause cited';
    console.log(`[faa-gate] OK for ${range} — ${how}.`);
    return;
  }

  console.error('');
  console.error('Push rejected: FAA-mitigation change without a classified root cause (issue #2142).');
  console.error('');
  if (result.matchedFiles.length > 0) {
    console.error('  FAA-mitigation files changed:');
    for (const f of result.matchedFiles.slice(0, 20)) console.error(`    ${f}`);
  }
  if (result.matchedKeyword) {
    console.error(`  FAA keyword in commits/PR body: ${result.matchedKeyword}`);
  }
  console.error('');
  console.error('  FAA is the harness\'s highest-churn capacity pattern — a stack of downstream');
  console.error('  reclaim/reaper/counter mitigations while the anomaly keeps firing. Before adding');
  console.error('  another, cite which classified cause this targets so we stop paving the symptom.');
  console.error('');
  console.error('  Fix: name one of the /api/health FAA root-cause categories in a commit');
  console.error(`  message or the PR body: ${CAUSE_LIST}.`);
  console.error('  (e.g. a "Root-Cause: ack_sweep_backlog" line naming the dominant cause.)');
  console.error('  Genuinely not a mitigation? Add a reasoned bypass on its own line:');
  console.error('  [faa-gate-bypass: <why>]');
  console.error('');
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
