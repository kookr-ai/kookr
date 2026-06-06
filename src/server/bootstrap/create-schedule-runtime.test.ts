import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import { createScheduleRuntime } from './create-schedule-runtime.js';

describe('createScheduleRuntime', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('loads schedule state and wires schedule broadcasts through the server broadcaster', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-schedule-'));
    const messages: ServerMessage[] = [];

    const runtime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore: new TaskStore(),
      launchServiceDeps: {} as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      broadcastToAll: (msg) => messages.push(msg),
    });

    expect(runtime.scheduleStore.list()).toEqual([]);
    runtime.scheduleService.recordRunnerStarted('auto');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      type: 'schedules',
      schedules: [],
      status: expect.objectContaining({
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
        runnerStartedAt: expect.any(String),
      }),
    }));
  });
});
