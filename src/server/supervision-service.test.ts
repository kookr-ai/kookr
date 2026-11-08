import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputSubmitAbortedError } from '../core/ports/agent-interaction-port.js';
import { TaskStore } from '../core/tasks.js';
import { buildTaskLaunchIntent } from '../core/task-launch-intent.js';
import {
  readSupervisionState,
  writeSupervisionFiles,
  type SupervisionState,
} from '../core/supervision/supervision-files.js';
import type { AgentEvent } from '../core/types.js';
import {
  SUPERVISION_SETTLE_MS,
  SupervisionService,
  formatWakeLine,
  isSupervisionWakeDisabled,
  type SupervisionServiceDeps,
} from './supervision-service.js';

const MIN = 60_000;
// Anchored to the real clock: task `updatedAt` stamps come from the real clock too.
const T0 = Math.floor(Date.now() / MIN) * MIN;

interface Harness {
  dir: string;
  store: TaskStore;
  clock: { t: number };
  sendInput: ReturnType<typeof vi.fn>;
  launchSupervisor: ReturnType<typeof vi.fn>;
  abortTask: ReturnType<typeof vi.fn>;
  alert: ReturnType<typeof vi.fn>;
  awaiting: { value: boolean };
  events: Map<string, AgentEvent[]>;
  counts: Record<string, number>;
  deps: SupervisionServiceDeps;
  make(over?: Partial<SupervisionServiceDeps>): SupervisionService;
  liveTask(name: string, session: string): string;
  seed(over?: Partial<SupervisionState>): SupervisionState;
}

let h: Harness;

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'kookr-supervision-svc-'));
  const store = new TaskStore();
  const clock = { t: T0 };
  const events = new Map<string, AgentEvent[]>();
  const counts: Record<string, number> = {};
  const awaiting = { value: false };
  const sendInput = vi.fn(async () => undefined);
  const launchSupervisor = vi.fn(async () => ({ taskId: 'unset' }));
  const abortTask = vi.fn(async () => undefined);
  const alert = vi.fn();
  const deps: SupervisionServiceDeps = {
    dataDir: dir,
    taskStore: store,
    monitor: {
      getAgentEvents: (id: string) => events.get(id) ?? [],
      isAwaitingChoice: () => awaiting.value,
      getEventCounts: () => counts,
    },
    adapter: { sendInput },
    launchSupervisor,
    abortTask,
    defaultCwd: '/cwd',
    alert,
    env: {},
    now: () => new Date(clock.t),
    log: () => undefined,
  };
  return {
    dir, store, clock, sendInput, launchSupervisor, abortTask, alert, awaiting, events, counts, deps,
    make: (over = {}) => new SupervisionService({ ...deps, ...over }),
    liveTask(name, session) {
      const task = store.createTask(name, '/cwd');
      store.startTask(task.id);
      store.addSession(task.id, { tmuxSession: session, agentType: 'claude-code', cwd: '/cwd', createdAt: new Date(T0) });
      events.set(session, [{ type: 'stop' } as AgentEvent]);
      counts[session] = 1;
      return task.id;
    },
    seed(over = {}) {
      let targets = over.targets;
      if (!targets) {
        const worker = store.createTask('worker', '/cwd');
        store.startTask(worker.id);
        targets = [{ taskId: worker.id, name: 'worker' }];
      }
      const state: SupervisionState = {
        supervisionId: 'sup-1',
        targets,
        goals: [],
        deadlineAt: new Date(T0 + 240 * MIN).toISOString(),
        createdAt: new Date(T0).toISOString(),
        supervisorTaskId: null,
        ...over,
        targets,
      };
      writeSupervisionFiles(dir, state, '# Supervision brief\n\nTargets: w1\n');
      return state;
    },
  };
}

/** A service whose startup recovery completed long enough ago that the settle window is over. */
function settledService(over: Partial<SupervisionServiceDeps> = {}): SupervisionService {
  return h.make({ getStartupReadyAtMs: () => T0 - SUPERVISION_SETTLE_MS - MIN, ...over });
}

beforeEach(() => {
  h = harness();
});
afterEach(() => {
  rmSync(h.dir, { recursive: true, force: true });
});

