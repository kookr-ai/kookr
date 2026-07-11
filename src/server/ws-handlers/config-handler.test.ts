import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectConfigStore } from '../../core/project-config-store.js';
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
});
