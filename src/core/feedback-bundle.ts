import type { Task } from './tasks.js';
import type { InteractionEvent } from './interaction-log.js';
import type { AgentEvent } from './types.js';
import type { AgentState } from '../shared/contracts/agent-state.js';

/**
 * Pure interaction-log slice join: collect all events that touch a given task.
 *
 * The interaction log natively keys substantive events by `agentId` (the dtach
 * session name, equal to `Task.sessions[].sessionId`). Lifecycle events
 * (`task_completed`, `task_terminated`, `task_cancelled`) and the new feedback
 * events also carry `taskId` directly. The slice unions both keys so a
 * multi-session task (crash-recovery relaunches) gets all relevant events.
 *
 * This function is pure — no I/O, no globals. The I/O wrapper that copies hook
 * JSONL and writes the slice to disk lives in
 * `src/server/use-cases/write-feedback-bundle.ts` to keep `core/` free of
 * filesystem dependencies.
 */
export function buildInteractionSlice(task: Task, events: InteractionEvent[]): InteractionEvent[] {
  const sessionIds = new Set(task.sessions.map((s) => s.tmuxSession));
  return events.filter((event) => {
    // Events that carry taskId directly
    if ('taskId' in event && typeof event.taskId === 'string' && event.taskId === task.id) {
      return true;
    }
    // Events keyed by agentId — match against any of this task's session names
    if ('agentId' in event && typeof event.agentId === 'string' && sessionIds.has(event.agentId)) {
      return true;
    }
    return false;
  });
}

/**
 * Shape of `bundle.json` written to disk. Read by the spawned reflect task as data
 * (the skill loads it via the Read tool), NOT interpolated into the spawn prompt
 * as a string. This eliminates the prompt-injection class entirely — `note` is a
 * JSON-encoded field that any LLM consumer treats as untrusted text content.
 *
 * The skill carries `skillSchemaVersion`; bundle.json is just a data dump that
 * any skill version can read field-by-field, so no version field on the bundle.
 */
export interface FeedbackBundle {
  taskId: string;
  rating: 'up' | 'down';
  note?: string;
  downReason?: 'agent_behavior' | 'my_prompt';
  agentType: string;
  taskPrompt: string;
  completionDigest?: { bullets: string[] };
  /** Filenames (relative to the bundle dir) of hook JSONL slices, one per source-task session. */
  hookFiles: string[];
}

export interface TaskSnapshotBundleSession {
  sessionId: string;
  agentType: string;
  cwd: string;
  createdAt: string;
  lastStatus?: string;
  hookFile?: string;
  eventFile: string;
  eventCount: number;
}

export interface TaskSnapshotBundle {
  schemaVersion: 'task-snapshot-reflect.v1';
  taskId: string;
  capturedAt: string;
  trigger: 'manual';
  agentType: string;
  taskStatus: string;
  taskName?: string;
  taskPrompt: string;
  cwd: string;
  criteria?: string;
  /**
   * Optional free-text hint the user typed when clicking Reflect, explaining
   * why they triggered the reflection (e.g. "liked being asked for e2e tests").
   * Untrusted content — the reflect skill reads it as steering context, not as
   * instructions, exactly like the source-task prompt and notes.
   */
  userHint?: string;
  completionDigest?: { bullets: string[] };
  sessions: TaskSnapshotBundleSession[];
  /** Current read-model states for this task's sessions, as seen by the dashboard. */
  agentStates: AgentState[];
  /** Filename (relative to the bundle dir) containing task-related dashboard interactions. */
  interactionFile: string;
}

export type TaskSnapshotSessionEvents = Record<string, AgentEvent[]>;
