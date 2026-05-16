import { describe, expect, it } from 'vitest';

import { TaskStore } from '../core/tasks.js';
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

    const projection = projectTaskForRemoteShare(task, {
      nodeId: asNodeId('kookr-node-test'),
    });

    expect(projection.taskLabel).toBe(`Task ${task.id.slice(0, 8)}`);
    expect(JSON.stringify(projection)).not.toContain('/private/project');
    expect(JSON.stringify(projection)).not.toContain('github_pat_secret');
  });
});
