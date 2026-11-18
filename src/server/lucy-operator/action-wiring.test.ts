import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../routes/project-routes.js', () => ({ listProjectSummaries: async () => [{ project: 'github.com/o/kookr', displayName: 'kookr', localPath: '/work/kookr', tracked: true }] }));
// `buildLucyOperator` makes its own model from the configuration: here it is a script instead of OpenRouter.
const wired = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock('../../adapters/llm/openrouter-chat-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adapters/llm/openrouter-chat-stream.js')>()),
  createOpenRouterChatStream: () => wired.model,
}));

import { scriptedModel, type ScriptedStep } from '../../core/lucy-operator/__fixtures__/scripted.js';
import type { RouteDeps } from '../routes/shared.js';
import type { TaskLifecycleCommandResult } from '../use-cases/task-lifecycle-commands.js';
import { buildLucyActionController, lucyCloseTask } from './action-wiring.js';
import { buildLucyOperator } from './create-lucy-operator.js';

const NOW = Date.now();
const WORDS = ['tell the billing task to rebase on main'];

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', name: 'Billing migration', status: 'inProgress', cwd: '/work/kookr', createdAt: new Date(NOW), updatedAt: new Date(NOW),
    sessions: [{ tmuxSession: 'kookr-old', lastStatus: 'completed' }, { tmuxSession: 'kookr-s1', lastStatus: 'running' }],
    ...overrides,
  };
}
const askRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1b2c3d4e5f6', taskId: 't1', question: 'Which database?', options: ['Postgres', 'SQLite'], allowText: false, state: 'pending',
  createdAt: NOW - 60_000, expiresAt: NOW + 600_000, nonce: 'n', delivery: { chatId: 1, messageId: 2 }, ...overrides,
});

function harness(options: { task?: Record<string, unknown> | null; ports?: Record<string, unknown> | null; awaitingChoice?: boolean; steps?: ScriptedStep[]; complete?: TaskLifecycleCommandResult; extra?: Record<string, unknown> } = {}) {
  const current = { task: options.task === null ? undefined : task(options.task ?? {}) };
  const submitted: Array<{ sessionId: string; text: string }> = [];
  const typed: Array<{ sessionId: string; text: string }> = [];
  const logged: Array<Record<string, unknown>> = [];
  const answered: Array<{ input: unknown; opts: unknown }> = [];
  const completed: Array<{ taskId: string; opts: unknown }> = [];
  const owners: unknown[] = [];
  const everyone: unknown[] = [];
  let snapshots = 0;
  const model = scriptedModel(options.steps ?? [{ text: '{"text":"Rebase on main."}' }]);
  const deps = {
    taskStore: { getTask: (id: string) => (current.task && current.task.id === id ? current.task : undefined) },
    asks: { service: { all: () => [askRecord()] } },
    adapter: { sendInput: async (sessionId: string, text: string) => { typed.push({ sessionId, text }); } },
    monitor: { isAwaitingChoice: () => options.awaitingChoice === true },
    interactionLog: { append: async (row: Record<string, unknown>) => { logged.push(row); } },
    requestSnapshotBroadcast: () => { snapshots += 1; },
    emitToOwners: (message: unknown) => owners.push(message),
    broadcastToAll: (message: unknown) => everyone.push(message),
    ...(options.ports === null ? {} : {
      lucyActionPorts: options.ports ?? {
        answerAsk: async (input: unknown, opts: unknown) => { answered.push({ input, opts }); return { ok: true, ask: {} }; },
        submitReply: async (sessionId: string, text: string) => { submitted.push({ sessionId, text }); },
      },
    }),
    ...options.extra,
  } as unknown as RouteDeps;
  const commands = {
    completeTask: async (taskId: string, opts: unknown) => {
      completed.push({ taskId, opts });
      return options.complete ?? ({ outcome: 'completed', task: { status: 'completed' } } as unknown as TaskLifecycleCommandResult);
    },
  };
  const controller = buildLucyActionController(deps, model.port, undefined, { lifecycleCommands: commands });
  return { controller, deps, model, current, submitted, typed, logged, answered, completed, owners, everyone, snapshots: () => snapshots };
}