describe('formatWakeLine', () => {
  const state = { supervisionId: 'sup-1', targets: [{ taskId: 'a', name: 'a' }, { taskId: 'b', name: 'b' }], deadlineAt: new Date(2026, 10, 8, 18, 0).toISOString() } as SupervisionState;
  it('renders the heartbeat, deadline and final variants on one line', () => {
    expect(formatWakeLine('heartbeat', state, '/d/brief.md')).toBe('[kookr supervision sup-1] mandate until 18:00 · 2 targets · brief: /d/brief.md');
    expect(formatWakeLine('deadline', state, '/d/brief.md')).toBe('[kookr supervision sup-1] mandate ended: recap and signal completion-ready · brief: /d/brief.md');
    expect(formatWakeLine('final', state, '/d/brief.md')).toBe('[kookr supervision sup-1] 2 targets finished: recap and signal completion-ready · brief: /d/brief.md');
  });
});

describe('isSupervisionWakeDisabled', () => {
  it('follows the self-advancing kill-switch truthiness', () => {
    expect(isSupervisionWakeDisabled({})).toBe(false);
    expect(isSupervisionWakeDisabled({ KOOKR_SUPERVISION_WAKE_DISABLED: '1' })).toBe(true);
    expect(isSupervisionWakeDisabled({ KOOKR_SUPERVISION_WAKE_DISABLED: 'off' })).toBe(false);
    expect(isSupervisionWakeDisabled({ KOOKR_SUPERVISION_WAKE_DISABLED: '' })).toBe(false);
  });
});

describe('wake delivery', () => {
  it('types the heartbeat line through the adapter and advances the timers', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 45 * MIN;
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    const [session, line, opts] = h.sendInput.mock.calls[0] as unknown as [string, string, { beforeSubmit: () => boolean }];
    expect(session).toBe('kookr-sv');
    expect(line).toMatch(/^\[kookr supervision sup-1\] mandate until \d\d:\d\d · 1 target · brief: .*brief\.md$/);
    expect(line).not.toContain('\n');
    expect(opts.beforeSubmit()).toBe(true);
    // The REAL guard: a dialog appearing after the text was typed vetoes the trailing Enter.
    h.awaiting.value = true;
    expect(opts.beforeSubmit()).toBe(false);
    h.awaiting.value = false;
    const after = readSupervisionState(h.dir, 'sup-1')!;
    expect(after.lastDeliveredAt).toBe(new Date(h.clock.t).toISOString());
    expect(after.nextHeartbeatAt).toBe(new Date(h.clock.t + 45 * MIN).toISOString());
    expect(after.health).toBe('healthy');
  });

  it('does not deliver before the heartbeat is due', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 30 * MIN;
    await settledService().tick();
    expect(h.sendInput).not.toHaveBeenCalled();
  });

  it('a supervisor on a choice dialog is refused by the P0 guard: nothing typed, one undeliverable tick', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv });
    h.awaiting.value = true;
    h.clock.t = T0 + 45 * MIN;
    await settledService().tick();
    expect(h.sendInput).not.toHaveBeenCalled();
    // view.deliverable is false while awaiting a choice, so this is counted by the policy.
    expect(readSupervisionState(h.dir, 'sup-1')!.undeliverableTicks).toBe(1);
  });

  it('a dialog that appears while the wake is being typed vetoes Enter through the real guard: undeliverable, not retried in the tick', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv });
    // Like the real adapter: type, re-check beforeSubmit, and abort the submit on a veto.
    h.sendInput.mockImplementationOnce(async (_id: string, _text: string, opts?: { beforeSubmit?: () => boolean }) => {
      h.awaiting.value = true; // the menu pops up mid-typing
      if (opts?.beforeSubmit && !opts.beforeSubmit()) throw new InputSubmitAbortedError();
    });
    h.clock.t = T0 + 45 * MIN;
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    const after = readSupervisionState(h.dir, 'sup-1')!;
    expect(after.undeliverableTicks).toBe(1);
    expect(after.lastDeliveredAt).toBeUndefined();
    expect(after.nextHeartbeatAt).toBeUndefined();
  });

  it('a supervisor that is mid-turn (last event is not a stop) is not typed into', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.events.set('kookr-sv', [{ type: 'tool_use', toolName: 'Bash' } as AgentEvent]);
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 45 * MIN;
    await settledService().tick();
    expect(h.sendInput).not.toHaveBeenCalled();
  });

  it('a Stop parked on background work still counts as idle', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.events.set('kookr-sv', [{ type: 'stop', activeBackgroundTaskCount: 1 } as AgentEvent]);
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 45 * MIN;
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
  });

  it('a busy supervisor is retried every tick, degrades after 3, and is NEVER restarted or cancelled', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.events.set('kookr-sv', [{ type: 'tool_use', toolName: 'Bash' } as AgentEvent]);
    h.seed({ supervisorTaskId: sv });
    const svc = settledService();
    for (const m of [45, 46, 47, 48, 49]) {
      h.clock.t = T0 + m * MIN;
      h.counts['kookr-sv'] += 1; // still producing hook events
      await svc.tick();
    }
    const state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.health).toBe('degraded:undeliverable');
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.abortTask).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    // once it reaches its prompt the very next tick delivers
    h.events.set('kookr-sv', [{ type: 'stop' } as AgentEvent]);
    h.clock.t = T0 + 50 * MIN;
    await svc.tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(readSupervisionState(h.dir, 'sup-1')!.health).toBe('healthy');
  });

  it('busy with no new hook events for > 30 min: degraded:possibly-hung and ONE alert (deduped across fresh instances), no restart or cancel', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.events.set('kookr-sv', [{ type: 'tool_use', toolName: 'Bash' } as AgentEvent]);
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 20 * MIN;
    await settledService().tick(); // first observation of the event count
    expect(readSupervisionState(h.dir, 'sup-1')!.supervisorEventAt).toBe(new Date(h.clock.t).toISOString());
    h.clock.t = T0 + 55 * MIN; // heartbeat due; 35 min without a new event
    await settledService().tick();
    let state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.health).toBe('degraded:possibly-hung');
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0][0].summary).toContain('supervisor-possibly-hung');
    h.clock.t = T0 + 56 * MIN;
    await settledService().tick(); // a brand-new service instance
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.abortTask).not.toHaveBeenCalled();
    state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.supervisorTaskId).toBe(sv);
  });
});

