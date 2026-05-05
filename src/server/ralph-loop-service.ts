import type { RalphLoopState, Task } from '../core/tasks.js';

export interface RalphLoopRequest {
  prompt: string;
  iterationCap: number;
  stopPredicate?: string;
  zeroDiffConvergence?: { consecutiveIterations: number };
  costCapUsd?: number;
}

export type RalphLoopServiceResult<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> };

export interface RalphLoopService {
  startLoop(task: Task, input: RalphLoopRequest): Promise<RalphLoopServiceResult<RalphLoopState>>;
}
