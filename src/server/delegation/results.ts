import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  TRIAGE_PRIORITIES,
  TRIAGE_RISKS,
  TRIAGE_SIZES,
  TRIAGE_TYPES,
  type TriageVerdict,
} from './store.js';

/**
 * Result contract for `kind: triage` (RFC section 10, "Result contract").
 *
 * Plain-language summary: the worker must answer with ONE JSON object shaped like the
 * schema below. We accept that object bare or wrapped in a single ```json fence (models
 * add one habitually), and nothing else: no prose before or after, no second object, no
 * "fixing" of near-misses. Anything that does not match is `invalid_result` and is never
 * partially applied. The worker's text is untrusted, so the strictness is the defence.
 *
 * Cited file paths are then checked against the immutable snapshot the worker read. The
 * worker's outbound text can be redacted or hallucinated, so a path that does not exist
 * is dropped with a recorded warning. If the worker cited paths and NONE exist, the
 * whole verdict is rejected: a verdict whose evidence is entirely invented is not
 * trustworthy enough to keep (choice recorded in the PR description).
 */

export const TRIAGE_RESULT_VERSION = 'triage-result-v1';

const MAX_LIST = 50;
const shortText = (max: number) => z.string().max(max);

export const triageVerdictSchema = z.object({
  type: z.enum(TRIAGE_TYPES),
  priority: z.enum(TRIAGE_PRIORITIES),
  size: z.enum(TRIAGE_SIZES),
  ready_to_implement: z.boolean(),
  needs_info: z.array(shortText(500)).max(MAX_LIST),
  related_issues: z.array(z.union([z.number().int().nonnegative(), shortText(100)])).max(MAX_LIST),
  risk: z.enum(TRIAGE_RISKS),
  files_likely_touched: z.array(shortText(500)).max(MAX_LIST),
  summary: shortText(4000),
  recommended_next_step: shortText(2000),
});

export type ResultFailure = { ok: false; reason: string };
export type ResultSuccess = { ok: true; verdict: TriageVerdict; warnings: string[] };

const FENCE_RE = /^```(?:json|JSON)[ \t]*\r?\n([\s\S]*?)\r?\n```$/;

/** Strip at most one surrounding ```json fence. Everything else is left alone. */
export function stripSingleJsonFence(text: string): string {
  const trimmed = text.trim();
  const m = FENCE_RE.exec(trimmed);
  return m ? m[1]!.trim() : trimmed;
}

/** Syntax and schema validation only (no filesystem access). */
export function parseTriageReply(text: string): { ok: true; verdict: TriageVerdict } | ResultFailure {
  let json: unknown;
  try {
    json = JSON.parse(stripSingleJsonFence(text));
  } catch {
    return { ok: false, reason: 'reply is not a single JSON object' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: 'reply is not a single JSON object' };
  }
  const parsed = triageVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: `reply does not match the triage schema (${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid'})`,
    };
  }
  return { ok: true, verdict: parsed.data };
}

/**
 * Is `cited` a regular file or directory that exists inside `snapshotDir`?
 * Rejects absolute paths, `..` traversal, and symlinks that resolve outside the snapshot
 * (a tracked symlink could otherwise make us "confirm" a path on the host).
 */
export async function pathExistsInSnapshot(snapshotDir: string, cited: string): Promise<boolean> {
  const clean = cited.trim().replace(/^\.\//, '');
  if (!clean || clean.includes('\0') || isAbsolute(clean)) return false;
  const normalized = normalize(clean);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return false;
  const full = join(snapshotDir, normalized);
  try {
    await lstat(full);
    const [realRoot, realFull] = await Promise.all([realpath(snapshotDir), realpath(full)]);
    const rel = relative(realRoot, realFull);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Validate a triage reply end to end: syntax, schema, then cited paths against the
 * snapshot. Non-existent paths are dropped with a warning; if every cited path is
 * bogus the result is a failure.
 */
export async function validateTriageResult(
  replyText: string,
  snapshotDir: string,
): Promise<ResultSuccess | ResultFailure> {
  const parsed = parseTriageReply(replyText);
  if (!parsed.ok) return parsed;
  const verdict = parsed.verdict;
  const warnings: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const p of verdict.files_likely_touched) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (await pathExistsInSnapshot(snapshotDir, p)) kept.push(p);
    else warnings.push(`dropped files_likely_touched entry that does not exist in the snapshot: ${JSON.stringify(p.slice(0, 200))}`);
  }
  if (seen.size > 0 && kept.length === 0) {
    return { ok: false, reason: `none of the ${seen.size} cited file path(s) exist in the snapshot` };
  }
  return { ok: true, verdict: { ...verdict, files_likely_touched: kept }, warnings };
}
