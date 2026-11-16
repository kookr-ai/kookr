/**
 * Boot wiring guard for the page-only alerters (issue #3911): the server must
 * hand each alerter it builds to the lifecycle timers, whose liveness tick is
 * what runs them. Without that hand-off an alerter never pages, while its own
 * unit tests and the timer wiring tests (which inject a stub) stay green.
 *
 * `startLifecycleTimers` is wrapped module-wide to record its deps, so this
 * lives apart from index.test.ts.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TimerDeps } from './lifecycle-timers.js';

const timerDepsSeen: TimerDeps[] = [];

vi.mock('./lifecycle-timers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lifecycle-timers.js')>();
  return {
    ...actual,
    startLifecycleTimers: (deps: TimerDeps) => {
      timerDepsSeen.push(deps);
      return actual.startLifecycleTimers(deps);
    },
  };
});

import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { createKookrServerInternal } from './index.js';
import type { KookrServerInternal } from './server-test-helpers.js';
import { FinishedAwaitingAckResidualAlerter } from './finished-awaiting-ack-residual-alert.js';
import { HungSuspectResidualAlerter } from './hung-suspect-residual-alert.js';
import { PermissionPromptWaitAlerter } from './permission-prompt-wait-alert.js';
import { ProviderPausedOccupancyAlerter } from './provider-paused-occupancy-alert.js';
import { SchedulesPausedResidualAlerter } from './schedules-paused-residual-alert.js';

describe('server boot hands every page-only alerter to the lifecycle timers (issue #3911)', () => {
  let tempDir: string;
  let server: KookrServerInternal | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-alerter-wiring-'));
    timerDepsSeen.length = 0;
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('each alerter field of the timer deps is the alerter the server built', async () => {
    server = await createKookrServerInternal({
      port: 0,
      host: '127.0.0.1',
      kookrDir: tempDir,
      tasksFile: join(tempDir, 'tasks.json'),
      hooksDir: join(tempDir, 'hooks'),
      settingsDir: join(tempDir, 'settings'),
      serverCwd: '/test/cwd',
      frontendDir: join(tempDir, 'frontend'),
      saveIntervalMs: 600_000,
      livenessIntervalMs: 600_000,
      terminalBackend: new FakeTerminalBackend(),
    });

    expect(timerDepsSeen).toHaveLength(1);
    const deps = timerDepsSeen[0];
    expect(deps.permissionPromptWaitAlerter).toBeInstanceOf(PermissionPromptWaitAlerter);
    expect(deps.hungSuspectResidualAlerter).toBeInstanceOf(HungSuspectResidualAlerter);
    expect(deps.finishedAwaitingAckResidualAlerter).toBeInstanceOf(FinishedAwaitingAckResidualAlerter);
    expect(deps.schedulesPausedResidualAlerter).toBeInstanceOf(SchedulesPausedResidualAlerter);
    expect(deps.providerPausedOccupancyAlerter).toBeInstanceOf(ProviderPausedOccupancyAlerter);
  });
});
