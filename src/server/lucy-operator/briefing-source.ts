/**
 * Where the briefing Lucy writes to the operator gets its facts in the running server: the task
 * list, the findings waiting on the operator, and the questions tasks asked (`kookr ask`).
 *
 * It reads the same records, through the same `operatorAttention`, as her board and the hands-free
 * status, so all three agree on which tasks wait and why. This file only reads and maps; the
 * sentences are written in `core/lucy-operator/operator-briefing.ts`.
 */

import type { OperatorAskView } from '../../shared/contracts/asks.js';
import { operatorAttention, type AttentionFinding } from '../../core/lucy-operator/attention.js';
import type { OperatorBriefingInput, OperatorBriefingTask } from '../../core/lucy-operator/operator-briefing.js';
import type { LookTask } from './look-source.js';

function toMs(value: Date | string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export function operatorBriefingInput(
  tasks: readonly LookTask[],
  findings: readonly AttentionFinding[],
  asks: readonly OperatorAskView[],
): OperatorBriefingInput {
  return {
    tasks: tasks.map((task): OperatorBriefingTask => {
      const attention = operatorAttention(task, findings);
      const endedAt = toMs(task.finishedAt) ?? toMs(task.terminatedAt);
      return {
        id: task.id,
        ...(task.name !== undefined ? { name: task.name } : {}),
        status: task.status,
        ...(attention ? { attention: attention.kind } : {}),
        ...(endedAt !== undefined ? { endedAt } : {}),
      };
    }),
    asks,
  };
}
