import { isTerminalStatus, taskSnapshotRecencyMs, type Task } from '../../core/tasks.js';
import { resolveSessionTranscriptPointer } from './transcript-read.js';
import {
  captureTaskTranscript,
  deleteTaskTranscripts,
  hasCompleteSnapshot,
  selectExpiredTranscriptTaskDirs,
  type CaptureOutcome,
  type CaptureParams,
} from './transcript-store.js';
import type { TranscriptCaptureScope } from './transcript-capture-config.js';

export interface TranscriptCaptureSweepDeps {
  tasks: Task[];
  hooksDir: string;
  transcriptsDir: string;
  config: { scope: TranscriptCaptureScope; maxTasksPerTick: number; graceMs?: number };
  /** Caller-supplied filter for scope 'own-repos'. Defaults to allow-all. */
  scopeAllows?: (task: Task) => boolean;
  now?: () => Date;
  capture?: (p: CaptureParams) => Promise<CaptureOutcome>;
  resolvePointer?: (hooksDir: string, tmux: string) => Promise<{ transcriptPath?: string }>;
  hasSnapshot?: (dir: string, taskId: string, sessionId: string) => Promise<boolean>;
}

export interface TranscriptCaptureSweepSummary {
  candidates: number;
  captured: number;
  alreadyCaptured: number;
  vendorAbsent: number;
  errors: number;
}

/**
 * Snapshot vendor transcripts of terminal claude-code tasks. Never throws;
 * per-task failures are counted in `errors`. Oldest-terminal tasks go first.
 * `candidates` is the number of tasks selected this tick (after the cap).
 */
export async function runTranscriptCaptureSweep(
  deps: TranscriptCaptureSweepDeps,
): Promise<TranscriptCaptureSweepSummary> {
  const summary: TranscriptCaptureSweepSummary = {
    candidates: 0, captured: 0, alreadyCaptured: 0, vendorAbsent: 0, errors: 0,
  };
  try {
    if (deps.config.scope === 'off') return summary;
    const now = (deps.now ?? (() => new Date()))();
    const capture = deps.capture ?? captureTaskTranscript;
    const resolvePointer = deps.resolvePointer ?? resolveSessionTranscriptPointer;
    const hasSnapshot = deps.hasSnapshot ?? hasCompleteSnapshot;
    const graceMs = deps.config.graceMs ?? 0;
    const cap = Math.max(0, deps.config.maxTasksPerTick);

    const terminal = deps.tasks
      .filter((t) => isTerminalStatus(t.status) && now.getTime() - taskSnapshotRecencyMs(t) >= graceMs)
      .sort((a, b) => taskSnapshotRecencyMs(a) - taskSnapshotRecencyMs(b));

    for (const task of terminal) {
      if (summary.candidates >= cap) break;
      try {
        if (deps.scopeAllows && !deps.scopeAllows(task)) continue;
        const claudeSessions = task.sessions.filter((s) => s.agentType === 'claude-code');
        if (claudeSessions.length === 0) continue;
        const session = claudeSessions.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
        const { transcriptPath } = await resolvePointer(deps.hooksDir, session.tmuxSession);
        if (!transcriptPath) continue;
        if (await hasSnapshot(deps.transcriptsDir, task.id, session.tmuxSession)) continue;
        summary.candidates++;
        const res = await capture({
          transcriptsDir: deps.transcriptsDir,
          taskId: task.id,
          sessionId: session.tmuxSession,
          vendorTranscriptPath: transcriptPath,
          now: deps.now,
        });
        if (res.outcome === 'captured') summary.captured++;
        else if (res.outcome === 'already_captured') summary.alreadyCaptured++;
        else if (res.outcome === 'vendor_absent') summary.vendorAbsent++;
        else summary.errors++;
      } catch {
        summary.errors++;
      }
    }
  } catch {
    summary.errors++;
  }
  return summary;
}

/** Delete transcript dirs older than the retention window. Best-effort; returns count removed. */
export async function runTranscriptRetentionSweep(
  transcriptsDir: string,
  retentionDays: number,
  now: () => Date = () => new Date(),
): Promise<number> {
  try {
    const expired = await selectExpiredTranscriptTaskDirs(transcriptsDir, retentionDays, now());
    let removed = 0;
    for (const taskId of expired) {
      try {
        await deleteTaskTranscripts(transcriptsDir, taskId);
        removed++;
      } catch {
        // best effort
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
