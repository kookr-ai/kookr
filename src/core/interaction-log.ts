import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AnomalyType } from './types.js';

// --- Interaction event types ---

export type InteractionEvent =
  | { type: 'user_input'; agentId: string; content: string; timestamp: string }
  | { type: 'agent_selected'; agentId: string; source: 'auto' | 'manual'; timestamp: string }
  | { type: 'finding_skipped'; agentId: string; anomalyType: AnomalyType; timestamp: string }
  | { type: 'finding_snoozed'; agentId: string; durationMs: number; anomalyType?: AnomalyType; timestamp: string }
  | {
      type: 'finding_resolved';
      agentId: string;
      anomalyType: AnomalyType;
      method: 'input' | 'auto_clear' | 'skip' | 'snooze' | 'false_positive';
      durationMs: number;
      timestamp: string;
    }
  | { type: 'agent_launched'; agentId: string; taskPrompt: string; timestamp: string }
  | { type: 'agent_stopped'; agentId: string; reason: 'user' | 'completed' | 'error'; timestamp: string }
  | { type: 'task_completed'; taskId: string; agentId: string; reason: 'user_marked' | 'user_acked_terminated'; durationMs: number; timestamp: string }
  | { type: 'task_terminated'; taskId: string; agentId: string; reason: 'sessions_died'; durationMs: number; timestamp: string }
  | { type: 'task_cancelled'; taskId: string; agentId: string; reason: 'user_cancelled'; durationMs: number; timestamp: string }
  | { type: 'reflect_triggered'; timestamp: string }
  | { type: 'worktree_cleaned'; taskId: string; worktreePath: string; branch: string | undefined; timestamp: string }
  | { type: 'worktree_kept'; taskId: string; worktreePath: string; branch: string | undefined; reason: string; timestamp: string }
  | { type: 'worktree_skipped'; taskId: string; worktreePath: string; reason: 'protected' | 'shared' | 'task reopened' | 'not found'; timestamp: string }
  | { type: 'worktree_cleanup_failed'; taskId: string; worktreePath: string; error: string; timestamp: string }
  | { type: 'crash_recovery'; relaunched: number; skipped: number; failed: number; details: unknown; timestamp: string }
  | { type: 'submission_rejected_dedup'; existingTaskId: string; promptHash: string; canonicalCwd: string; timestamp: string }
  | { type: 'auto_suppressed'; agentId: string; anomalyType: AnomalyType; suppressionCount: number; timestamp: string }
  | { type: 'monitoring_resumed'; agentId: string; reason: 'respond' | 'cleanup'; timestamp: string }
  | { type: 'finding_feedback'; agentId: string; anomalyType: AnomalyType; verdict: 'false_positive'; explanation: string; timestamp: string }
  | {
      type: 'task_feedback_submitted';
      taskId: string;
      agentId: string;
      rating: 'up' | 'down';
      note?: string;
      downReason?: 'agent_behavior' | 'my_prompt';
      timestamp: string;
    }
  | {
      type: 'task_feedback_amended';
      taskId: string;
      agentId: string;
      rating: 'up' | 'down';
      note?: string;
      downReason?: 'agent_behavior' | 'my_prompt';
      timestamp: string;
    }
  | {
      type: 'ralph_prompt_updated';
      taskId: string;
      status: 'running' | 'paused';
      previousPrompt: string;
      prompt: string;
      timestamp: string;
    }
  | {
      type: 'ralph_loop_replaced';
      replacedTaskId: string;
      newTaskId: string;
      oldIteration: number;
      playbookPath: string;
      cwd: string;
      source: 'cli' | 'ui' | 'api';
      timestamp: string;
    }
  // --- Ralph stall-handling events (rfc-ralph-loop-stall-handling.md §9) ---
  | {
      type: 'ralph_verdict_warning';
      taskId: string;
      iteration: number;
      failure: 'symlink' | 'oversize' | 'malformed_json' | 'schema_invalid' | 'iteration_mismatch';
      reason: string;
      timestamp: string;
    }
  | {
      type: 'ralph_predicate_disagree';
      taskId: string;
      iteration: number;
      /** Why the predicate disagreed: clean non-zero exit. */
      predicateExitCode: number;
      timestamp: string;
    }
  | {
      type: 'ralph_burned_targets_modified';
      taskId: string;
      /** Canonicalized targets that actually left the burned list (delta, not input). */
      removed: string[];
      cleared: boolean;
      /** Full snapshot of every burned-out target at the moment of mutation, so the
       *  audit log alone is sufficient to reconstruct prior state during a manual rollback. */
      previousBurnedOutTargets: Array<{
        target: string;
        consecutiveStallCount: number;
        totalStallCount: number;
        firstStalledAtIteration: number;
        lastStallReason: string;
        lastStallBlockers: string[];
        burned: boolean;
        lastAttemptedIteration: number;
      }>;
      actor?: string;
      timestamp: string;
    }
  | {
      type: 'ralph_stale_verdict_unlinked';
      taskId: string;
      path: string;
      iteration: number;
      timestamp: string;
    }
  | {
      type: 'ralph_iteration_cost_warning';
      taskId: string;
      iteration: number;
      costDeltaUsd: number;
      capUsd: number;
      consecutiveStreak: number;
      timestamp: string;
    }
  | {
      type: 'ralph_target_burned';
      taskId: string;
      target: string;
      iteration: number;
      stallCount: number;
      reason: string;
      timestamp: string;
    }
  | {
      type: 'ralph_target_unburned';
      taskId: string;
      target: string;
      iteration: number;
      via: 'progress_verdict' | 'patch_burned_targets' | 'decay';
      timestamp: string;
    };

