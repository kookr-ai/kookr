import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { TaskStore } from '../../core/tasks.js';
import { projectAlertForRemoteReplay, projectTaskForRemoteReplay } from '../projections.js';

describe('remote replay projections', () => {
  it('projects tasks into a replayable metadata shape without remote-only persistence fields', () => {
    const store = new TaskStore();
    const task = store.createTask('Replay me', '/repo');
    task.updatedAt = new Date('2026-05-14T00:00:00.000Z');
    store.addSession(task.id, {
      tmuxSession: 'kookr-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-14T00:00:00.000Z'),
    });
    task.updatedAt = new Date('2026-05-14T00:00:00.000Z');

    expect(projectTaskForRemoteReplay(task)).toEqual({
      taskId: task.id,
      status: 'inProgress',
      updatedAt: '2026-05-14T00:00:00.000Z',
      sessionIds: ['kookr-session'],
    });
  });

  it('projects alerts with serverRevision only when supplied', () => {
    const alert: Extract<ServerMessage, { type: 'alert' }> = {
      type: 'alert',
      agentId: 'kookr-session',
      summary: 'Needs attention',
      details: 'Permission prompt',
      severity: 'critical',
    };

    expect(projectAlertForRemoteReplay(alert)).not.toHaveProperty('serverRevision');
    expect(projectAlertForRemoteReplay(alert, 3)).toMatchObject({
      agentId: 'kookr-session',
      summary: 'Needs attention',
      severity: 'critical',
      serverRevision: 3,
    });
  });
});