async function confirmed(h: ReturnType<typeof harness>, request: Parameters<ReturnType<typeof harness>['controller']['propose']>[0]['request'], words: readonly string[] = WORDS) {
  const result = await h.controller.propose({ conversationId: 'c1', request, operatorWords: words });
  if (!result.ok) throw new Error(`no proposal: ${result.say}`);
  return h.controller.confirm('c1', result.proposal.id, 'click');
}

describe('a reply', () => {
  test('is written by one model call with no tools, from the operator\'s words and nothing else', async () => {
    const h = harness();
    const result = await h.controller.propose({ conversationId: 'c1', request: { kind: 'reply', taskId: 't1' }, operatorWords: WORDS });
    expect(result).toMatchObject({ ok: true, proposal: { text: 'Rebase on main.', taskName: 'Billing migration' } });
    expect(h.model.requests).toHaveLength(1);
    expect(h.model.requests[0]!.tools).toEqual([]);
    expect(h.model.requests[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(h.model.requests[0]!.messages[1]).toEqual({ role: 'user', content: 'tell the billing task to rebase on main' });
    expect(JSON.stringify(h.model.requests[0]!.messages)).not.toMatch(/Billing migration|kookr-s1/);
  });

  test('is typed through the tracked delivery the reply box uses, into the newest session that has not ended', async () => {
    const h = harness();
    expect(await confirmed(h, { kind: 'reply', taskId: 't1' })).toMatchObject({ outcome: 'done', kind: 'reply' });
    expect(h.submitted).toEqual([{ sessionId: 'kookr-s1', text: 'Rebase on main.' }]);
    expect(h.typed).toEqual([]);
    expect(h.snapshots()).toBe(1);
  });

  test('without that delivery it goes through the direct input path, attributed to lucy-operator in the interaction log', async () => {
    const h = harness({ ports: {} });
    expect(await confirmed(h, { kind: 'reply', taskId: 't1' })).toMatchObject({ outcome: 'done' });
    expect(h.typed).toEqual([{ sessionId: 'kookr-s1', text: 'Rebase on main.' }]);
    expect(h.logged).toEqual([expect.objectContaining({ type: 'user_input', agentId: 'kookr-s1', content: 'Rebase on main.', actor: 'lucy-operator' })]);
  });

  test('a task showing a choice prompt refuses it, and she says so in plain words', async () => {
    const h = harness({ ports: {}, awaitingChoice: true });
    const outcome = await confirmed(h, { kind: 'reply', taskId: 't1' });
    expect(outcome).toEqual({ outcome: 'refused', proposalId: expect.any(String), reason: '"Billing migration" is showing a choice prompt, so I did not type anything. Answer that on the task.' });
    expect(h.typed).toEqual([]);
  });

  test.each([
    ['has ended', { status: 'completed' }],
    ['has only ended sessions', { sessions: [{ tmuxSession: 'kookr-old', lastStatus: 'completed' }, { tmuxSession: 'kookr-older', lastStatus: 'aborted' }] }],
    ['has no session yet', { status: 'pending', sessions: [] }],
  ])('a task that %s has no live session to reply to', async (_label, overrides) => {
    const h = harness({ task: overrides });
    expect(await h.controller.propose({ conversationId: 'c1', request: { kind: 'reply', taskId: 't1' }, operatorWords: WORDS })).toMatchObject({ ok: false, why: 'no live session' });
    expect(h.model.requests).toHaveLength(0);
  });
});

describe('an answer', () => {
  test('goes through the audited entry point the panel\'s buttons use, naming lucy-operator', async () => {
    const h = harness();
    expect(await confirmed(h, { kind: 'answer', askId: 'a1b2c3d4e5f6', optionIndex: 1 })).toMatchObject({ outcome: 'done', kind: 'answer', taskId: 't1' });
    expect(h.answered).toEqual([{ input: { askId: 'a1b2c3d4e5f6', optionIndex: 1 }, opts: { actor: 'lucy-operator' } }]);
  });

  test('without a `kookr ask` service she says answering is not available', async () => {
    const h = harness({ ports: {} });
    expect(await h.controller.propose({ conversationId: 'c1', request: { kind: 'answer', askId: 'a1b2c3d4e5f6', optionIndex: 0 }, operatorWords: WORDS })).toMatchObject({ ok: false, say: 'Answering questions is not available on this server.' });
  });
});

describe('a close', () => {
  const finished = { pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW).toISOString() } };

  test('runs the lifecycle command the task routes run, attributed to lucy-operator, and asks for a fresh snapshot', async () => {
    const h = harness({ task: finished });
    expect(await confirmed(h, { kind: 'close', taskId: 't1' }, ['close the billing task'])).toMatchObject({ outcome: 'done', kind: 'close' });
    // No worktree choice is sent: the operator's "clean up on complete" setting applies, as on the HTTP route.
    expect(h.completed).toEqual([{ taskId: 't1', opts: { actor: { source: 'api', actorId: 'lucy-operator' } } }]);
    expect(h.snapshots()).toBe(1);
    expect(h.model.requests).toHaveLength(0);
  });

  test.each([
    ['a pending "finished, please review" signal', { pendingSignal: { kind: 'completion_ready' } }, true],
    ['the record of that signal after the agent\'s last tool calls cleared it', { finishedSignalAt: new Date(NOW).toISOString() }, true],
    ['no signal at all', {}, false],
    ['a signal of another kind', { pendingSignal: { kind: 'needs_help' } }, false],
  ])('%s: says finished = %s', async (_label, overrides, saysFinished) => {
    const h = harness({ task: overrides });
    const result = await h.controller.propose({ conversationId: 'c1', request: { kind: 'close', taskId: 't1' }, operatorWords: ['close it'] });
    expect(result.ok).toBe(saysFinished);
    if (!result.ok) expect(result.say).toBe('"Billing migration" is still working: it has not said it is finished, so I will not close it.');
  });

  test('a task running as a loop is not closed: completing it would only end one round', async () => {
    const h = harness({ task: { ...finished, ralphLoop: { status: 'running', iteration: 1, maxIterations: 5 } } });
    const result = await h.controller.propose({ conversationId: 'c1', request: { kind: 'close', taskId: 't1' }, operatorWords: ['close it'] });
    expect(result).toMatchObject({ ok: false, say: '"Billing migration" runs as a loop, and I cannot close a loop.' });
  });

  test.each([
    [{ outcome: 'completed', task: { status: 'completed' } }, { ok: true }],
    // The integrity guard recorded a provider failure instead of a completion: that is not "closed".
    [{ outcome: 'completed', task: { status: 'terminated' } }, { ok: false, reason: 'Kookr recorded that task as failed instead of closing it, because its last turn ended on a provider error.' }],
    [{ outcome: 'already_terminal', task: { status: 'completed' } }, { ok: false, reason: 'That task was already closed.' }],
    [{ outcome: 'partial_ralph_completion', task: { status: 'inProgress' } }, { ok: false, reason: 'That task runs as a loop, so only its current round was ended.' }],
    [{ outcome: 'not_found', error: 'x' }, { ok: false, reason: 'That task is gone, so I did nothing.' }],
    [{ outcome: 'invalid', code: 'not_in_progress', error: 'Cannot complete a task in status "open"' }, { ok: false, reason: 'Kookr refused to close that task.' }],
  ])('the command answering %j is reported as %j', async (result, expected) => {
    const commands = { completeTask: async () => result as unknown as TaskLifecycleCommandResult };
    expect(await lucyCloseTask(commands, 't1')).toEqual(expected);
  });

  test('a task shared by a contact is never acted on, even if one were in the task store', async () => {
    const h = harness({ task: { id: 'shared:abc', ...finished } });
    for (const kind of ['close', 'reply'] as const) {
      expect(await h.controller.propose({ conversationId: 'c1', request: { kind, taskId: 'shared:abc' }, operatorWords: WORDS })).toMatchObject({ ok: false, say: 'I cannot find that task any more.' });
    }
    expect(h.completed).toEqual([]);
    expect(h.submitted).toEqual([]);
  });

  test('without the lifecycle commands she says closing is not available', async () => {
    const h = harness({ task: finished });
    const controller = buildLucyActionController(h.deps, h.model.port, undefined);
    expect(await controller.propose({ conversationId: 'c1', request: { kind: 'close', taskId: 't1' }, operatorWords: ['close it'] })).toMatchObject({ ok: false, say: 'Closing tasks is not available on this server.' });
  });
});