describe('deadline and restart-safety', () => {
  it('delivers the deadline wake once, ends on the next tick, and a fresh service instance over the same files does not deliver it again', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv, deadlineAt: new Date(T0 + 60 * MIN).toISOString(), nextHeartbeatAt: new Date(T0 + 500 * MIN).toISOString() });
    h.clock.t = T0 + 60 * MIN;
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(h.sendInput.mock.calls[0][1]).toContain('mandate ended: recap and signal completion-ready');
    expect(readSupervisionState(h.dir, 'sup-1')!.deadlineWakeDeliveredAt).toBeDefined();

    // "Server restart": brand new instance, same files, replayed events present.
    const restarted = settledService();
    h.clock.t = T0 + 61 * MIN;
    await restarted.tick();
    await restarted.tick();
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    const ended = readSupervisionState(h.dir, 'sup-1')!;
    expect(ended.endedReason).toBe('deadline');
    expect(ended.health).toBe('ended');
  });

  it('persists deadlineWakeAttemptedAt BEFORE typing, and a fresh instance never retypes it even when delivery was not recorded', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv, deadlineAt: new Date(T0 + 60 * MIN).toISOString(), nextHeartbeatAt: new Date(T0 + 500 * MIN).toISOString() });
    let markerWhileTyping: string | undefined;
    h.sendInput.mockImplementationOnce(async () => {
      markerWhileTyping = readSupervisionState(h.dir, 'sup-1')!.deadlineWakeAttemptedAt;
      throw new Error('process died mid-send'); // ambiguous: it may or may not have been typed
    });
    h.clock.t = T0 + 60 * MIN;
    await settledService().tick();
    expect(markerWhileTyping).toBe(new Date(h.clock.t).toISOString());
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    // Simulate a crash that lost the delivered-at write: only the attempted marker is on disk.
    h.clock.t = T0 + 61 * MIN;
    await settledService().tick();
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(readSupervisionState(h.dir, 'sup-1')!.endedReason).toBe('deadline');
  });

  it('a deadline wake the guard definitely refused clears the marker and is retried', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv, deadlineAt: new Date(T0 + 60 * MIN).toISOString(), nextHeartbeatAt: new Date(T0 + 500 * MIN).toISOString() });
    h.sendInput.mockImplementationOnce(async () => { throw new InputSubmitAbortedError(); });
    h.clock.t = T0 + 60 * MIN;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.deadlineWakeAttemptedAt).toBeUndefined();
    h.clock.t = T0 + 61 * MIN;
    await settledService().tick();
    expect(h.sendInput).toHaveBeenCalledTimes(2);
    expect(readSupervisionState(h.dir, 'sup-1')!.deadlineWakeDeliveredAt).toBeDefined();
  });

  it('a crash between the deadline delivery and the write cannot double-deliver once the state file says delivered', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({
      supervisorTaskId: sv,
      deadlineAt: new Date(T0 + 60 * MIN).toISOString(),
      deadlineWakeDeliveredAt: new Date(T0 + 60 * MIN).toISOString(),
    });
    h.clock.t = T0 + 90 * MIN;
    await settledService().tick();
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(readSupervisionState(h.dir, 'sup-1')!.endedReason).toBe('deadline');
  });

  it('delivers the final wake once when every target is terminal, then ends', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    const w = h.store.createTask('worker', '/cwd');
    h.store.startTask(w.id);
    h.store.completeTask(w.id);
    h.seed({ supervisorTaskId: sv, targets: [{ taskId: w.id, name: 'worker' }] });
    h.clock.t = T0 + 5 * MIN;
    const svc = settledService();
    await svc.tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(h.sendInput.mock.calls[0][1]).toContain('finished: recap and signal completion-ready');
    h.clock.t = T0 + 6 * MIN;
    await svc.tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(readSupervisionState(h.dir, 'sup-1')!.endedReason).toBe('targets-terminal');
  });

  it('ignores ended supervisions and unreadable directories', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv, endedAt: new Date(T0).toISOString(), endedReason: 'deadline', health: 'ended' });
    h.clock.t = T0 + 500 * MIN;
    await settledService().tick();
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
  });
});

