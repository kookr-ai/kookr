import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '../../core/tasks.js';
import type { InteractionEvent } from '../../core/interaction-log.js';
import {
  buildInteractionSlice,
  type TaskSnapshotBundle,
  type TaskSnapshotSessionEvents,
} from '../../core/feedback-bundle.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';

export interface WriteTaskSnapshotBundleDeps {
  /** Where snapshot bundle dirs live. Typically `<kookrDir>/task-snapshots`. */
  taskSnapshotDir: string;
  /** Where hook JSONL files live. Typically `<kookrDir>/hooks`. */
  hooksDir: string;
  /** Reads the current full interaction log at click time. */
  readInteractionLog: () => Promise<InteractionEvent[]>;
  /** Current dashboard read-model states for this task's sessions. */
  agentStates: AgentState[];
  /** Raw monitor events keyed by session id. */
  sessionEvents: TaskSnapshotSessionEvents;
}

export interface WriteTaskSnapshotBundleResult {
  bundlePath: string;
  bundleId: string;
}

export async function writeTaskSnapshotBundle(
  task: Task,
  deps: WriteTaskSnapshotBundleDeps,
): Promise<WriteTaskSnapshotBundleResult> {
  const bundleId = nowBundleId();
  const bundlePath = join(deps.taskSnapshotDir, task.id, bundleId);
  await mkdir(bundlePath, { recursive: true });

  const sessions: TaskSnapshotBundle['sessions'] = [];
  for (const session of task.sessions) {
    const eventFile = `agent-events-${session.tmuxSession}.json`;
    const events = deps.sessionEvents[session.tmuxSession] ?? [];
    await writeFile(join(bundlePath, eventFile), JSON.stringify(events, null, 2), 'utf-8');

    let hookFile: string | undefined;
    const hookSrc = join(deps.hooksDir, `${session.tmuxSession}.jsonl`);
    try {
      await access(hookSrc);
      hookFile = `hook-${session.tmuxSession}.jsonl`;
      await copyFile(hookSrc, join(bundlePath, hookFile));
    } catch {
      // Hook file may already have been swept or not yet created. The snapshot
      // still carries monitor events and interaction-log context.
    }

    sessions.push({
      sessionId: session.tmuxSession,
      agentType: session.agentType,
      cwd: session.cwd,
      createdAt: session.createdAt.toISOString(),
      ...(session.lastStatus !== undefined ? { lastStatus: session.lastStatus } : {}),
      ...(hookFile !== undefined ? { hookFile } : {}),
      eventFile,
      eventCount: events.length,
    });
  }

  const interactionSlice = buildInteractionSlice(task, await deps.readInteractionLog());
  const interactionFile = 'interaction-slice.jsonl';
  await writeFile(
    join(bundlePath, interactionFile),
    interactionSlice.map((event) => JSON.stringify(event)).join('\n') + (interactionSlice.length ? '\n' : ''),
    'utf-8',
  );

  const bundle: TaskSnapshotBundle = {
    schemaVersion: 'task-snapshot-reflect.v1',
    taskId: task.id,
    capturedAt: new Date().toISOString(),
    trigger: 'manual',
    agentType: task.agentType,
    taskStatus: task.status,
    ...(task.name !== undefined ? { taskName: task.name } : {}),
    taskPrompt: task.prompt,
    cwd: task.cwd,
    ...(task.criteria !== undefined ? { criteria: task.criteria } : {}),
    ...(task.completionDigest ? { completionDigest: { bullets: task.completionDigest.bullets } } : {}),
    sessions,
    agentStates: deps.agentStates,
    interactionFile,
  };

  await writeFile(join(bundlePath, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf-8');

  return { bundlePath, bundleId };
}

function nowBundleId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
