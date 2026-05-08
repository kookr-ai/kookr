import { lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import type { RalphIterationVerdict } from '../shared/contracts/ralph-iteration-log.js';
export type { RalphIterationVerdict } from '../shared/contracts/ralph-iteration-log.js';

/**
 * Verdict-file IO for the Ralph stall-handling channel. See
 * `docs/rfc/rfc-ralph-loop-stall-handling.md` §1.
 *
 * The agent writes a JSON document to `$RALPH_VERDICT_FILE` (an absolute path
 * the engine sets per iteration). The engine reads it once after Stop, then
 * deletes it. Cross-iteration carryover is also closed at the launch side
 * via `unlinkVerdictFile` before each iteration.
 *
 * Defenses:
 * - Symlink attack: `lstat` (not `stat`) before allocating any read buffer;
 *   reject if the path is a symlink. Read uses `O_NOFOLLOW`.
 * - Oversize payload: `lstat` reports size before any bytes are loaded; we
 *   refuse anything beyond `MAX_VERDICT_FILE_BYTES`.
 * - Cross-iteration leakage: schema requires `iteration: number` matching
 *   the current loop iteration; mismatch is treated as malformed.
 * - Partial write / parse failure: caller treats `null` as "no signal" and
 *   continues with legacy `continued` semantics. The engine bumps a warning
 *   counter (handled at the call site).
 */

export const MAX_VERDICT_FILE_BYTES = 16 * 1024;

/**
 * Default path for the verdict file: `<task.cwd>/.ralph-verdict-<taskIdShort>.json`.
 * Uses 12 hex chars from the task id for the suffix so collisions among
 * concurrent loops in the same workdir are statistically negligible (~1 in
 * 4×10^14 per pair). Two concurrent loops in the same cwd would each get a
 * distinct file.
 */
export function defaultVerdictPath(taskCwd: string, taskId: string): string {
  const short = taskId.slice(0, 12);
  return resolve(taskCwd, `.ralph-verdict-${short}.json`);
}

export type VerdictReadFailure =
  | 'missing'
  | 'symlink'
  | 'oversize'
  | 'malformed_json'
  | 'schema_invalid'
  | 'iteration_mismatch';

export interface VerdictReadResult {
  /** The parsed verdict, or null if reading failed for any reason. */
  verdict: RalphIterationVerdict | null;
  /** When verdict is null, the failure category. Used for operability counters. */
  failure: VerdictReadFailure | null;
  /** Free-form description for `lastVerdictWarningReason`. */
  reason: string | null;
}

/**
 * Read the verdict file at `path`, validating size + schema + iteration tag.
 * Does NOT delete the file — caller decides when to unlink (typically after
 * the read). Returns `{ verdict: null, failure: 'missing' }` if the file is
 * absent (no warning condition).
 */
export async function readVerdictFile(
  path: string,
  expectedIteration: number,
): Promise<VerdictReadResult> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (err) {
    if (isMissingFileError(err)) {
      return { verdict: null, failure: 'missing', reason: null };
    }
    throw err;
  }

  if (stats.isSymbolicLink()) {
    return {
      verdict: null,
      failure: 'symlink',
      reason: 'verdict file is a symlink (rejected)',
    };
  }

  if (!stats.isFile()) {
    return {
      verdict: null,
      failure: 'schema_invalid',
      reason: 'verdict path is not a regular file',
    };
  }

  if (stats.size > MAX_VERDICT_FILE_BYTES) {
    return {
      verdict: null,
      failure: 'oversize',
      reason: `verdict file exceeds ${MAX_VERDICT_FILE_BYTES} bytes (${stats.size})`,
    };
  }

  // Open with O_NOFOLLOW so a concurrent symlink swap can't redirect the read.
  // Combined with the lstat check, this gives belt-and-suspenders coverage.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(stats.size);
    await handle.read(buf, 0, stats.size, 0);
    const text = buf.toString('utf-8');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        verdict: null,
        failure: 'malformed_json',
        reason: 'verdict file is not valid JSON',
      };
    }

    if (!isValidVerdict(parsed)) {
      return {
        verdict: null,
        failure: 'schema_invalid',
        reason: 'verdict file does not match the expected schema',
      };
    }

    if (parsed.iteration !== expectedIteration) {
      return {
        verdict: null,
        failure: 'iteration_mismatch',
        reason: `verdict iteration ${parsed.iteration} does not match expected ${expectedIteration}`,
      };
    }

    return { verdict: parsed, failure: null, reason: null };
  } finally {
    await handle.close();
  }
}

/**
 * Delete the verdict file. Idempotent — silently ignores ENOENT. The engine
 * MUST call this before every iteration launch (every code path that bumps
 * `loop.currentIteration`) to close cross-iteration carryover by construction.
 */
export async function unlinkVerdictFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if (isMissingFileError(err)) return;
    throw err;
  }
}

/**
 * Returns the canonicalized form of a target string: trim, lowercase, strip
 * leading `#`, then Unicode-normalize to NFC. NFC matters when an agent emits
 * one composition form (e.g. `é` U+00E9) on iteration 1 and the decomposed
 * form (`e` + U+0301) on iteration 2 — without normalization those are
 * different keys and the burn counter never accrues. See RFC §3.
 */
export function canonicalizeTarget(raw: string): string {
  return raw.trim().toLowerCase().replace(/^#/, '').normalize('NFC');
}

function isValidVerdict(value: unknown): value is RalphIterationVerdict {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.iteration !== 'number' || !Number.isInteger(obj.iteration)) return false;
  switch (obj.verdict) {
    case 'progress':
      return (obj.target === undefined || typeof obj.target === 'string')
        && (obj.reason === undefined || typeof obj.reason === 'string');
    case 'complete':
      return obj.reason === undefined || typeof obj.reason === 'string';
    case 'stalled':
      if (typeof obj.target !== 'string' || obj.target.length === 0) return false;
      if (typeof obj.reason !== 'string') return false;
      if (obj.blockers !== undefined) {
        if (!Array.isArray(obj.blockers)) return false;
        if (!obj.blockers.every((b) => typeof b === 'string')) return false;
      }
      if (obj.permanent !== undefined && typeof obj.permanent !== 'boolean') return false;
      return true;
    default:
      return false;
  }
}

function isMissingFileError(err: unknown): boolean {
  return err !== null
    && typeof err === 'object'
    && 'code' in err
    && (err as { code?: unknown }).code === 'ENOENT';
}
