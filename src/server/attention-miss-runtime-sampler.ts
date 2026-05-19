import { isActiveStatus, type Task } from '../core/tasks.js';
import {
  sampleAttentionMissWindows,
  type AttentionMissSamplingResult,
  type AttentionMissRecentFindingState,
  type AttentionMissSamplingWindow,
} from '../core/attention-miss-review.js';

export interface RuntimeAttentionMissSamplerOptions {
  maxSamples: number;
  maxPerStratum: number;
}

export interface RuntimeAttentionMissSamplerDeps {
  listTasks: () => Task[];
  hasActiveFinding: (agentId: string) => boolean;
  recentFindingStateFor?: (agentId: string) => AttentionMissRecentFindingState;
  now?: () => Date;
}

export class RuntimeAttentionMissSampler {
  constructor(
    private readonly deps: RuntimeAttentionMissSamplerDeps,
    private readonly options: RuntimeAttentionMissSamplerOptions,
  ) {}

  sampleMissCandidates(): AttentionMissSamplingResult {
    return sampleAttentionMissWindows(
      buildRuntimeAttentionMissWindows(
        this.deps.listTasks(),
        this.deps.hasActiveFinding,
        this.deps.recentFindingStateFor,
        this.deps.now?.() ?? new Date(),
      ),
      this.options,
    );
  }
}

export function buildRuntimeAttentionMissWindows(
  tasks: Task[],
  hasActiveFinding: (agentId: string) => boolean,
  recentFindingStateFor: (agentId: string) => AttentionMissRecentFindingState = () => 'none',
  now: Date = new Date(),
): AttentionMissSamplingWindow[] {
  const nowMs = now.getTime();
  return tasks
    .filter((task) => isActiveStatus(task.status))
    .map((task) => {
      const session = task.sessions.at(-1);
      // Pending tasks can have no terminal session yet; use a stable
      // task-derived pseudo-agent id so they still participate in sampling.
      const agentId = session?.tmuxSession ?? `task-${task.id}`;
      const windowEnd = now.toISOString();
      const lastEventAt = session?.lastEventAt;
      return {
        taskId: task.id,
        agentId,
        taskState: task.status,
        windowStart: new Date(Math.max(0, nowMs - 60_000)).toISOString(),
        windowEnd,
        terminalActivity: terminalActivityFor(lastEventAt, nowMs),
        detectorOpportunity: detectorOpportunityFor(task, session?.lastStatus),
        taskAgeBucket: taskAgeBucketFor(task.createdAt, nowMs),
        recentFindingState: recentFindingStateFor(agentId),
        activeFinding: hasActiveFinding(agentId),
      };
    });
}

function terminalActivityFor(lastEventAt: number | undefined, nowMs: number): AttentionMissSamplingWindow['terminalActivity'] {
  if (lastEventAt === undefined) return 'none';
  const ageMs = Math.max(0, nowMs - lastEventAt);
  if (ageMs <= 60_000) return 'active';
  if (ageMs <= 10 * 60_000) return 'recent';
  return 'none';
}

function detectorOpportunityFor(task: Task, sessionStatus: Task['sessions'][number]['lastStatus'] | undefined): AttentionMissSamplingWindow['detectorOpportunity'] {
  if (task.status === 'pending') return 'low';
  if (task.status !== 'inProgress') return 'none';
  if (sessionStatus === 'running' || sessionStatus === 'stuck' || sessionStatus === 'errored') return 'present';
  return 'low';
}

function taskAgeBucketFor(createdAt: Date, nowMs: number): AttentionMissSamplingWindow['taskAgeBucket'] {
  const ageMs = Math.max(0, nowMs - createdAt.getTime());
  if (ageMs < 5 * 60_000) return 'new';
  if (ageMs < 60 * 60_000) return 'established';
  return 'long_running';
}
