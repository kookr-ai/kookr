/**
 * Diagnose recovery ledgers without invoking the runtime loader or its writers.
 * A damaged ledger can lose cooldown/deduplication history or interrupt refill;
 * doctor reports evidence for an operator to preserve and inspect offline.
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  defaultPipelineStarvationStateDir,
  isValidRepoFullName,
  PIPELINE_STARVATION_STATE_SCHEMA,
  pipelineStarvationStatePath,
} from '../core/pipeline-starvation.js';
import type { DoctorCheck } from './kookr-doctor.js';

/** Inspect at most 100 entries, including ignored files, without listing the whole directory. */
export const PIPELINE_STATE_MAX_ENTRIES = 100;
/** Read at most 256 KiB plus one overflow-detection byte per ledger. */
export const PIPELINE_STATE_MAX_FILE_BYTES = 256 * 1024;

const PRESERVE_ACTION =
  'Preserve cooldown and handled-run history: keep an untouched backup before any operator-led recovery. ' +
  'Inspect the reported path and permissions; do not reset or delete the ledger. ' +
  'See docs/reference/unattended-recovery-runbook.md#3d-pipeline-recovery-state. ' +
  'This advisory does not repair state or launch work.';

function errno(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'unknown error';
}

async function inspectLedger(path: string, name: string): Promise<string | null> {
  try {
    // NOFOLLOW protects against a symlink swap after readdir. NONBLOCK prevents
    // a swapped FIFO from hanging open; fstat rejects all non-regular handles.
    const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return 'unreadable (not a regular file)';
      if (stat.size > PIPELINE_STATE_MAX_FILE_BYTES) return 'file_too_large (byte limit exceeded; not parsed)';
      const buffer = Buffer.alloc(PIPELINE_STATE_MAX_FILE_BYTES + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      // Enforce the cap on actual reads too: the file may grow after fstat.
      if (used > PIPELINE_STATE_MAX_FILE_BYTES) return 'file_too_large (byte limit exceeded; not parsed)';
      raw = buffer.toString('utf8', 0, used);
    } finally {
      await file.close();
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      return 'malformed_json (runtime JSON parsing throws during refill)';
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'unsupported_schema (expected an object; runtime may reject it or load empty history)';
    }
    const state = parsed as Record<string, unknown>;
    if (state.schemaVersion !== PIPELINE_STARVATION_STATE_SCHEMA) {
      return 'unsupported_schema (runtime loads empty history for this schema)';
    }
    if (typeof state.repo !== 'string' || !isValidRepoFullName(state.repo)
      || basename(pipelineStarvationStatePath('', state.repo)) !== name) {
      return 'repository_identity_mismatch (repo is invalid or does not match the filename; runtime accepts foreign repo strings)';
    }
    return null;
  } catch (error) {
    return `unreadable (${errno(error)})`;
  }
}

/** Check JSON, schema and filename identity without validating optional history fields. */
export async function checkPipelineStarvationState(
  stateDir = defaultPipelineStarvationStateDir(),
): Promise<DoctorCheck> {
  const problems: string[] = [];
  let checked = 0;
  let directoryOpened = false;
  try {
    const dir = await fs.opendir(stateDir, { bufferSize: 1 });
    directoryOpened = true;
    let entries = 0;
    for await (const entry of dir) {
      if (entries++ === PIPELINE_STATE_MAX_ENTRIES) {
        problems.push(`scan_limit (stopped after ${PIPELINE_STATE_MAX_ENTRIES} directory entries; coverage incomplete)`);
        break;
      }
      if (!entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      checked++;
      const problem = entry.isFile()
        ? await inspectLedger(join(stateDir, entry.name), entry.name)
        : 'unreadable (not a regular file)';
      if (problem) problems.push(`${JSON.stringify(entry.name)}: ${problem}`);
    }
  } catch (error) {
    if (directoryOpened || errno(error) !== 'ENOENT') problems.push(`directory unreadable (${errno(error)})`);
  }

  const status = problems.length > 0 ? 'warn' : 'ok';
  return {
    id: 'ops.pipeline-starvation-state',
    label: 'Pipeline recovery state',
    category: 'ops',
    required: false,
    status,
    summary: status === 'warn'
      ? `Pipeline recovery state needs inspection (${problems.length} advisories)`
      : checked > 0
        ? `Pipeline recovery state valid (${checked} ledger envelopes checked)`
        : 'Pipeline recovery state absent (no ledgers found)',
    detail: `State directory: ${JSON.stringify(stateDir)}. ` +
      `Limits: ${PIPELINE_STATE_MAX_ENTRIES} entries, ${PIPELINE_STATE_MAX_FILE_BYTES} bytes per file. ` +
      problems.sort().join('; '),
    ...(status === 'warn' ? { recommendedAction: PRESERVE_ACTION } : {}),
  };
}
