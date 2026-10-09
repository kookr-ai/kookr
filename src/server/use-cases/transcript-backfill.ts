import { readdir } from 'node:fs/promises';
import { resolveSessionTranscriptPointer } from './transcript-read.js';
import {
  captureTaskTranscript,
  hasCompleteSnapshot,
  type CaptureOutcome,
  type CaptureParams,
} from './transcript-store.js';

export interface TranscriptBackfillDeps {
  hooksDir: string;
  transcriptsDir: string;
  maxTasks?: number;
  now?: () => Date;
  /** Default: readdir(hooksDir), `<tmux>.jsonl` names without the extension. */
  listSessionLedgers?: (hooksDir: string) => Promise<string[]>;
  /**
   * Attributes a session (tmux name) to its owning task id. Returning
   * undefined means "cannot attribute": the session is skipped, since
   * snapshots are keyed by taskId. The wiring resolves attribution from the
   * hot task store only; sessions whose task was archived/pruned cannot be
   * attributed and are counted as skipped.
   */
  taskIdForSession?: (tmux: string) => string | undefined;
  resolvePointer?: (hooksDir: string, tmux: string) => Promise<{ transcriptPath?: string }>;
  hasSnapshot?: (dir: string, taskId: string, sessionId: string) => Promise<boolean>;
  capture?: (p: CaptureParams) => Promise<CaptureOutcome>;
}

export interface TranscriptBackfillSummary {
  scanned: number;
  captured: number;
  skipped: number;
  errors: number;
}

async function defaultListLedgers(hooksDir: string): Promise<string[]> {
  const names = await readdir(hooksDir);
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length)).sort();
}

/** One-shot, idempotent, bounded backfill of existing sessions. Never throws. */
export async function runTranscriptBackfill(deps: TranscriptBackfillDeps): Promise<TranscriptBackfillSummary> {
  const summary: TranscriptBackfillSummary = { scanned: 0, captured: 0, skipped: 0, errors: 0 };
  const capture = deps.capture ?? captureTaskTranscript;
  const resolvePointer = deps.resolvePointer ?? resolveSessionTranscriptPointer;
  const hasSnapshot = deps.hasSnapshot ?? hasCompleteSnapshot;
  const max = deps.maxTasks ?? Infinity;

  let sessions: string[];
  try {
    sessions = await (deps.listSessionLedgers ?? defaultListLedgers)(deps.hooksDir);
  } catch {
    return summary;
  }

  for (const tmux of sessions) {
    if (summary.captured >= max) break;
    summary.scanned++;
    try {
      const taskId = deps.taskIdForSession?.(tmux);
      if (!taskId) { summary.skipped++; continue; }
      const { transcriptPath } = await resolvePointer(deps.hooksDir, tmux);
      if (!transcriptPath) { summary.skipped++; continue; }
      if (await hasSnapshot(deps.transcriptsDir, taskId, tmux)) { summary.skipped++; continue; }
      const res = await capture({
        transcriptsDir: deps.transcriptsDir,
        taskId,
        sessionId: tmux,
        vendorTranscriptPath: transcriptPath,
        now: deps.now,
      });
      if (res.outcome === 'captured') summary.captured++;
      else if (res.outcome === 'invalid_id') summary.errors++;
      else summary.skipped++;
    } catch {
      summary.errors++;
    }
  }
  return summary;
}
