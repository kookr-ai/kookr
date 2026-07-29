import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { Task } from '../../core/tasks.js';
import {
  buildTaskSpeechActivityLines,
  type TaskSpeechSummaryInput,
} from '../../core/task-speech-summary.js';

export interface TaskSpeechSubject {
  taskId: string;
  agentState?: AgentState;
  task?: Task;
  input: TaskSpeechSummaryInput;
}

export function buildTaskSpeechSubject(opts: {
  taskId: string;
  agents: readonly AgentState[];
  task?: Task;
}): TaskSpeechSubject | null {
  const agentState = opts.agents.find((candidate) => candidate.taskId === opts.taskId);
  const task = opts.task;
  if (!agentState && !task) return null;

  const name = agentState?.taskName ?? task?.name ?? (task ? `Task ${task.id.slice(0, 8)}` : undefined);
  const digest = agentState?.completionDigest ?? task?.completionDigest ?? null;
  const launchWarnings = [
    ...(agentState?.launchHealthSummary?.findings ?? task?.launchHealthSummary?.findings ?? [])
      .map((finding) => finding.summary),
  ];

  return {
    taskId: opts.taskId,
    agentState,
    task,
    input: {
      taskName: name,
      taskStatus: agentState?.taskStatus ?? task?.status,
      turnState: agentState?.turnState ?? null,
      activeFinding: agentState?.anomaly ? {
        type: agentState.anomaly.type,
        severity: agentState.anomaly.severity,
        explanation: agentState.anomaly.explanation,
      } : null,
      completionDigest: digest,
      recentActivity: buildTaskSpeechActivityLines(agentState?.events),
      launchWarnings,
    },
  };
}
