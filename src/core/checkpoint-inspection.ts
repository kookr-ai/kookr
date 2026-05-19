import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CHECKPOINT_JSON_FILENAME,
  CHECKPOINT_MARKDOWN_FILENAME,
  MEMORY_WRITE_CANDIDATES_FILENAME,
  MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION,
  SEMANTIC_CHECKPOINT_SCHEMA_VERSION,
  type MemoryWriteCandidatesInspection,
  type SemanticCheckpointInspection,
  type SemanticCheckpointVerdict,
} from './checkpoint-contracts.js';

const REQUIRED_ARRAY_FIELDS = [
  'decisions',
  'evidence',
  'files_changed',
  'tests_run',
  'open_risks',
  'next_actions',
  'memory_write_candidates',
] as const;

const VALID_VERDICTS = new Set<SemanticCheckpointVerdict>([
  'in_progress',
  'blocked',
  'stalled',
  'complete',
]);

const VALID_VERIFIER_STATUSES = new Set(['unverified', 'passed', 'failed']);
const VALID_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const VALID_LIFECYCLE_STATUSES = new Set([
  'proposed',
  'ready_for_review',
  'promoted',
  'rejected',
  'superseded',
]);

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function validateSemanticCheckpoint(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'root must be an object';
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== SEMANTIC_CHECKPOINT_SCHEMA_VERSION) {
    return `schema_version must be ${SEMANTIC_CHECKPOINT_SCHEMA_VERSION}`;
  }
  for (const field of ['task_id', 'repo', 'worktree', 'branch'] as const) {
    if (typeof record[field] !== 'string' || record[field].trim() === '') {
      return `${field} must be a non-empty string`;
    }
  }
  if (typeof record.verdict !== 'string' || !VALID_VERDICTS.has(record.verdict as SemanticCheckpointVerdict)) {
    return 'verdict must be one of in_progress, blocked, stalled, complete';
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(record[field])) {
      return `${field} must be an array`;
    }
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyString(record: Record<string, unknown>, field: string): boolean {
  return typeof record[field] === 'string' && record[field].trim() !== '';
}

function validateMemoryWriteCandidates(value: unknown): string | null {
  if (!isPlainRecord(value)) {
    return 'root must be an object';
  }
  if (value.schema_version !== MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION) {
    return `schema_version must be ${MEMORY_WRITE_CANDIDATES_SCHEMA_VERSION}`;
  }
  if (!Array.isArray(value.candidates)) {
    return 'candidates must be an array';
  }

  for (const [index, candidate] of value.candidates.entries()) {
    if (!isPlainRecord(candidate)) {
      return `candidates[${index}] must be an object`;
    }
    if (!hasNonEmptyString(candidate, 'id')) {
      return `candidates[${index}].id must be a non-empty string`;
    }
    if (!isPlainRecord(candidate.target)) {
      return `candidates[${index}].target must be an object`;
    }
    if (!Array.isArray(candidate.evidence)) {
      return `candidates[${index}].evidence must be an array`;
    }
    if (!isPlainRecord(candidate.verifier) || typeof candidate.verifier.status !== 'string') {
      return `candidates[${index}].verifier.status must be a string`;
    }
    if (!VALID_VERIFIER_STATUSES.has(candidate.verifier.status)) {
      return `candidates[${index}].verifier.status must be one of unverified, passed, failed`;
    }
    if (!isPlainRecord(candidate.approval) || typeof candidate.approval.status !== 'string') {
      return `candidates[${index}].approval.status must be a string`;
    }
    if (!VALID_APPROVAL_STATUSES.has(candidate.approval.status)) {
      return `candidates[${index}].approval.status must be one of pending, approved, rejected`;
    }
    if (!isPlainRecord(candidate.lifecycle)) {
      return `candidates[${index}].lifecycle must be an object`;
    }
    if (typeof candidate.lifecycle.status !== 'string') {
      return `candidates[${index}].lifecycle.status must be a string`;
    }
    if (!VALID_LIFECYCLE_STATUSES.has(candidate.lifecycle.status)) {
      return `candidates[${index}].lifecycle.status must be one of proposed, ready_for_review, promoted, rejected, superseded`;
    }
    if (!hasNonEmptyString(candidate.lifecycle, 'created_at')) {
      return `candidates[${index}].lifecycle.created_at must be a non-empty string`;
    }
    if (!isPlainRecord(candidate.promotion)) {
      return `candidates[${index}].promotion must be an object`;
    }
  }

  return null;
}

/**
 * Inspect checkpoint files in a fail-open way. JSON errors become warning
 * metadata and Markdown fallback; callers must never let checkpoint state
 * prevent an agent launch.
 */
export async function inspectSemanticCheckpoint(checkpointDir: string): Promise<SemanticCheckpointInspection> {
  const jsonPath = join(checkpointDir, CHECKPOINT_JSON_FILENAME);
  const markdownPath = join(checkpointDir, CHECKPOINT_MARKDOWN_FILENAME);

  const hasMarkdown = await fileExists(markdownPath);
  const hasJson = await fileExists(jsonPath);
  if (!hasJson) {
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_missing' }
      : { kind: 'none', reason: 'no_checkpoint_files' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(jsonPath, 'utf-8'));
  } catch (err) {
    const warning = `Invalid semantic checkpoint JSON at ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`;
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_unreadable', warning }
      : { kind: 'none', reason: 'json_unreadable', warning };
  }

  const validationError = validateSemanticCheckpoint(parsed);
  if (validationError) {
    const warning = `Invalid semantic checkpoint JSON at ${jsonPath}: ${validationError}`;
    return hasMarkdown
      ? { kind: 'markdown', markdownPath, reason: 'json_invalid', warning }
      : { kind: 'none', reason: 'json_invalid', warning };
  }

  return { kind: 'json', jsonPath, markdownPath };
}

/**
 * Inspect the review-only memory candidate sidecar. This is intentionally
 * fail-open: malformed candidate files are warnings, never launch blockers,
 * and Kookr never promotes their contents automatically.
 */
export async function inspectMemoryWriteCandidates(checkpointDir: string): Promise<MemoryWriteCandidatesInspection> {
  const path = join(checkpointDir, MEMORY_WRITE_CANDIDATES_FILENAME);
  if (!(await fileExists(path))) {
    return { kind: 'missing', path };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    return {
      kind: 'invalid',
      path,
      warning: `Invalid memory write candidates JSON at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validationError = validateMemoryWriteCandidates(parsed);
  if (validationError) {
    return {
      kind: 'invalid',
      path,
      warning: `Invalid memory write candidates JSON at ${path}: ${validationError}`,
    };
  }

  return { kind: 'valid', path };
}