describe('the trail', () => {
  test('every action leaves an audit row naming lucy-operator, the task and how it was confirmed, and never the text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lucy-action-audit-'));
    try {
      const h = harness({ extra: { kookrDir: dir } });
      const outcome = await confirmed(h, { kind: 'reply', taskId: 't1' });
      // The row is written off the request path: wait for a complete, parseable one, not just the file.
      let row: Record<string, unknown> = {};
      await vi.waitFor(() => {
        const text = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
        expect(text.endsWith('\n')).toBe(true);
        row = JSON.parse(text.trim()) as Record<string, unknown>;
      });
      expect(row).toMatchObject({ type: 'lucy.action', actor: 'lucy-operator', action: 'reply', taskId: 't1', via: 'click', outcome: 'done', proposalId: outcome.proposalId });
      expect(typeof row.timestamp).toBe('string');
      expect(JSON.stringify(row)).not.toContain('Rebase');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('every card and outcome is sent to the owner dashboards only', async () => {
    const h = harness();
    await confirmed(h, { kind: 'reply', taskId: 't1' });
    expect(h.owners.map((m) => [(m as { type: string }).type, Object.keys(m as object).filter((k) => ['proposal', 'outcome'].includes(k))])).toEqual([['lucy_action', ['proposal']], ['lucy_action', ['outcome']]]);
    // Never through the broadcast that read-only viewers also receive.
    expect(h.everyone).toEqual([]);
  });
});

