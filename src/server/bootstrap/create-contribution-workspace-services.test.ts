import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { TaskStore } from '../../core/tasks.js';
import { createContributionWorkspaceServices } from './create-contribution-workspace-services.js';

describe('createContributionWorkspaceServices', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('constructs workspace collaborators around the server project', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-workspace-bootstrap-'));
    const taskStore = new TaskStore();

    const services = await createContributionWorkspaceServices({
      kookrDir: tempDir,
      serverCwd: tempDir,
      taskStore,
    });

    expect(services.serverProjectId).toBe(`local/${tempDir.split('/').pop()}`);
    expect(services.policyResolver.getPolicy(services.serverProjectId)).toBe('known_policy');
    expect(services.attemptRepository.listByProject(services.serverProjectId)).toEqual([]);
    expect(services.leaseService.listActiveLeases()).toEqual([]);
  });

  test('backfills leases from active worktree sessions and logs reconciliation', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-workspace-bootstrap-'));
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'work', cwd: tempDir });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-session',
      agentType: 'claude-code',
      cwd: '/tmp/example-worktree',
      createdAt: new Date(),
      gitIsWorktree: true,
    });
    const logs: string[] = [];

    const services = await createContributionWorkspaceServices({
      kookrDir: tempDir,
      serverCwd: tempDir,
      taskStore,
      log: (message) => logs.push(message),
    });

    expect(services.leaseService.isLeased('/tmp/example-worktree')).toBe(true);
    expect(logs).toEqual([
      '[workspace] Lease reconciliation: backfilled=1 released=0',
    ]);
  });
});
