import { existsSync } from 'node:fs';
import { isTerminalStatus, taskSnapshotRecencyMs, type Task } from '../../core/tasks.js';
import { openCodeDbPathForDataHome } from '../../adapters/opencode-usage-scanner.js';
import { openCodeTaskDataHome, openCodeTaskDir, resolveOpenCodeDataRoot } from '../../adapters/opencode-task-data.js';
import { resolveSessionTranscriptPointer } from './transcript-read.js';
import {
  captureOpenCodeTaskTranscript,
  captureTaskTranscript,
  deleteTaskTranscripts,
  hasCompleteSnapshot,
  selectExpiredTranscriptTaskDirs,
  type CaptureOutcome,
  type CaptureParams,
  type OpenCodeCaptureParams,
} from './transcript-store.js';
import type { TranscriptCaptureScope } from './transcript-capture-config.js';

type TaskSession = Task['sessions'][number];

/**
 * Period of the server's opencode-only capture tick (issue #3537). Far below the opencode data dir's 24h
 * done-TTL, so a finished task is captured (after the capture grace) well before its DB is deleted.
 */
export const OPENCODE_TRANSCRIPT_CAPTURE_INTERVAL_MS = 15 * 60_000;

/** Providers the sweep can snapshot. */
export type CaptureProvider = 'claude-code' | 'opencode';

/**
 * The session whose conversation the sweep snapshots for `task`, and from which source. An opencode task is
 * captured when its newest session is an opencode one: that is the session the transcript route serves, and the
 * snapshot must sit under the key the route reads. Otherwise the newest claude-code session is captured, as
 * before. Shared with the server's 'own-repos' scope check so both look at the same session.
 */
export function selectCaptureSession(task: Task): { session: TaskSession; provider: CaptureProvider } | undefined {
  const sessions = task.sessions ?? [];
  if (sessions.length === 0) return undefined;
  const newest = sessions.reduce((a, b) => (new Date(b.createdAt).getTime() > new Date(a.createdAt).getTime() ? b : a));
  if (newest.agentType === 'opencode') return { session: newest, provider: 'opencode' };
  const claudeSessions = sessions.filter((s) => s.agentType === 'claude-code');
  if (claudeSessions.length === 0) return undefined;
  return { session: claudeSessions.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)), provider: 'claude-code' };
}

/** Path of an opencode task's conversation DB under the opencode data root. */
export function openCodeTaskDbPath(dataRoot: string, taskId: string): string {
  return openCodeDbPathForDataHome(openCodeTaskDataHome(openCodeTaskDir(dataRoot, taskId)));
}

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
  /** Providers to capture this tick; defaults to all. The opencode-only tick passes `['opencode']`. */
  providers?: readonly CaptureProvider[];
  /** opencode per-task data root; defaults to the one the transcript route reads. */
  opencodeDataRoot?: string;
  captureOpenCode?: (p: OpenCodeCaptureParams) => Promise<CaptureOutcome>;
  /** Test seam for the opencode DB existence check. */
  fileExists?: (path: string) => boolean;
}

export interface TranscriptCaptureSweepSummary {
  candidates: number;
  captured: number;
  alreadyCaptured: number;
  vendorAbsent: number;
  errors: number;
}

/**
 * Snapshot the conversations of terminal claude-code tasks (vendor JSONL) and
 * opencode tasks (per-task opencode DB, issue #3537). Never throws; per-task
 * failures are counted in `errors`. Oldest-terminal tasks go first.
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
    const providers = new Set<CaptureProvider>(deps.providers ?? ['claude-code', 'opencode']);
    const captureOpenCode = deps.captureOpenCode ?? captureOpenCodeTaskTranscript;
    const fileExists = deps.fileExists ?? existsSync;
    let opencodeDataRoot = deps.opencodeDataRoot;

    const terminal = deps.tasks
      .filter((t) => isTerminalStatus(t.status) && now.getTime() - taskSnapshotRecencyMs(t) >= graceMs)
      .sort((a, b) => taskSnapshotRecencyMs(a) - taskSnapshotRecencyMs(b));

    for (const task of terminal) {
      if (summary.candidates >= cap) break;
      try {
        if (deps.scopeAllows && !deps.scopeAllows(task)) continue;
        const selected = selectCaptureSession(task);
        if (!selected || !providers.has(selected.provider)) continue;
        const { session } = selected;
        let res: CaptureOutcome;
        if (selected.provider === 'opencode') {
          opencodeDataRoot ??= resolveOpenCodeDataRoot(process.env, deps.hooksDir);
          const dbPath = openCodeTaskDbPath(opencodeDataRoot, task.id);
          // Data dir already swept (or never written): nothing to capture, and no cap slot spent on it.
          if (!fileExists(dbPath)) continue;
          if (await hasSnapshot(deps.transcriptsDir, task.id, session.tmuxSession)) continue;
          summary.candidates++;
          res = await captureOpenCode({
            transcriptsDir: deps.transcriptsDir,
            taskId: task.id,
            sessionId: session.tmuxSession,
            dbPath,
            ...(session.claudeSessionId ? { opencodeSessionId: session.claudeSessionId } : {}),
            now: deps.now,
          });
        } else {
          const { transcriptPath } = await resolvePointer(deps.hooksDir, session.tmuxSession);
          if (!transcriptPath) continue;
          if (await hasSnapshot(deps.transcriptsDir, task.id, session.tmuxSession)) continue;
          summary.candidates++;
          res = await capture({
            transcriptsDir: deps.transcriptsDir,
            taskId: task.id,
            sessionId: session.tmuxSession,
            vendorTranscriptPath: transcriptPath,
            now: deps.now,
          });
        }
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