describe('restartEpisode', () => {
  it('launches a fresh episode with header + brief, records the new supervisor, moves the supervises edges', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    const target = h.store.createTask('worker', '/cwd');
    h.store.startTask(target.id);
    h.seed({ supervisorTaskId: oldSv, targets: [{ taskId: target.id, name: 'worker' }] });
    h.store.upsertRelation({ sourceTaskId: oldSv, targetTaskId: target.id, type: 'supervises', confidence: 1, source: 'api' });
    // the old supervisor died
    h.store.terminateTask(oldSv);
    const newSv = h.store.createTask('sup2', '/cwd').id;
    h.launchSupervisor.mockResolvedValueOnce({ taskId: newSv });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();

    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
    const input = h.launchSupervisor.mock.calls[0][0] as { prompt: string; cwd: string; idempotencyKey: string };
    expect(input.prompt.split('\n')[0]).toBe(`You are a fresh episode of supervision sup-1; the previous supervisor ${oldSv} stopped (dead). Re-read the targets before acting.`);
    expect(input.prompt).toContain('# Supervision brief');
    expect(input.cwd).toBe('/cwd');
    expect(input.idempotencyKey).toBe('supervision-sup-1-episode-1');

    const after = readSupervisionState(h.dir, 'sup-1')!;
    expect(after.supervisorTaskId).toBe(newSv);
    expect(after.restartCount).toBe(1);
    expect(after.lastRestartAt).toBe(new Date(h.clock.t).toISOString());
    expect(after.episodes?.map((e) => e.supervisorTaskId)).toEqual([newSv]);
    expect(after.health).toBe('healthy');

    const oldEdge = h.store.listRelations({ sourceTaskId: oldSv, type: 'supervises' });
    expect(oldEdge.map((r) => r.lifecycle)).toEqual(['superseded']);
    const newEdges = h.store.listRelations({ sourceTaskId: newSv, type: 'supervises' });
    expect(newEdges).toHaveLength(1);
    expect(newEdges[0]).toMatchObject({ targetTaskId: target.id, lifecycle: 'active', source: 'api' });
    expect(newEdges[0].evidence[0].snippet).toBe('supervision:sup-1');
    // the old supervisor was already terminal: nothing to end
    expect(h.abortTask).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('does not restart again within 30 min and stays quiet (no alert); restarts once spacing has passed', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({
      supervisorTaskId: oldSv,
      restartCount: 1,
      lastRestartAt: new Date(T0 + 5 * MIN).toISOString(),
    });
    h.clock.t = T0 + 20 * MIN;
    const svc = settledService();
    await svc.tick();
    await svc.tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    h.launchSupervisor.mockResolvedValueOnce({ taskId: h.store.createTask('sup2', '/cwd').id });
    h.clock.t = T0 + 36 * MIN;
    await svc.tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
  });

  it('a failed launch alerts the operator and still consumes the attempt (spacing applies)', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({ supervisorTaskId: oldSv });
    h.launchSupervisor.mockRejectedValueOnce(new Error('no capacity'));
    h.clock.t = T0 + 10 * MIN;
    const svc = settledService();
    await svc.tick();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0][0].summary).toContain('restart-failed');
    const after = readSupervisionState(h.dir, 'sup-1')!;
    expect(after.supervisorTaskId).toBe(oldSv);
    expect(after.restartCount).toBe(1);
    h.clock.t = T0 + 11 * MIN;
    await svc.tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
  });

  it('stops after 3 fresh episodes and alerts (restart-limit-reached)', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({ supervisorTaskId: oldSv, restartCount: 3, lastRestartAt: new Date(T0 - 500 * MIN).toISOString() });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.alert.mock.calls[0][0].summary).toContain('restart-limit-reached');
    expect(h.alert.mock.calls[0][0].severity).toBe('critical');
  });

  it('a crashed supervisor (in progress, no live session) is restarted; a still non-terminal predecessor is cancelled after a fresh status re-read', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    const mutable = h.store as unknown as { tasks: Map<string, { sessions: Array<{ lastStatus?: string }> }> };
    mutable.tasks.get(sv)!.sessions[0].lastStatus = 'aborted';
    h.seed({ supervisorTaskId: sv });
    h.launchSupervisor.mockResolvedValueOnce({ taskId: h.store.createTask('sup2', '/cwd').id });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
    expect(h.abortTask).toHaveBeenCalledWith(sv);
  });

  it('does not cancel a predecessor that turned terminal while the replacement launched', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    const mutable = h.store as unknown as { tasks: Map<string, { sessions: Array<{ lastStatus?: string }> }> };
    mutable.tasks.get(sv)!.sessions[0].lastStatus = 'aborted';
    h.seed({ supervisorTaskId: sv });
    h.launchSupervisor.mockImplementationOnce(async () => {
      h.store.terminateTask(sv); // went terminal during the launch
      return { taskId: h.store.createTask('sup2', '/cwd').id };
    });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.abortTask).not.toHaveBeenCalled();
  });

  it('crash between launch and persist: a fresh instance ADOPTS the task created under pendingEpisodeKey instead of relaunching', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    const target = h.store.createTask('worker', '/cwd');
    h.store.startTask(target.id);
    h.seed({ supervisorTaskId: oldSv, targets: [{ taskId: target.id, name: 'worker' }] });
    h.store.upsertRelation({ sourceTaskId: oldSv, targetTaskId: target.id, type: 'supervises', confidence: 1, source: 'api' });
    // The launch created the task, then the process died before completeEpisode persisted.
    let orphanId = '';
    h.launchSupervisor.mockImplementationOnce(async (input: { idempotencyKey: string }) => {
      orphanId = h.store.createTask({
        prompt: 'sup2', cwd: '/cwd',
        launchIntent: buildTaskLaunchIntent('claude-code', { idempotencyKey: input.idempotencyKey }),
      } as never).id;
      throw new Error('process died');
    });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    let state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.supervisorTaskId).toBe(oldSv);
    expect(state.pendingEpisodeKey).toBe('supervision-sup-1-episode-1');
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);

    h.clock.t = T0 + 12 * MIN;
    await settledService().tick(); // fresh service instance, same files
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1); // adopted, NOT relaunched
    state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.supervisorTaskId).toBe(orphanId);
    expect(state.pendingEpisodeKey).toBeUndefined();
    expect(state.episodes?.map((e) => e.supervisorTaskId)).toEqual([orphanId]);
    expect(h.store.listRelations({ sourceTaskId: orphanId, type: 'supervises' })).toHaveLength(1);
    expect(h.store.listRelations({ sourceTaskId: oldSv, type: 'supervises' })[0].lifecycle).toBe('superseded');
  });

  it('a pending key whose launch never created a task is simply cleared (spacing still guards the next attempt)', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({ supervisorTaskId: oldSv, restartCount: 1, lastRestartAt: new Date(T0 + 5 * MIN).toISOString(), pendingEpisodeKey: 'supervision-sup-1-episode-1' });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.pendingEpisodeKey).toBeUndefined();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
  });

  it('a successful restart clears pendingEpisodeKey', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({ supervisorTaskId: oldSv });
    h.launchSupervisor.mockResolvedValueOnce({ taskId: h.store.createTask('sup2', '/cwd').id });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.pendingEpisodeKey).toBeUndefined();
  });

  it('restarts in the old supervisor\'s cwd', async () => {
    const task = h.store.createTask('sup', '/elsewhere');
    h.store.startTask(task.id);
    h.store.terminateTask(task.id);
    h.seed({ supervisorTaskId: task.id });
    h.launchSupervisor.mockResolvedValueOnce({ taskId: h.store.createTask('sup2', '/elsewhere').id });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.launchSupervisor.mock.calls[0][0].cwd).toBe('/elsewhere');
  });
});

