/**
 * Pin tests for `SupervisionService`'s wake delivery (issue #4239).
 *
 * Written against the code before the dialog-safe delivery moved into the shared
 * `GuardedInputSender`, so the extraction cannot change what supervision does:
 * the exact `sendInput` call, the log line for a refused or failed wake, and the
 * fact that a supervision wake writes no user-input delivery record.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputSubmitAbortedError } from '../core/ports/agent-interaction-port.js';
import { TaskStore } from '../core/tasks.js';
import { readSupervisionState, writeSupervisionFiles } from '../core/supervision/supervision-files.js';
import type { AgentEvent } from '../core/types.js';
import { SUPERVISION_SETTLE_MS, SupervisionService, type SupervisionServiceDeps } from './supervision-service.js';

const MIN = 60_000;
const T0 = Math.floor(Date.now() / MIN) * MIN;

let dir: string;
let store: TaskStore;
let clock: { t: number };
let awaiting: { value: boolean };
let sendInput: ReturnType<typeof vi.fn>;
let logLines: string[];

function service(): SupervisionService {
  const deps: SupervisionServiceDeps = {
    dataDir: dir,
    taskStore: store,
    monitor: {
      getAgentEvents: () => [{ type: 'stop' } as AgentEvent],
      isAwaitingChoice: () => awaiting.value,
      getEventCounts: () => ({ 'kookr-sv': 1 }),
    },
    adapter: { sendInput },
    launchSupervisor: vi.fn(async () => ({ taskId: 'unset' })),
    abortTask: vi.fn(async () => undefined),
    defaultCwd: '/cwd',
    alert: vi.fn(),
    env: {},
    now: () => new Date(clock.t),
    log: (line) => { logLines.push(line); },
    getStartupReadyAtMs: () => T0 - SUPERVISION_SETTLE_MS - MIN,
  };
  return new SupervisionService(deps);
}

function seedLiveSupervisor(): void {
  const sv = store.createTask('sup', '/cwd');
  store.startTask(sv.id);
  store.addSession(sv.id, { tmuxSession: 'kookr-sv', agentType: 'claude-code', cwd: '/cwd', createdAt: new Date(T0) });
  const worker = store.createTask('worker', '/cwd');
  store.startTask(worker.id);
  writeSupervisionFiles(dir, {
    supervisionId: 'sup-1',
    targets: [{ taskId: worker.id, name: 'worker' }],
    goals: [],
    deadlineAt: new Date(T0 + 240 * MIN).toISOString(),
    createdAt: new Date(T0).toISOString(),
    supervisorTaskId: sv.id,
  }, '# brief\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kookr-supervision-pin-'));
  store = new TaskStore();
  clock = { t: T0 };
  awaiting = { value: false };
  sendInput = vi.fn(async () => undefined);
  logLines = [];
  seedLiveSupervisor();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('supervision wake delivery (pinned before the GuardedInputSender extraction)', () => {
  it('calls sendInput exactly once with (session, line, { beforeSubmit }) and logs nothing', async () => {
    clock.t = T0 + 45 * MIN;
    await service().tick();
    expect(sendInput).toHaveBeenCalledTimes(1);
    const call = sendInput.mock.calls[0] as unknown[];
    expect(call).toHaveLength(3);
    expect(call[0]).toBe('kookr-sv');
    expect(Object.keys(call[2] as object)).toEqual(['beforeSubmit']);
    expect(logLines.filter((l) => l.includes('not delivered'))).toEqual([]);
  });

  it('a veto during typing is logged as not delivered with the refusal message', async () => {
    sendInput.mockImplementationOnce(async () => { throw new InputSubmitAbortedError(); });
    clock.t = T0 + 45 * MIN;
    await service().tick();
    const line = logLines.find((l) => l.includes('not delivered'));
    expect(line).toMatch(/^\[supervision\] heartbeat wake for sup-1 not delivered: agent kookr-sv is waiting on a choice/);
    expect(readSupervisionState(dir, 'sup-1')!.undeliverableTicks).toBe(1);
  });

  it('an adapter error is logged with its message and counted as undeliverable', async () => {
    sendInput.mockImplementationOnce(async () => { throw new Error('pty closed'); });
    clock.t = T0 + 45 * MIN;
    await service().tick();
    expect(logLines).toContain('[supervision] heartbeat wake for sup-1 not delivered: pty closed');
    expect(readSupervisionState(dir, 'sup-1')!.undeliverableTicks).toBe(1);
  });
});
