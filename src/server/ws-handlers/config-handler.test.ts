import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LedgerAnalytics } from '../../core/ledger-analytics.js';
import { OssAttemptStore } from '../../core/oss-attempt-store.js';
import { ProjectConfigStore } from '../../core/project-config-store.js';
import { computeProjectSummaries } from '../../core/project-summary.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { ConfigHandler } from './config-handler.js';

describe('ConfigHandler', () => {
  let tempDir: string;
  let projectConfigStore: ProjectConfigStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'config-handler-test-'));
    projectConfigStore = new ProjectConfigStore(tempDir);
    await projectConfigStore.load();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('setProjectConfig persists browser-safe webhook routing fields', async () => {
    const broadcastProjectSummaries = vi.fn();
    const handler = new ConfigHandler({
      send: vi.fn(),
      projectConfigStore,
      broadcastProjectSummaries,
    });

    await handler.handle({
      type: 'setProjectConfig',
      project: 'github.com/kookr-ai/kookr',
      config: {
        webhook: {
          enabled: true,
          minSeverity: 'warning',
          url: 'https://receiver.example/secret',
          secret: 'do-not-leak',
        },
      },
    } as never);

    expect(projectConfigStore.getConfig('github.com/kookr-ai/kookr')?.webhook).toEqual({
      enabled: true,
      minSeverity: 'warning',
    });
    expect(broadcastProjectSummaries).toHaveBeenCalledOnce();

    const reloaded = new ProjectConfigStore(tempDir);
    await reloaded.load();
    expect(reloaded.getConfig('github.com/kookr-ai/kookr')?.webhook).toEqual({
      enabled: true,
      minSeverity: 'warning',
    });
  });

  test('setProjectConfig persists a per-project budget threshold', async () => {
    const handler = new ConfigHandler({
      send: vi.fn(),
      projectConfigStore,
    });

    await handler.handle({
      type: 'setProjectConfig',
      project: 'github.com/kookr-ai/kookr',
      config: { budgetWarnUsd: 12.5 },
    });

    const reloaded = new ProjectConfigStore(tempDir);
    await reloaded.load();
    expect(reloaded.getConfig('github.com/kookr-ai/kookr')?.budgetWarnUsd).toBe(12.5);
  });

  test('setProjectConfig clears a per-project budget threshold with null', async () => {
    projectConfigStore.setConfig('github.com/kookr-ai/kookr', { budgetWarnUsd: 12.5 });
    const handler = new ConfigHandler({ send: vi.fn(), projectConfigStore });

    await handler.handle({
      type: 'setProjectConfig',
      project: 'github.com/kookr-ai/kookr',
      config: { budgetWarnUsd: null },
    });

    expect(projectConfigStore.getConfig('github.com/kookr-ai/kookr')?.budgetWarnUsd).toBeUndefined();
  });

  test('setProjectConfig persists and clears the zero-drain issue limit', async () => {
    const handler = new ConfigHandler({ send: vi.fn(), projectConfigStore });
    await handler.handle({
      type: 'setProjectConfig',
      project: 'github.com/kookr-ai/kookr',
      config: { zeroDrainIssueLimit: 1000 },
    });
    expect(projectConfigStore.getConfig('github.com/kookr-ai/kookr')?.zeroDrainIssueLimit).toBe(1000);

    await handler.handle({
      type: 'setProjectConfig',
      project: 'github.com/kookr-ai/kookr',
      config: { zeroDrainIssueLimit: null },
    });
    expect(projectConfigStore.getConfig('github.com/kookr-ai/kookr')?.zeroDrainIssueLimit).toBeUndefined();
  });

  test('R5.12: explicit nulls clear cap and notes while omitted and unrelated fields survive reload', async () => {
    const project = 'github.com/kookr-ai/kookr';
    projectConfigStore.setConfig(project, {
      dailyPrLimit: 2,
      notes: 'Keep this note',
      budgetWarnUsd: 12.5,
    });
    const handler = new ConfigHandler({ send: vi.fn(), projectConfigStore });

    await handler.handle({
      type: 'setProjectConfig',
      project,
      config: {},
    });
    expect(projectConfigStore.getConfig(project)).toMatchObject({
      dailyPrLimit: 2,
      notes: 'Keep this note',
      budgetWarnUsd: 12.5,
    });

    const preserved = new ProjectConfigStore(tempDir);
    await preserved.load();
    expect(preserved.getConfig(project)).toMatchObject({
      dailyPrLimit: 2,
      notes: 'Keep this note',
      budgetWarnUsd: 12.5,
    });

    const clearHandler = new ConfigHandler({ send: vi.fn(), projectConfigStore: preserved });
    await clearHandler.handle({
      type: 'setProjectConfig',
      project,
      config: { dailyPrLimit: null, notes: null },
    });

    const reloaded = new ProjectConfigStore(tempDir);
    await reloaded.load();
    expect(reloaded.getConfig(project)).toEqual({
      project,
      budgetWarnUsd: 12.5,
    });

    const ossAttemptStore = new OssAttemptStore(tempDir);
    await ossAttemptStore.load();
    const agents: AgentState[] = [{
      agentId: 'agent-1',
      projectId: project,
      taskId: 'task-1',
      taskStatus: 'inProgress',
      events: [],
      anomaly: null,
    }];
    const [summary] = computeProjectSummaries({
      agents,
      ledgerAnalytics: new LedgerAnalytics(ossAttemptStore),
      configStore: reloaded,
    });
    expect(summary.dailyLimit).toBeUndefined();
    expect(summary.notes).toBeUndefined();
    expect(summary.budgetWarnUsd).toBe(12.5);
  });
});