describe('intentional endings are never revived', () => {
  async function endedWith(setup: (id: string) => void): Promise<SupervisionState> {
    const sv = h.liveTask('sup', 'kookr-sv');
    setup(sv);
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.sendInput).not.toHaveBeenCalled();
    return readSupervisionState(h.dir, 'sup-1')!;
  }

  it('a completed supervisor ends the mandate as supervisor-finished', async () => {
    const s = await endedWith((id) => h.store.completeTask(id));
    expect([s.endedReason, s.health]).toEqual(['supervisor-finished', 'ended']);
  });

  it('a supervisor that signalled completion-ready (still alive) ends as supervisor-finished', async () => {
    const s = await endedWith((id) => h.store.setPendingSignal(id, { kind: 'completion_ready', raisedAt: new Date(T0).toISOString() }));
    expect(s.endedReason).toBe('supervisor-finished');
  });

  it('a cancelled supervisor ends as operator', async () => {
    expect((await endedWith((id) => h.store.cancelTask(id))).endedReason).toBe('operator');
  });

  it.each(['manual', 'supervisor'] as const)('a supervisor terminated with reason %s ends as operator', async (reason) => {
    expect((await endedWith((id) => h.store.terminateTask(id, { reason }))).endedReason).toBe('operator');
  });

  it('a supervisor task deleted from the store is not a crash: ends as operator', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: 'gone-task' });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.endedReason).toBe('operator');
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    void sv;
  });

  it.each(['server-restart', 'oom', 'timeout', 'unknown'] as const)('a supervisor terminated by %s is a crash and IS restarted', async (reason) => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.store.terminateTask(sv, { reason });
    h.seed({ supervisorTaskId: sv });
    h.launchSupervisor.mockResolvedValueOnce({ taskId: h.store.createTask('sup2', '/cwd').id });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
  });
});

