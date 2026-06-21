import { describe, expect, it } from 'vitest';

import { AttentionQueue } from '../core/attention-queue.js';
import { TaskStore } from '../core/tasks.js';
import { buildPermissionRequestBinding } from './permission-request-binding.js';
import { asNodeId } from '../remote/ids.js';
import { projectTaskForRemoteShare, sanitizeRemoteTaskLabel } from './share-projection.js';

describe('RemoteTaskProjectionV1', () => {
  it('sanitizes and length-caps task labels', () => {
    const label = sanitizeRemoteTaskLabel(
      `Ship <script>alert(1)</script> ${'x'.repeat(120)}\n\u202E`,
      'task-abcdef123456',
    );

    expect(label.length).toBeLessThanOrEqual(80);
    expect(label).toMatch(/^[A-Za-z0-9 .,!?@#:()+-]+$/);
    expect(label).not.toContain('<');
    expect(label).not.toContain('\u202E');
  });

  it('derives only the safe A0 projection fields from local task state', () => {
    const store = new TaskStore();
    const task = store.createTask({
      prompt: 'Fix prod /private/secret with token github_pat_should_not_leak',
      cwd: '/private/project',
    });
    store.renameTask(task.id, 'Review failing tests');

    const projection = projectTaskForRemoteShare(store.getTask(task.id)!, {
      nodeId: asNodeId('kookr-node-test'),
    });

    expect(projection).toEqual({
      schemaVersion: 'remote-task-projection.v1',
      nodeId: 'kookr-node-test',
      taskId: task.id,
      taskLabel: 'Review failing tests',
      status: 'open',
      hasFinding: false,
      needsInput: false,
      updatedAt: expect.any(String),
    });
    expect(Object.keys(projection).sort()).toEqual([
      'hasFinding',
      'needsInput',
      'nodeId',
      'schemaVersion',
      'status',
      'taskId',
      'taskLabel',
      'updatedAt',
    ]);
    expect(JSON.stringify(projection)).not.toContain('/private/project');
    expect(JSON.stringify(projection)).not.toContain('github_pat_should_not_leak');
  });

  it('falls back to a task id label instead of exposing an unnamed raw prompt', () => {
    const store = new TaskStore();
    const task = store.createTask({
      prompt: 'Raw prompt with /private/project and github_pat_secret',
      cwd: '/private/project',
    });

    const projection = projectTaskForRemoteShare(store.getTask(task.id)!, {
      nodeId: asNodeId('kookr-node-test'),
    });

    expect(projection.taskLabel).toBe(`Task ${task.id.slice(0, 8)}`);
    expect(JSON.stringify(projection)).not.toContain('/private/project');
    expect(JSON.stringify(projection)).not.toContain('github_pat_secret');
  });

  it('includes only a bound permission request when permission approval projection is enabled', () => {
    const store = new TaskStore();
    const queue = new AttentionQueue();
    const task = store.createTask('Permission task', '/tmp');
    store.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const detectedAt = new Date('2026-05-17T00:01:00.000Z');
    queue.enqueue('agent-1', {
      agentId: 'agent-1',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'permission required',
      detectedAt,
    });
    const event = {
      type: 'permission_request' as const,
      sessionId: 'agent-1',
      toolName: 'Bash',
      toolInput: { command: 'git push origin feature' },
      eventSeq: 7,
    };

    const projection = projectTaskForRemoteShare(store.getTask(task.id)!, {
      nodeId: asNodeId('kookr-node-test'),
      queue,
      includePermissionApproval: true,
      getAgentEvents: () => [event],
    });

    expect(projection.activePermissionRequest).toEqual({
      sessionId: 'agent-1',
      defaultKeystroke: '1',
      permissionRequest: buildPermissionRequestBinding({
        sessionId: 'agent-1',
        event,
        detectedAt,
      }),
    });
    expect(JSON.stringify(projection)).not.toContain('git push origin feature');
  });
});
