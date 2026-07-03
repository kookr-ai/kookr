import type { SessionInfo } from '../session-read-model.js';
import type { Task } from '../tasks.js';

export interface TaskStoreSnapshot {
  version: 2;
  lifetimeSpendUsd: number;
  tasks: Task[];
}

const DEFAULT_DATE = new Date('2026-01-01T00:00:00.000Z');

export function aSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    tmuxSession: 'agent-1',
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: DEFAULT_DATE,
    ...overrides,
  };
}

export function aTask(overrides: Partial<Task> = {}): Task {
  const createdAt = overrides.createdAt ?? DEFAULT_DATE;
  return {
    id: 'task-1',
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

export function aTaskStoreSnapshot(overrides: Partial<TaskStoreSnapshot> = {}): TaskStoreSnapshot {
  return {
    version: 2,
    lifetimeSpendUsd: 0,
    tasks: [],
    ...overrides,
  };
}

export const aSnapshot = aTaskStoreSnapshot;