describe('operator end', () => {
  it('ends the mandate as operator, cancels no task, is idempotent, and stops all later actuation', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: sv });
    const svc = settledService();
    const status = await svc.end('sup-1');
    expect(status?.health).toBe('ended');
    expect(status?.state.endedReason).toBe('operator');
    const endedAt = readSupervisionState(h.dir, 'sup-1')!.endedAt;
    expect((await svc.end('sup-1'))?.state.endedAt).toBe(endedAt);
    expect(h.abortTask).not.toHaveBeenCalled();
    expect(h.store.getTask(sv)!.status).toBe('inProgress');
    h.clock.t = T0 + 500 * MIN;
    await svc.tick();
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
  });

  it('is undefined for an unknown id', async () => {
    expect(await h.make().end('nope')).toBeUndefined();
  });
});

describe('failed or unrecorded launches', () => {
  const KEY = 'supervise-sup-1';

  it('inside the grace window a P1 file with no supervisor is left alone', async () => {
    h.seed();
    h.clock.t = T0 + 4 * MIN;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.endedAt).toBeUndefined();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
  });

  it('after the grace window it ADOPTS the task created under supervise-<id> and writes the edges; never relaunches', async () => {
    const target = h.store.createTask('worker', '/cwd');
    h.store.startTask(target.id);
    const created = h.store.createTask({
      prompt: 'brief', cwd: '/cwd',
      launchIntent: buildTaskLaunchIntent('claude-code', { idempotencyKey: KEY }),
    } as never);
    h.seed({ targets: [{ taskId: target.id, name: 'worker' }] });
    h.clock.t = T0 + 6 * MIN;
    await settledService().tick();
    const state = readSupervisionState(h.dir, 'sup-1')!;
    expect(state.supervisorTaskId).toBe(created.id);
    expect(state.endedAt).toBeUndefined();
    expect(h.store.listRelations({ sourceTaskId: created.id, type: 'supervises' }).map((r) => r.targetTaskId)).toEqual([target.id]);
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
  });

  it('with no such task it ends the mandate launch-failed with exactly one alert (never restarts)', async () => {
    h.seed();
    h.clock.t = T0 + 6 * MIN;
    const svc = settledService();
    await svc.tick();
    const state = readSupervisionState(h.dir, 'sup-1')!;
    expect([state.endedReason, state.health]).toEqual(['launch-failed', 'ended']);
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.alert.mock.calls[0][0].severity).toBe('critical');
    await svc.tick();
    await settledService().tick();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(h.launchSupervisor).not.toHaveBeenCalled();
  });

  it('an already-ended (CLI-marked launch-failed) file is untouched: no adoption, no alert', async () => {
    h.seed({ endedAt: new Date(T0).toISOString(), endedReason: 'launch-failed', health: 'ended' });
    h.store.createTask({ prompt: 'x', cwd: '/cwd', launchIntent: buildTaskLaunchIntent('claude-code', { idempotencyKey: KEY }) } as never);
    h.clock.t = T0 + 60 * MIN;
    await settledService().tick();
    expect(h.alert).not.toHaveBeenCalled();
    expect(readSupervisionState(h.dir, 'sup-1')!.supervisorTaskId).toBeNull();
  });
});

