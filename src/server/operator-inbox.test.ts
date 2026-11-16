import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { createApiAuthMiddleware, type ApiAuthConfig } from './auth.js';
import { buildOperatorInbox, readOperatorInbox, type OperatorInboxMonitorView } from './operator-inbox.js';
import { registerOperatorInboxRoutes } from './routes/operator-inbox-routes.js';
import { fixtureInbox, fixtureSources, KOOKR_CWD, NOW, PLANTED_COMMAND, PLANTED_TOKEN, WEBSITE_CWD } from '../../test/fixtures/operator-inbox.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';

describe('buildOperatorInbox', () => {
  test('one item of each kind in two projects: five items, oldest first, with the totals line', () => {
    const inbox = fixtureInbox();
    expect(inbox.items.map((item) => [item.kind, item.taskId ?? null, item.project ?? null])).toEqual([
      ['permission', 'perm', 'kookr'],
      ['question', 'ask', 'website'],
      ['flagged', 'flag', 'website'],
      ['review', 'review', 'kookr'],
      ['train', null, null],
    ]);
    expect(inbox.summary).toBe('5 waiting: 1 permission prompt, 1 question, 1 flagged task, 1 review, train halted');
    expect(inbox.totals).toEqual({ permission: 1, question: 1, flagged: 1, review: 1, train: 1 });
    expect(inbox.working).toEqual({ tasks: 5, projects: 2 });
  });

  test('each item says what it is, since when, how to answer, and links to its task', () => {
    const [permission, question, flagged, review, train] = fixtureInbox().items;
    expect(permission).toMatchObject({
      summary: 'wants permission to use Bash',
      toolName: 'Bash',
      command: PLANTED_COMMAND,
      since: '2026-11-16T11:10:00.000Z',
      link: '/?task=perm',
      cwd: KOOKR_CWD,
    });
    expect(permission.howToAnswer).toMatch(/approve or deny/);
    expect(question).toMatchObject({ askId: 'a1b2c3d4e5f6', options: ['Compact list', 'Cards'], since: '2026-11-16T11:20:00.000Z' });
    expect(question.question).toContain('Which layout');
    expect(question.question).not.toContain(PLANTED_TOKEN);
    expect(flagged).toMatchObject({ summary: 'keeps hitting the same error', findingType: 'repeated_error' });
    expect(flagged.taskName).not.toContain(PLANTED_TOKEN);
    expect(review).toMatchObject({ summary: 'says it is finished and wants your review', since: '2026-11-16T11:40:00.000Z' });
    expect(train).toMatchObject({ trainState: 'base-red', since: '2026-11-16T11:50:00.000Z' });
    expect(train.summary).toBe('The integration train is halted: main itself fails the full suite.');
    expect(train.howToAnswer).toContain('pnpm train:resume');
  });

  test('an empty inbox says so and counts the tasks that are working', () => {
    const base = fixtureSources();
    const inbox = buildOperatorInbox({
      ...base,
      liveTasks: base.liveTasks.filter((task) => task.id === 'work' || task.id === 'ask').map((task) => ({ ...task, pendingSignal: undefined })),
      monitor: { getCurrentAnomaly: () => null, getAgentEvents: () => [], getAgentState: () => ({ anomaly: null }) },
      asks: [],
      train: null,
    });
    expect(inbox.items).toEqual([]);
    expect(inbox.summary).toBe('Nothing is waiting on you. 2 tasks are working in 2 projects.');
    expect(buildOperatorInbox({ ...base, liveTasks: [], asks: [], train: null }).summary)
      .toBe('Nothing is waiting on you. No tasks are working.');
  });

  test('a task that will close by itself is not a review; a snoozed finding is not listed', () => {
    const base = fixtureSources();
    const snoozed: OperatorInboxMonitorView = {
      ...base.monitor,
      getAgentState: (id) => ({ anomaly: base.monitor.getAgentState(id)?.anomaly ?? null, snoozedUntil: NOW + 60_000 }),
    };
    const inbox = buildOperatorInbox({
      ...base,
      liveTasks: base.liveTasks.map((task) => (task.id === 'review' ? { ...task, autoCloseOnSignal: true } : task)),
      monitor: snoozed,
    });
    expect(inbox.items.map((item) => item.kind)).toEqual(['permission', 'question', 'train']);
  });

  test('a task is listed once: a review wins over its turn-complete finding', () => {
    const base = fixtureSources();
    const stop: Anomaly = { agentId: 's-review', type: 'needs_input', subType: 'stop', severity: 'info', explanation: 'Turn complete', detectedAt: new Date(NOW - 5 * 60_000) };
    const inbox = buildOperatorInbox({
      ...base,
      monitor: { ...base.monitor, getAgentState: (id) => ({ anomaly: id === 's-review' ? stop : base.monitor.getAgentState(id)?.anomaly ?? null }) },
    });
    expect(inbox.items.filter((item) => item.taskId === 'review').map((item) => item.kind)).toEqual(['review']);
  });

  test('a stalled train is listed with its pending time; a quiet train is not', () => {
    const base = fixtureSources();
    const stalled = buildOperatorInbox({ ...base, train: { ...base.train!, halted: null, running: false } });
    const train = stalled.items.find((item) => item.kind === 'train');
    expect(train).toMatchObject({ trainState: 'stalled', since: '2026-11-16T11:45:00.000Z' });
    expect(stalled.summary).toMatch(/train stalled$/);
    const quiet = buildOperatorInbox({ ...base, train: { ...base.train!, halted: null, alerting: false } });
    expect(quiet.items.some((item) => item.kind === 'train')).toBe(false);
  });

  test('an unreadable time sorts as newest instead of breaking the order', () => {
    const base = fixtureSources();
    const inbox = buildOperatorInbox({ ...base, train: { ...base.train!, halted: { reason: 'base-red', at: '' } } });
    expect(inbox.items.at(-1)).toMatchObject({ kind: 'train', since: new Date(NOW).toISOString() });
  });

  test('an unattended task stopped from an interactive tool is flagged', () => {
    const base = fixtureSources();
    const inbox = buildOperatorInbox({
      ...base,
      liveTasks: [{
        ...base.liveTasks[4],
        operatorNeeded: { reason: 'interactive_tool_denied', toolName: 'AskUserQuestion', detectedAt: new Date(NOW - 60_000), message: 'm' },
      }],
      asks: [],
      train: null,
    });
    expect(inbox.items).toEqual([expect.objectContaining({ kind: 'flagged', findingType: 'operator_needed', summary: expect.stringContaining('AskUserQuestion') })]);
  });

  test('only pending questions are listed, and their options are redacted', () => {
    const base = fixtureSources();
    const [pending] = base.asks;
    const inbox = buildOperatorInbox({
      ...base,
      asks: [
        { ...pending, options: ['Compact list', `Cards ${PLANTED_TOKEN}`] },
        { ...pending, id: 'answered1', state: 'answered' },
        { ...pending, id: 'expired1', state: 'expired' },
        { ...pending, id: 'cancelled1', state: 'cancelled' },
      ],
    });
    const questions = inbox.items.filter((item) => item.kind === 'question');
    expect(questions.map((item) => item.askId)).toEqual(['a1b2c3d4e5f6']);
    expect(questions[0].options).toHaveLength(2);
    expect(questions[0].options!.join(' ')).not.toContain(PLANTED_TOKEN);
    expect(inbox.totals.question).toBe(1);
  });

  test('a suppressed finding is not listed', () => {
    const base = fixtureSources();
    const inbox = buildOperatorInbox({
      ...base,
      monitor: {
        ...base.monitor,
        getAgentState: (id) => ({ anomaly: base.monitor.getAgentState(id)?.anomaly ?? null, ...(id === 's-flag' ? { suppressed: true } : {}) }),
      },
    });
    expect(inbox.items.some((item) => item.kind === 'flagged')).toBe(false);
    expect(inbox.items.map((item) => item.kind)).toEqual(['permission', 'question', 'review', 'train']);
  });

  test('a question whose task is no longer live still names its task through getTask', () => {
    const base = fixtureSources();
    const asker = base.liveTasks.find((task) => task.id === 'ask')!;
    const inbox = buildOperatorInbox({
      ...base,
      liveTasks: base.liveTasks.filter((task) => task.id !== 'ask'),
      getTask: (taskId) => (taskId === 'ask' ? { ...asker, status: 'completed' } : undefined),
    });
    expect(inbox.items.find((item) => item.kind === 'question')).toMatchObject({
      taskId: 'ask',
      taskName: 'Redesign settings page',
      project: 'website',
      cwd: WEBSITE_CWD,
      link: '/?task=ask',
    });
  });

  test('a task is labelled with its project id before its directory name', () => {
    const base = fixtureSources();
    const inbox = buildOperatorInbox({
      ...base,
      liveTasks: base.liveTasks.map((task) => (task.id === 'perm' || task.id === 'work'
        ? { ...task, cwd: '/home/op/git/kookr-worktree-x', projectId: 'kookr-ai/kookr' }
        : task)),
    });
    expect(inbox.items.find((item) => item.kind === 'permission')).toMatchObject({ project: 'kookr-ai/kookr', cwd: '/home/op/git/kookr-worktree-x' });
    // perm and work share the project id; review is still labelled by its folder "kookr"; ask and flag are "website".
    expect(inbox.working).toEqual({ tasks: 5, projects: 3 });
  });
});

