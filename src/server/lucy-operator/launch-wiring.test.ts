import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// The id of the repository the server runs from is read with git; here a test decides what git answers.
const ownRepo = vi.hoisted(() => ({ id: 'local/cwd' as string, calls: 0, fails: false }));
vi.mock('../../core/project-identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/project-identity.js')>()),
  getProjectId: async () => {
    ownRepo.calls += 1;
    if (ownRepo.fails) throw new Error('git is not here');
    return ownRepo.id;
  },
}));

import { buildLucyLaunchController, kookrOwnProjectId, lucyLaunchableProjects, lucyLaunchRoomCheck, selectLaunchableProjects } from './launch-wiring.js';

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
  ownRepo.id = 'local/cwd';
  ownRepo.calls = 0;
  ownRepo.fails = false;
});

describe('lucyLaunchableProjects', () => {
  test('lists every project that has a folder on this machine, tracked or not, by the name the dashboard shows (issue #4144)', async () => {
    summaries.list = [
      { project: 'github.com/o/kookr', displayName: 'kookr', localPath: '/work/kookr', tracked: true },
      { project: 'local/research', displayName: 'research', localPath: '/work/research' },
      // Not tracked, but it has a folder: the dashboard's Launch dialog offers it, so she does too.
      { project: 'github.com/o/untracked', displayName: 'untracked', localPath: '/work/untracked', tracked: false },
      // Tracked, but no folder here: nowhere to launch.
      { project: 'github.com/o/nopath', displayName: 'nopath', tracked: true },
      { project: 'github.com/o/blank', displayName: 'blank', localPath: '   ', tracked: true },
      { project: 'github.com/o/dupe', displayName: 'kookr again', localPath: '/work/kookr', tracked: true },
    ];
    expect(await lucyLaunchableProjects(deps())).toEqual([
      { name: 'kookr', cwd: '/work/kookr' },
      { name: 'research', cwd: '/work/research' },
      { name: 'untracked', cwd: '/work/untracked' },
    ]);
  });

  test('carries when a task was last started in each project, from the tasks Kookr holds', async () => {
    summaries.list = [
      { project: 'github.com/o/a', displayName: 'a', localPath: '/work/a', recentTasks: [{ taskId: '1', status: 'completed', startedAt: '2026-11-17T08:00:00.000Z' }, { taskId: '2', status: 'inProgress', startedAt: '2026-11-17T09:30:00.000Z' }] },
      { project: 'github.com/o/b', displayName: 'b', localPath: '/work/b', recentTasks: [{ taskId: '3', status: 'completed' }, { taskId: '4', status: 'completed', startedAt: 'not a date' }] },
      { project: 'github.com/o/c', displayName: 'c', localPath: '/work/c', recentTasks: [] },
    ];
    expect(await lucyLaunchableProjects(deps())).toEqual([
      { name: 'a', cwd: '/work/a', lastUsedAt: Date.parse('2026-11-17T09:30:00.000Z') },
      { name: 'b', cwd: '/work/b' },
      { name: 'c', cwd: '/work/c' },
    ]);
  });
});

describe('Kookr\'s own project (issue #4144)', () => {
  const list = [
    // A separate repository that happens to be called "lucy": it must never be taken for Kookr.
    { project: 'github.com/someone/lucy', displayName: 'lucy', localPath: '/work/lucy', tracked: true },
    // Production runs from a kookr-prod worktree; the folder recorded for the project is the parent clone.
    { project: 'github.com/kookr-ai/kookr', displayName: 'kookr-ai/kookr', localPath: '/home/op/git/kookr', tracked: false },
    { project: 'local/kookr', displayName: 'kookr', localPath: '/work/other-kookr' },
  ];

  test('is the project whose id is the repository the server runs from: by id, not by name or folder', async () => {
    summaries.list = list;
    ownRepo.id = 'github.com/kookr-ai/kookr';
    expect(await lucyLaunchableProjects(deps({ serverCwd: '/home/op/git/kookr-prod' }))).toEqual([
      { name: 'lucy', cwd: '/work/lucy' },
      { name: 'kookr-ai/kookr', cwd: '/home/op/git/kookr', own: true },
      { name: 'kookr', cwd: '/work/other-kookr' },
    ]);
  });

  test('no project is marked when the server\'s repository is not on the list, or cannot be known', async () => {
    summaries.list = list;
    ownRepo.id = 'github.com/kookr-ai/something-else';
    expect((await lucyLaunchableProjects(deps({ serverCwd: '/srv/a' }))).some((p) => p.own)).toBe(false);
    // No server folder at all (route-only harnesses).
    expect((await lucyLaunchableProjects(deps())).some((p) => p.own)).toBe(false);
  });

  test('a folder name is not proof: `local/kookr` (no git remote) marks nothing, even though a project has that id', async () => {
    summaries.list = list;
    ownRepo.id = 'local/kookr';
    expect((await lucyLaunchableProjects(deps({ serverCwd: '/srv/b/kookr' }))).some((p) => p.own)).toBe(false);
  });

  test('a certain answer is read from git once; an uncertain or failed one is tried again', async () => {
    ownRepo.id = 'local/kookr';
    expect(await kookrOwnProjectId('/srv/c')).toBeUndefined();
    ownRepo.fails = true;
    expect(await kookrOwnProjectId('/srv/c')).toBeUndefined();
    ownRepo.fails = false;
    ownRepo.id = 'github.com/kookr-ai/kookr';
    expect(await kookrOwnProjectId('/srv/c')).toBe('github.com/kookr-ai/kookr');
    expect(await kookrOwnProjectId('/srv/c')).toBe('github.com/kookr-ai/kookr');
    expect(ownRepo.calls).toBe(3);
    expect(await kookrOwnProjectId(undefined)).toBeUndefined();
  });

  test('when the same folder is listed twice, it is offered once and still marked as Kookr', () => {
    const picked = selectLaunchableProjects([
      { project: 'local/kookr', displayName: 'kookr', localPath: '/work/kookr', recentTasks: [{ taskId: '1', status: 'completed', startedAt: '2026-11-17T08:00:00.000Z' }] },
      { project: 'github.com/kookr-ai/kookr', displayName: 'kookr-ai/kookr', localPath: '/work/kookr', recentTasks: [{ taskId: '2', status: 'completed', startedAt: '2026-11-17T10:00:00.000Z' }] },
    ] as never, 'github.com/kookr-ai/kookr');
    expect(picked.map((entry) => entry.project)).toEqual([{ name: 'kookr', cwd: '/work/kookr', own: true, lastUsedAt: Date.parse('2026-11-17T10:00:00.000Z') }]);
  });
});