describe('autonomy gate', () => {
  /** One live (heartbeat due) and one crashed supervision, ticked at heartbeat time. */
  async function liveAndDead(over: Partial<SupervisionServiceDeps>): Promise<void> {
    const live = h.liveTask('sup', 'kookr-sv');
    const dead = h.liveTask('dead', 'kookr-dead');
    h.store.terminateTask(dead);
    h.seed({ supervisionId: 'sup-live', supervisorTaskId: live });
    h.seed({ supervisionId: 'sup-dead', supervisorTaskId: dead });
    h.launchSupervisor.mockResolvedValue({ taskId: h.store.createTask('sup2', '/cwd').id });
    h.clock.t = T0 + 50 * MIN;
    await settledService(over).tick();
  }

  it('gate OPEN: the live supervisor is woken and the crashed one is restarted; no alerts', async () => {
    await liveAndDead({});
    expect(h.sendInput).toHaveBeenCalledTimes(1);
    expect(h.sendInput.mock.calls[0][0]).toBe('kookr-sv');
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
    expect(h.alert).not.toHaveBeenCalled();
    expect(h.make().get('sup-live')?.wakesEnabled).toBe(true);
  });

  it.each([
    ['kill switch env', { env: { KOOKR_SUPERVISION_WAKE_DISABLED: '1' } }],
    ['SAFE MODE', { isAutomationEnabled: () => false }],
    ['drain', { isAccepting: () => false }],
  ] as Array<[string, Partial<SupervisionServiceDeps>]>)('%s: no delivery, no restart; status works; one wakes-disabled alert and one dead alert', async (_name, over) => {
    await liveAndDead(over);
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    const summaries = h.alert.mock.calls.map((c) => c[0].summary as string).sort();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toContain('sup-dead');
    expect(summaries[0]).toContain('supervisor-dead-wakes-disabled');
    expect(summaries[1]).toContain('sup-live');
    expect(summaries[1]).toContain('wakes-disabled');
    const svc = h.make(over);
    expect(svc.list().map((s) => [s.supervisionId, s.health])).toEqual([['sup-dead', 'dead'], ['sup-live', 'healthy']]);
    // wakesEnabled reflects the gate (SAFE MODE / drain as of the last tick, kill switch live)
    const ticked = settledService(over);
    await ticked.tick();
    expect(ticked.get('sup-live')?.wakesEnabled).toBe(false);
  });

  it('wakes-disabled alerts once across ticks and fresh service instances, and a different reason fires again', async () => {
    const live = h.liveTask('sup', 'kookr-sv');
    h.seed({ supervisorTaskId: live });
    h.clock.t = T0 + 10 * MIN;
    const off = { env: { KOOKR_SUPERVISION_WAKE_DISABLED: '1' } };
    const first = settledService(off);
    await first.tick();
    await first.tick();
    await settledService(off).tick();
    await settledService(off).tick();
    expect(h.alert).toHaveBeenCalledTimes(1);
    expect(readSupervisionState(h.dir, 'sup-1')!.lastAlertReason).toBe('wakes-disabled');
    // the supervisor then crashes while still gated: a different reason, so it alerts again (once)
    h.store.terminateTask(live);
    await settledService(off).tick();
    await settledService(off).tick();
    expect(h.alert).toHaveBeenCalledTimes(2);
    expect(h.alert.mock.calls[1][0].summary).toContain('supervisor-dead-wakes-disabled');
  });

  it('pauses on the SUPERVISOR task\'s project, not the server\'s: the supervisor cwd is what is looked up', async () => {
    const supTask = h.store.createTask('sup', '/proj-sup');
    h.store.startTask(supTask.id);
    h.store.addSession(supTask.id, { tmuxSession: 'kookr-sv', agentType: 'claude-code', cwd: '/proj-sup', createdAt: new Date(T0) });
    h.events.set('kookr-sv', [{ type: 'stop' } as AgentEvent]);
    h.counts['kookr-sv'] = 1;
    h.seed({ supervisorTaskId: supTask.id });
    const asked: string[] = [];
    const over: Partial<SupervisionServiceDeps> = {
      defaultCwd: '/server-cwd',
      getProjectId: (cwd) => { asked.push(cwd); return cwd === '/proj-sup' ? 'github.com/o/sup' : 'github.com/o/server'; },
      getPausedProjectIds: () => new Set(['github.com/o/sup']),
    };
    h.clock.t = T0 + 50 * MIN;
    await settledService(over).tick();
    expect(asked).toContain('/proj-sup');
    expect(asked).not.toContain('/server-cwd');
    expect(h.sendInput).not.toHaveBeenCalled();
    // pausing only the server's project does not stop this supervisor
    await settledService({ ...over, getPausedProjectIds: () => new Set(['github.com/o/server']) }).tick();
    expect(h.sendInput).toHaveBeenCalledTimes(1);
  });

});