// --- Substantive event detection ---

/** Events that indicate real agent activity — these trigger session creation. */
const SUBSTANTIVE_EVENT_TYPES: ReadonlySet<InteractionEvent['type']> = new Set([
  'agent_launched',
  'user_input',
  'finding_skipped',
  'finding_snoozed',
  'finding_resolved',
  'finding_feedback',
]);

export function isSubstantiveEvent(event: InteractionEvent): boolean {
  return SUBSTANTIVE_EVENT_TYPES.has(event.type);
}

// --- Writer ---

export class InteractionLogWriter {
  constructor(private filePath: string) {}

  async append(event: InteractionEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf-8');
  }

  getFilePath(): string {
    return this.filePath;
  }
}

// --- Deferred Writer ---

/**
 * Wraps InteractionLogWriter with lazy session creation.
 * The session directory is not created until the first substantive event
 * (agent_launched, user_input, finding). Non-substantive events are buffered
 * and flushed when the session materializes.
 */
export class DeferredInteractionLogWriter {
  private writer: InteractionLogWriter | null = null;
  private buffer: InteractionEvent[] = [];
  private materializePromise: Promise<void> | null = null;

  constructor(
    private sessionsDir: string,
    private resolveSessionId: () => Promise<string>,
  ) {}

  async append(event: InteractionEvent): Promise<void> {
    if (this.writer) {
      await this.writer.append(event);
      return;
    }

    if (isSubstantiveEvent(event)) {
      await this.materialize();
      await this.writer!.append(event);
      return;
    }

    // Buffer non-substantive events until session is created
    this.buffer.push(event);
  }

  /** Force session materialization and flush buffered events. Concurrent calls coalesce. */
  private async materialize(): Promise<void> {
    if (this.writer) return;
    if (this.materializePromise) {
      await this.materializePromise;
      return;
    }

    this.materializePromise = (async () => {
      const sessionId = await this.resolveSessionId();
      const filePath = join(this.sessionsDir, sessionId, 'interactions.jsonl');
      this.writer = new InteractionLogWriter(filePath);

      // Flush buffered events
      for (const buffered of this.buffer) {
        await this.writer.append(buffered);
      }
      this.buffer = [];
    })();

    await this.materializePromise;
  }

  /** Returns the file path, or null if the session hasn't materialized yet. */
  getFilePath(): string | null {
    return this.writer?.getFilePath() ?? null;
  }
}

// --- Reader ---

export async function readInteractionLog(filePath: string): Promise<InteractionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const events: InteractionEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as InteractionEvent);
    } catch {
      // Skip malformed lines
    }
  }
  return events;
}

// --- Timestamp helper ---

export function nowISO(): string {
  return new Date().toISOString();
}