describe('selectLaunchableProjects', () => {
  test('picks the same projects as lucyLaunchableProjects and keeps each project\'s summary, so list_projects shares the rule', async () => {
    summaries.list = [
      { project: 'github.com/o/kookr', displayName: 'kookr', localPath: '/work/kookr', tracked: true },
      { project: 'github.com/o/untracked', displayName: 'untracked', localPath: '/work/untracked', tracked: false },
      { project: 'github.com/o/dupe', displayName: 'kookr again', localPath: '/work/kookr', tracked: true },
    ];
    const picked = selectLaunchableProjects(summaries.list as never);
    expect(picked.map((entry) => entry.summary)).toEqual([summaries.list[0], summaries.list[1]]);
    expect(picked.map((entry) => entry.project)).toEqual(await lucyLaunchableProjects(deps()));
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
      // The row is written off the request path: wait for a complete, parseable one, not just the file.
      let row: Record<string, unknown> = {};
      await vi.waitFor(() => {
        const text = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
        expect(text.endsWith('\n')).toBe(true);
        row = JSON.parse(text.trim()) as Record<string, unknown>;
      });
      expect(row).toMatchObject({
        type: 'task.launch', actor: 'lucy-operator', taskId: 'task-7', proposalId: result.proposal.id,
        level: 'careful', via: 'enter', project: 'kookr', kind: 'investigation', queued: false, duplicate: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the writer is told which listed project is Kookr itself, and an unclear project is asked for with candidates (issue #4144)', async () => {
    summaries.list = [
      { project: 'github.com/someone/lucy', displayName: 'lucy', localPath: '/work/lucy', tracked: true, recentTasks: [{ taskId: '1', status: 'completed', startedAt: '2026-11-17T10:00:00.000Z' }] },
      { project: 'github.com/kookr-ai/kookr', displayName: 'kookr-ai/kookr', localPath: '/home/op/git/kookr', tracked: false },
      { project: 'github.com/o/docs', displayName: 'o/docs', localPath: '/work/docs', tracked: false, recentTasks: [{ taskId: '2', status: 'completed', startedAt: '2026-11-17T11:00:00.000Z' }] },
    ];
    ownRepo.id = 'github.com/kookr-ai/kookr';
    const model = scriptedModel([{ text: '{"ask":"project"}' }]);
    const controller = buildLucyLaunchController(deps({ serverCwd: '/home/op/git/kookr-prod-wiring' }), model.port, undefined);
    const result = await controller.propose({ conversationId: 'c1', operatorWords: ['start a task to tidy the changelog'] });
    controller.dispose();
    const system = (model.requests[0]!.messages[0] as { content: string }).content;
    expect(system).toContain('- lucy\n- kookr-ai/kookr\n- o/docs');
    expect(system).toContain('The project named "kookr-ai/kookr" is Kookr itself');
    expect(result).toEqual({ ok: false, say: 'Which project: kookr, docs or lucy?', why: 'ambiguous' });
  });

  test('her report on a task she launched goes into the record of what she said unprompted (issue #4143)', async () => {
    summaries.list = projects;
    const recorded: unknown[] = [];
    const { controller, result } = await propose(deps({ lucyUnprompted: { record: (entry: unknown) => recorded.push(entry), recent: () => [] } }));
    if (!result.ok) throw new Error('no proposal');
    await controller.confirm('c1', result.proposal.id, 'click');
    expect(recorded).toEqual([]);
    controller.onTaskOutcome('task-7', { kind: 'completed' }, 'Chaining investigation');
    controller.dispose();
    expect(recorded).toEqual([{
      key: 'launch:task-7',
      text: 'The task I started "Chaining investigation" has finished.',
      tasks: [{ id: 'task-7', name: 'Chaining investigation' }],
    }]);
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
