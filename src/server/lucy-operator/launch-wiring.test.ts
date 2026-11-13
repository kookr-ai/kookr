import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { scriptedModel } from '../../core/lucy-operator/__fixtures__/scripted.js';
import type { RouteDeps } from '../routes/shared.js';

const summaries = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../routes/project-routes.js', () => ({ listProjectSummaries: async () => summaries.list }));
const launched = vi.hoisted(() => ({ calls: [] as Array<{ opts: unknown; server: unknown }> }));
vi.mock('../launch-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../launch-service.js')>()),
  launchTask: async (_deps: unknown, opts: unknown, server: unknown) => { launched.calls.push({ opts, server }); return { task: { id: 'task-7' } }; },
}));

import { buildLucyLaunchController, lucyLaunchableProjects, lucyLaunchRoomCheck } from './launch-wiring.js';

const activeTask = (id: string) => ({ id, status: 'inProgress', sessions: [{ tmuxSession: `s-${id}`, lastStatus: 'running' }], createdAt: new Date(), updatedAt: new Date() });

function deps(overrides: Record<string, unknown> = {}): RouteDeps {
  return {
    launchServiceDeps: {
      taskStore: { listTasks: () => [], hasFreshActiveLaunchReservation: () => false },
      getMaxActiveTasks: () => 2,
    },
    settings: { get: () => ({}) },
    ...overrides,
  } as unknown as RouteDeps;
}

beforeEach(() => {
  summaries.list = [];
  launched.calls = [];
});

describe('lucyLaunchableProjects', () => {
  test('lists tracked projects and local ones that have a folder, by the name the dashboard shows', async () => {
    summaries.list = [
      { project: 'github.com/o/kookr', displayName: 'kookr', localPath: '/work/kookr', tracked: true },
      { project: 'local/research', displayName: 'research', localPath: '/work/research' },
      { project: 'github.com/o/untracked', displayName: 'untracked', localPath: '/work/untracked', tracked: false },
      { project: 'github.com/o/nopath', displayName: 'nopath', tracked: true },
      { project: 'github.com/o/dupe', displayName: 'kookr again', localPath: '/work/kookr', tracked: true },
    ];
    expect(await lucyLaunchableProjects(deps())).toEqual([
      { name: 'kookr', cwd: '/work/kookr' },
      { name: 'research', cwd: '/work/research' },
    ]);
  });
});

describe('lucyLaunchRoomCheck', () => {
  test('is clear when a slot is free', () => {
    expect(lucyLaunchRoomCheck(deps())()).toBeNull();
  });

  test('refuses, rather than queues, when every slot is taken', () => {
    const full = deps({
      launchServiceDeps: {
        taskStore: { listTasks: () => [activeTask('a'), activeTask('b')], hasFreshActiveLaunchReservation: () => false },
        getMaxActiveTasks: () => 2,
      },
    });
    expect(lucyLaunchRoomCheck(full)()).toBe('All 2 task slots are busy, so I cannot start another one now.');
  });

  test('refuses when the data directory disk is critical', () => {
    const critical = deps({
      getLatestResourceStatus: () => ({
        sampledAt: new Date().toISOString(),
        server: { eventLoopDelayP95Ms: 1 },
        host: { dataDirectory: { diskFreePercent: 0.1, diskFreeBytes: 1, diskFreeInodes: 1000, diskTotalInodes: 1000, path: '/data' } },
      }),
      diskAdmissionTracker: { observe: () => {}, isCritical: () => true, getPressureCause: () => 'bytes' },
    });
    expect(lucyLaunchRoomCheck(critical)()).toMatch(/low on disk/);
  });
});

describe('buildLucyLaunchController', () => {
  const projects = [{ project: 'github.com/o/kookr', displayName: 'kookr', localPath: '/work/kookr', tracked: true }];
  const spec = JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'Find out why issue tasks stop chaining.' });

  async function propose(routeDeps: RouteDeps) {
    const model = scriptedModel([{ text: spec }]);
    const controller = buildLucyLaunchController(routeDeps, model.port, undefined);
    const result = await controller.propose({ conversationId: 'c1', operatorWords: ['investigate why issue tasks stop chaining'] });
    return { controller, model, result };
  }

  test('the task is written by one model call with no tools, from the operator\'s words and the project names', async () => {
    summaries.list = projects;
    const { model, result } = await propose(deps());
    expect(result.ok).toBe(true);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.tools).toEqual([]);
    expect(model.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(model.requests[0]!.messages[1]).toEqual({ role: 'user', content: 'investigate why issue tasks stop chaining' });
  });

  test.each([
    [{}, {}],
    [{ lucyAutonomy: 'balanced' }, {}],
    [{ lucyAutonomy: 'careful' }, { bypassPermissions: false }],
    [{ lucyAutonomy: 'hands-off' }, { bypassPermissions: true }],
  ])('settings %j launch with server options %j, and the attribution lucy-operator', async (settings, expected) => {
    summaries.list = projects;
    const current = { value: settings as Record<string, unknown> };
    const { controller, result } = await propose(deps({ settings: { get: () => current.value } }));
    if (!result.ok) throw new Error('no proposal');
    // The setting is read at launch time: change it between the card and the confirmation.
    if (settings.lucyAutonomy === 'hands-off') current.value = { lucyAutonomy: 'hands-off' };
    const outcome = await controller.confirm('c1', result.proposal.id, 'click');
    controller.dispose();
    expect(outcome).toMatchObject({ outcome: 'launched', taskId: 'task-7' });
    // The spec is an investigation, so delivery is also ask-first; the permission part is what the level decides.
    expect(launched.calls[0]!.server).toEqual({ ...expected, deliveryPolicy: 'ask-first' });
    expect(launched.calls[0]!.opts).toMatchObject({ cwd: '/work/kookr', launchActorId: 'lucy-operator', launchSource: 'api' });
  });

  test('every launch leaves an audit row naming lucy-operator, the task, the level and how it was confirmed', async () => {
    summaries.list = projects;
    const dir = mkdtempSync(join(tmpdir(), 'lucy-audit-'));
    try {
      const { controller, result } = await propose(deps({ kookrDir: dir, settings: { get: () => ({ lucyAutonomy: 'careful' }) } }));
      if (!result.ok) throw new Error('no proposal');
      await controller.confirm('c1', result.proposal.id, 'enter');
      await vi.waitFor(() => expect(existsSync(join(dir, 'audit.jsonl'))).toBe(true));
      const row = JSON.parse(readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
      expect(row).toMatchObject({
        type: 'task.launch', actor: 'lucy-operator', taskId: 'task-7', proposalId: result.proposal.id,
        level: 'careful', via: 'enter', project: 'kookr', kind: 'investigation', queued: false, duplicate: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every proposal and outcome is sent to the owner dashboards only', async () => {
    summaries.list = projects;
    const sent: unknown[] = [];
    const everyone: unknown[] = [];
    const { controller, result } = await propose(deps({ emitToOwners: (m: unknown) => sent.push(m), broadcastToAll: (m: unknown) => everyone.push(m) }));
    if (!result.ok) throw new Error('no proposal');
    await controller.confirm('c1', result.proposal.id, 'click');
    expect(sent.map((m) => Object.keys(m as object).filter((k) => ['proposal', 'outcome'].includes(k)))).toEqual([['proposal'], ['outcome']]);
    // Never through the broadcast that read-only viewers also receive.
    expect(everyone).toEqual([]);
  });
});