describe('GET /api/operator/inbox', () => {
  const VIEWER = 'viewer-tok';
  const auth: ApiAuthConfig = {
    required: true,
    token: 'owner-tok',
    resolveViewer: (token) => (token === VIEWER ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } } : { kind: 'not-found' }),
  };

  function app() {
    // Real task store: a task that raised completion_ready shows as a review.
    const taskStore = new TaskStore();
    const created = taskStore.createTask({ prompt: 'Fix the login redirect', cwd: '/home/op/git/kookr', name: 'Fix login redirect' });
    taskStore.addSession(created.id, { tmuxSession: 'sess-1', agentType: 'claude-code', cwd: '/home/op/git/kookr', createdAt: new Date() });
    taskStore.setPendingSignal(created.id, { kind: 'completion_ready', raisedAt: new Date().toISOString() });
    const monitor: OperatorInboxMonitorView = { getCurrentAnomaly: () => null, getAgentEvents: () => [], getAgentState: () => undefined };
    const hono = new Hono();
    hono.use('*', createApiAuthMiddleware(auth));
    registerOperatorInboxRoutes(hono, { taskStore, monitor });
    return { hono, taskId: created.id };
  }

  test('the owner gets the inbox built from the task store', async () => {
    const { hono, taskId } = app();
    const res = await hono.request('http://lan.example/api/operator/inbox', { headers: { authorization: 'Bearer owner-tok' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ schema: 'kookr.operator-inbox.v1', summary: '1 waiting: 1 review' });
    expect(body.items).toEqual([expect.objectContaining({ kind: 'review', taskId, taskName: 'Fix login redirect', project: 'kookr' })]);
  });

  test('a read-only viewer is refused and gets no inbox data; no credential is 401', async () => {
    const res = await app().hono.request('http://lan.example/api/operator/inbox', { headers: { authorization: `Bearer ${VIEWER}` } });
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('items');
    const anonymous = await app().hono.request('http://lan.example/api/operator/inbox');
    expect(anonymous.status).toBe(401);
  });

  test('serves the five-item fixture from its task store, monitor, asks and train, oldest first', async () => {
    const sources = fixtureSources();
    const byId = new Map(sources.liveTasks.map((task) => [task.id, task]));
    const hono = new Hono();
    hono.use('*', createApiAuthMiddleware(auth));
    registerOperatorInboxRoutes(hono, {
      taskStore: { viewLiveTasks: () => sources.liveTasks, getTask: (id) => byId.get(id) },
      monitor: sources.monitor,
      asks: { all: () => [...sources.asks] },
      train: { getHealthSnapshot: () => sources.train },
      now: () => NOW,
    });
    const res = await hono.request('http://lan.example/api/operator/inbox', { headers: { authorization: 'Bearer owner-tok' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toBe('5 waiting: 1 permission prompt, 1 question, 1 flagged task, 1 review, train halted');
    expect(body.items.map((item: { kind: string }) => item.kind)).toEqual(['permission', 'question', 'flagged', 'review', 'train']);
    expect(body.items[0].command).toBe(PLANTED_COMMAND);
  });

  test('readOperatorInbox survives a failing train read', () => {
    const store = new TaskStore();
    const inbox = readOperatorInbox({
      taskStore: store,
      monitor: { getCurrentAnomaly: () => null, getAgentEvents: () => [], getAgentState: () => undefined },
      train: { getHealthSnapshot: () => { throw new Error('unreadable'); } },
      now: () => NOW,
    });
    expect(inbox.summary).toBe('Nothing is waiting on you. No tasks are working.');
  });
});