describe('startup recovery gate', () => {
  async function crashedSupervision(reason: 'unknown' | 'server-restart' = 'unknown'): Promise<string> {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.store.terminateTask(sv, { reason });
    h.seed({ supervisorTaskId: sv });
    h.launchSupervisor.mockResolvedValue({ taskId: h.store.createTask('sup2', '/cwd').id });
    return sv;
  }

  it('with startup recovery incomplete NOTHING actuates, however long it takes (deliveries, restarts, adoption, alerts)', async () => {
    await crashedSupervision();
    const live = h.liveTask('live', 'kookr-live');
    h.seed({ supervisionId: 'sup-live', supervisorTaskId: live });
    h.seed({ supervisionId: 'sup-p1' }); // never recorded a supervisor: would be ended launch-failed + alert
    const svc = h.make({ getStartupReadyAtMs: () => undefined });
    for (const m of [3, 10, 60, 500]) {
      h.clock.t = T0 + m * MIN;
      await svc.tick();
    }
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.sendInput).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(readSupervisionState(h.dir, 'sup-p1')!.endedAt).toBeUndefined();
  });

  it('after recovery completes it still waits out the settle window, then acts', async () => {
    await crashedSupervision();
    const readyAt = T0 + 20 * MIN;
    const svc = h.make({ getStartupReadyAtMs: () => readyAt });
    h.clock.t = readyAt + SUPERVISION_SETTLE_MS - 1;
    await svc.tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    h.clock.t = readyAt + SUPERVISION_SETTLE_MS;
    await svc.tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
  });

  it('a recoverable termination moments ago is "recovering": not restarted, re-checked next tick', async () => {
    const sv = await crashedSupervision('server-restart');
    h.clock.t = T0 + 30_000; // terminated "just now" relative to the clock; recovery may still relaunch it
    const svc = settledService();
    await svc.tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    expect(h.alert).not.toHaveBeenCalled();
    expect(readSupervisionState(h.dir, 'sup-1')!.supervisorTaskId).toBe(sv);
  });

  it('the same task, still terminal once recovery has had time, is a crash and IS restarted', async () => {
    await crashedSupervision('server-restart');
    h.clock.t = T0 + 30_000;
    const svc = settledService();
    await svc.tick();
    expect(h.launchSupervisor).not.toHaveBeenCalled();
    h.clock.t = T0 + 5 * MIN;
    await svc.tick();
    expect(h.launchSupervisor).toHaveBeenCalledTimes(1);
  });

  it('a non-recoverable end is never "recovering" (operator end is recorded at once)', async () => {
    const sv = h.liveTask('sup', 'kookr-sv');
    h.store.terminateTask(sv, { reason: 'manual' });
    h.seed({ supervisorTaskId: sv });
    h.clock.t = T0 + 30_000;
    await settledService().tick();
    expect(readSupervisionState(h.dir, 'sup-1')!.endedReason).toBe('operator');
  });
});

describe('alert dedup', () => {
  it('restart-limit-reached alerts once across fresh instances', async () => {
    const oldSv = h.liveTask('sup', 'kookr-old');
    h.store.terminateTask(oldSv);
    h.seed({ supervisorTaskId: oldSv, restartCount: 3, lastRestartAt: new Date(T0 - 500 * MIN).toISOString() });
    h.clock.t = T0 + 10 * MIN;
    await settledService().tick();
    await settledService().tick();
    expect(h.alert).toHaveBeenCalledTimes(1);
  });
});

describe('status', () => {
  it('derives health, next wake and target status', () => {
    const live = h.liveTask('sup', 'kookr-sv');
    const w = h.store.createTask('worker', '/cwd');
    h.store.startTask(w.id);
    h.seed({ supervisorTaskId: live, targets: [{ taskId: w.id, name: 'worker' }] });
    const status = h.make().get('sup-1')!;
    expect(status.health).toBe('healthy');
    expect(status.nextWake?.kind).toBe('heartbeat');
    expect(status.targets[0]).toMatchObject({ taskId: w.id, status: 'inProgress' });
    expect(status.supervisor).toMatchObject({ taskId: live, hasLiveSession: true, deliverable: true });
    h.store.terminateTask(live);
    expect(h.make().get('sup-1')!.health).toBe('dead');
  });

  it('get() is undefined for unknown or path-like ids', () => {
    expect(h.make().get('nope')).toBeUndefined();
    expect(h.make().get('../x')).toBeUndefined();
  });
});
