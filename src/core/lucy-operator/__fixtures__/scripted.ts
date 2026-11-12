/**
 * Test doubles for the Lucy operator loop: a model that replays a script, and a look
 * source that counts what was asked of it.
 */

import type { LucyBoardInput, LucyBoardTask } from '../board.js';
import { LucyModelError, type LucyModelEvent, type LucyModelPort, type LucyModelRequest } from '../model-port.js';
import type { LucyLookSource, LucyTaskDetail, LucyTaskOutput } from '../tools.js';

/** One scripted model call: say some text, ask for look-ups, or fail. */
export interface ScriptedStep {
  text?: string | string[];
  calls?: Array<{ name: string; args?: unknown; rawArguments?: string; id?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number | null };
  provider?: string;
  /** Throw this instead of finishing. */
  fail?: LucyModelError;
  /** Wait until the request is aborted, then throw `aborted` (a model that never answers). */
  hang?: boolean;
  /** Runs before the step yields anything, e.g. to move a fake clock. */
  before?: () => void;
}

export interface ScriptedModel {
  port: LucyModelPort;
  /** Every request the loop made, in order. */
  requests: LucyModelRequest[];
}

export function scriptedModel(steps: readonly ScriptedStep[]): ScriptedModel {
  const requests: LucyModelRequest[] = [];
  let index = 0;
  const port: LucyModelPort = (request) => {
    requests.push({ ...request, messages: [...request.messages] });
    const step = steps[index++];
    return (async function* (): AsyncGenerator<LucyModelEvent, void, void> {
      if (!step) throw new Error(`the script has no step ${index}`);
      step.before?.();
      if (step.hang) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new LucyModelError('aborted', 'aborted by caller');
      }
      for (const delta of Array.isArray(step.text) ? step.text : step.text ? [step.text] : []) yield { type: 'text', delta };
      if (step.fail) throw step.fail;
      for (const [i, call] of (step.calls ?? []).entries()) {
        yield {
          type: 'tool_call',
          call: { id: call.id ?? `call_${index}_${i}`, name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.args ?? {}) },
        };
      }
      yield {
        type: 'finish',
        finishReason: step.calls?.length ? 'tool_calls' : 'stop',
        usage: { inputTokens: step.usage?.inputTokens ?? 100, outputTokens: step.usage?.outputTokens ?? 20, costUsd: step.usage?.costUsd === undefined ? 0.0001 : step.usage.costUsd },
        ...(step.provider ? { provider: step.provider } : {}),
      };
    })();
  };
  return { port, requests };
}

export const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

export function boardTask(overrides: Partial<LucyBoardTask> & { id: string }): LucyBoardTask {
  return { status: 'inProgress', updatedAt: NOW - 3 * 60_000, ...overrides };
}

export interface FakeSource extends LucyLookSource {
  /** How many times each look-up reached the source. */
  calls: { board: number; taskDetail: string[]; taskOutput: string[]; projects: number };
}

export function fakeSource(options: {
  tasks?: LucyBoardTask[];
  details?: Record<string, LucyTaskDetail>;
  outputs?: Record<string, LucyTaskOutput>;
  board?: Partial<Omit<LucyBoardInput, 'tasks'>>;
  projects?: Array<{ name: string; activeTasks: number; findings: number }>;
  failOutput?: boolean;
} = {}): FakeSource {
  const calls: FakeSource['calls'] = { board: 0, taskDetail: [], taskOutput: [], projects: 0 };
  return {
    calls,
    board() {
      calls.board += 1;
      return { tasks: options.tasks ?? [], lifetimeSpendUsd: 12.5, quota: null, ...options.board };
    },
    taskDetail(taskId) {
      calls.taskDetail.push(taskId);
      return options.details?.[taskId] ?? null;
    },
    async taskOutput(taskId) {
      calls.taskOutput.push(taskId);
      if (options.failOutput) throw new Error('terminal host exploded at /srv/work/secret-path');
      return options.outputs?.[taskId] ?? null;
    },
    async projects() {
      calls.projects += 1;
      return options.projects ?? [];
    },
  };
}
