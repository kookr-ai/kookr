import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * CI guard: prevents new direct callers of `Monitor.getSnapshot()` from being
 * added without explicit classification. New callers must decide whether they
 * need projected-for-client events or raw events, document that in the audit
 * table of docs/rfc/rfc-snapshot-payload-slimming.md, and add themselves to
 * APPROVED_DIRECT_CALLERS below.
 *
 * If this test fails after adding a new caller, the right question is:
 *   "Should this caller use getSnapshotAgentsForClient, getSnapshotAgentsRaw,
 *    or direct monitor.getSnapshot() access — and why?"
 *
 * Only add to APPROVED_DIRECT_CALLERS after answering that question.
 */

// Files allowed to call monitor.getSnapshot() directly. Each entry is a
// relative path from the repo root. Test files are always allowed.
const APPROVED_DIRECT_CALLERS = new Set<string>([
  // Snapshot assembly — wraps the call and produces both ForClient and Raw variants.
  'src/server/use-cases/get-snapshot.ts',
  // Permission-action state lookup; reads anomaly/agentId only (no events).
  'src/server/ws-handlers/anomaly-handler.ts',
  // Autonomy decisions read the raw event window.
  'src/server/autonomy-orchestrator.ts',
  // Auto-proceed reads anomaly/tokenUsage (no events).
  'src/server/auto-proceed.ts',
  // State diffing in the event-processing pipeline.
  'src/server/event-pipeline.ts',
]);

function repoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
}

function findDirectCallers(): string[] {
  const root = repoRoot();
  let output = '';
  try {
    output = execSync(
      `git -C "${root}" grep -l -E 'monitor\\.getSnapshot\\(\\)' -- 'src/**/*.ts' ':!src/**/*.test.ts'`,
      { encoding: 'utf-8' },
    );
  } catch (err: unknown) {
    // git grep exits non-zero when no matches found; that's fine.
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return [];
    throw err;
  }
  return output.split('\n').filter((line) => line.length > 0);
}

describe('approved callers of Monitor.getSnapshot()', () => {
  it('no direct callers outside the approved set', () => {
    const callers = findDirectCallers();
    const unexpected = callers.filter((path) => !APPROVED_DIRECT_CALLERS.has(path));
    if (unexpected.length > 0) {
      throw new Error(
        `New direct caller(s) of monitor.getSnapshot() found:\n` +
        unexpected.map((p) => `  - ${p}`).join('\n') +
        `\n\nClassify each caller (ForClient vs Raw) and update the audit table in ` +
        `docs/rfc/rfc-snapshot-payload-slimming.md, then add to APPROVED_DIRECT_CALLERS ` +
        `in ${resolve(__filename)}.`
      );
    }
    expect(unexpected).toEqual([]);
  });

  it('every approved caller actually exists and still contains the call', () => {
    const root = repoRoot();
    for (const path of APPROVED_DIRECT_CALLERS) {
      const full = resolve(root, path);
      let content: string;
      try {
        content = readFileSync(full, 'utf-8');
      } catch {
        throw new Error(
          `APPROVED_DIRECT_CALLERS lists ${path} but the file does not exist. ` +
          `Remove the stale entry.`
        );
      }
      if (!/monitor\.getSnapshot\(\)/.test(content)) {
        throw new Error(
          `APPROVED_DIRECT_CALLERS lists ${path} but it no longer calls ` +
          `monitor.getSnapshot(). Remove the stale entry.`
        );
      }
    }
  });
});