describe('buildLucyOperator', () => {
  const model = { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9', providers: [], reasoning: 'medium' as const };
  const routeDeps = (launch: boolean): RouteDeps => ({
    ...harness().deps,
    lucyOperatorConfig: { enabled: true, ok: true, warnings: [], model, launch },
    settings: { get: () => ({}) },
    launchServiceDeps: { taskStore: { listTasks: () => [], hasFreshActiveLaunchReservation: () => false }, getMaxActiveTasks: () => 2 },
    queue: { inspectActive: () => [] },
    githubStateStore: { getReferences: () => [], getTaskState: () => ({ prs: [] }) },
  } as unknown as RouteDeps);

  test('she may act on tasks exactly when launching is on: one switch for everything that changes something', () => {
    wired.model = scriptedModel([]).port;
    const on = buildLucyOperator(routeDeps(true));
    expect(on?.service?.launch).toBeDefined();
    expect(on?.service?.actions).toBeDefined();
    const off = buildLucyOperator(routeDeps(false));
    expect(off?.service).toBeDefined();
    expect(off?.service?.launch).toBeUndefined();
    expect(off?.service?.actions).toBeUndefined();
    on?.service?.launch?.dispose();
  });

  test('every turn is shown what she said unprompted, read from the server\'s record for that conversation (issue #4143)', async () => {
    const script = scriptedModel([{ text: 'Press Approve once.' }]);
    wired.model = script.port;
    const asked: Array<string | undefined> = [];
    const deps = {
      ...routeDeps(false),
      taskStore: { viewTasks: () => [task()], getTask: () => task(), getLifetimeSpendUsd: () => 0 },
      lucyUnprompted: {
        record: () => {},
        recent: (conversationId?: string) => {
          asked.push(conversationId);
          return [{ text: 'The task "Billing migration" is waiting for your permission to use Bash. The command is on my card.', at: Date.now() - 20_000, tasks: [{ id: 't1', name: 'Billing migration' }] }];
        },
      },
    } as unknown as RouteDeps;
    const service = buildLucyOperator(deps)!.service!;
    for await (const _ of service.runTurn({ text: 'can you make it proceed ?', conversationId: 'typed-1' })) { /* to the end */ }
    expect(asked).toEqual(['typed-1']);
    const system = (script.requests[0]!.messages[0] as { content: string }).content;
    expect(system).toMatch(/- 20 seconds ago \(NEW\), about \[t1\] "Billing migration": The task "Billing migration" is waiting for your permission to use Bash\./);
  });

  test('the board reads the permission cards from the notifier, so she knows what a blocked task wants to run and whether its buttons work', async () => {
    const script = scriptedModel([{ text: 'Press Approve once.' }]);
    wired.model = script.port;
    const detectedAt = new Date(Date.now() - 60_000).toISOString();
    const deps = {
      ...routeDeps(false),
      taskStore: { viewTasks: () => [task()], getTask: () => task(), getLifetimeSpendUsd: () => 0 },
      queue: { inspectActive: () => [{ agentId: 'kookr-s1', anomaly: { type: 'permission_blocked', explanation: 'Permission request pending for tool: Bash' } }] },
      lucyPermissionNotices: {
        notice: () => undefined,
        list: () => [{
          promptId: 'p1', taskId: 't1', agentId: 'kookr-s1', taskName: 'Billing migration', toolName: 'Bash', command: 'psql staging -f fixtures/a.sql', since: Date.now() - 60_000,
          permissionRequest: { requestId: 'p1', toolName: 'Bash', toolInputHash: 'h', detectedAt, ttlMs: 5 * 60_000 }, approveKey: '1', denyKey: '3',
        }],
      },
    } as unknown as RouteDeps;
    const service = buildLucyOperator(deps)!.service!;
    for await (const _ of service.runTurn({ text: 'approve it', conversationId: 'typed-1' })) { /* to the end */ }
    const system = (script.requests[0]!.messages[0] as { content: string }).content;
    expect(system).toMatch(/waiting on the operator: it is blocked on a permission · the prompt asks to use Bash · its card is on your panel and Approve once and Deny work for about [34] more minutes · it wants to run: psql staging -f fixtures\/a\.sql/);
  });

  test('the two holders clear each other\'s card, so only one is ever waiting', async () => {
    const spec = JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'Find out why issue tasks stop chaining.' });
    wired.model = scriptedModel([{ text: spec }, { text: spec }]).port;
    const deps = routeDeps(true);
    (deps.taskStore as unknown as { getTask: () => unknown }).getTask = () => task({ pendingSignal: { kind: 'completion_ready' } });
    const service = buildLucyOperator(deps, { lifecycleCommands: { completeTask: async () => ({ outcome: 'not_found', error: 'x' }) } })!.service!;
    const close = { conversationId: 'c1', request: { kind: 'close' as const, taskId: 't1' }, operatorWords: ['close it'] };
    const start = { conversationId: 'c2', operatorWords: ['investigate why issue tasks stop chaining'] };

    expect((await service.actions!.propose(close)).ok).toBe(true);
    // A launch card is made: the action card is cleared.
    expect((await service.launch!.propose(start)).ok).toBe(true);
    expect(service.actions!.pending('c1')).toBeUndefined();
    expect(service.launch!.pending('c2')).toBeDefined();
    // And the other way round.
    expect((await service.actions!.propose(close)).ok).toBe(true);
    expect(service.launch!.pending('c2')).toBeUndefined();
    expect(service.actions!.pending('c1')).toBeDefined();
    service.launch?.dispose();
  });
});
