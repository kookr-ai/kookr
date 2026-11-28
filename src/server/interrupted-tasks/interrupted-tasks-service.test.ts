import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InterruptedTasksService,
  expiryOutcomeOf,
  resolveInterruptedTasksPolicy,
  type InterruptedBatch,
  type InterruptedTaskEntry,
  type InterruptedTasksAskPort,
  type InterruptedTasksServiceDeps,
} from './interrupted-tasks-service.js';

const MIN = 60_000;

const RESUMABLE: InterruptedTaskEntry = { taskId: 't-resume', name: 'Resumable task', mode: 'resume' };
const FRESH: InterruptedTaskEntry = { taskId: 't-fresh', name: 'No conversation', mode: 'fresh', reason: 'no conversation id' };

interface Harness {
  service: InterruptedTasksService;
  reopened: string[];
  raised: InterruptedBatch[];
  closed: Array<{ askId: string; text: string; expiryOutcome?: string }>;
  /** Each task's current status and session count, as the task store would report it. */
  tasks: Map<string, { status: string; sessions: number }>;
  resumable: Set<string>;
  answers: Map<string, 'resume' | 'resume_all' | 'leave'>;
  clock: { now: number };
  timers: Array<{ fn: () => void; at: number; cleared: boolean }>;
  /** Fire every armed timer that is due at the current clock. */
  fireDue: () => void;
  filePath: string;
  decided: InterruptedBatch[];
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'interrupted-tasks-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(overrides: Partial<InterruptedTasksServiceDeps> = {}, opts: { withAsk?: boolean; filePath?: string } = {}): Harness {
  const h = {
    reopened: [] as string[],
    raised: [] as InterruptedBatch[],
    closed: [] as Array<{ askId: string; text: string; expiryOutcome?: string }>,
    tasks: new Map([[RESUMABLE.taskId, { status: 'terminated', sessions: 1 }], [FRESH.taskId, { status: 'terminated', sessions: 1 }]]),
    resumable: new Set([RESUMABLE.taskId]),
    answers: new Map(),
    clock: { now: 1_000_000 },
    timers: [] as Array<{ fn: () => void; at: number; cleared: boolean }>,
    filePath: opts.filePath ?? join(dir, 'interrupted-tasks.json'),
    decided: [] as InterruptedBatch[],
  } as Harness;
  let askSeq = 0;
  const ask: InterruptedTasksAskPort = {
    raise: async (batch) => {
      h.raised.push(structuredClone(batch));
      askSeq += 1;
      return { askId: `ask-${askSeq}` };
    },
    close: async (askId, text, expiryOutcome) => { h.closed.push({ askId, text, ...(expiryOutcome !== undefined ? { expiryOutcome } : {}) }); },
    answerOf: (askId) => h.answers.get(askId),
  };
  h.service = new InterruptedTasksService({
    filePath: h.filePath,
    timeoutMs: 10 * MIN,
    reopenTask: async (taskId) => {
      h.reopened.push(taskId);
      return { ok: true, mode: taskId === FRESH.taskId ? 'not_resumable' : 'resume' };
    },
    taskSnapshot: (taskId) => h.tasks.get(taskId),
    canResume: async (taskId) => h.resumable.has(taskId),
    ...(opts.withAsk === false ? {} : { ask }),
    onDecided: (batch) => h.decided.push(batch),
    now: () => h.clock.now,
    log: () => undefined,
    setTimer: (fn, ms) => {
      const timer = { fn, at: h.clock.now + ms, cleared: false };
      h.timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    },
    clearTimer: (t) => { (t as unknown as { cleared: boolean }).cleared = true; },
    ...overrides,
  });
  h.fireDue = () => {
    for (const t of h.timers) if (!t.cleared && t.at <= h.clock.now) { t.cleared = true; t.fn(); }
  };
  return h;
}

/** Wait for the decide() a timer started (it writes the batch file twice) to finish. */
async function settle(h: Harness): Promise<void> {
  await vi.waitFor(() => expect(h.decided.length).toBeGreaterThan(0), { timeout: 3_000 });
}

describe('InterruptedTasksService', () => {
  test('parking raises one question, relaunches nothing, and persists the batch', async () => {
    const h = harness();
    await h.service.start();
    const batch = await h.service.park([RESUMABLE, FRESH], 'restart');
    expect(batch?.tasks.map((t) => t.taskId)).toEqual([RESUMABLE.taskId, FRESH.taskId]);
    expect(h.raised).toHaveLength(1);
    expect(h.reopened).toEqual([]);
    const onDisk = JSON.parse(await readFile(h.filePath, 'utf-8')) as { batches: InterruptedBatch[] };
    expect(onDisk.batches[0]).toMatchObject({ state: 'pending', askId: 'ask-1', deadlineAt: h.clock.now + 10 * MIN });
  });

  test('"resume" continues the conversations and leaves the task without one stopped', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    const decided = await h.service.answerFromAsk('ask-1', 'resume');
    expect(h.reopened).toEqual([RESUMABLE.taskId]);
    expect(decided?.decision).toMatchObject({ choice: 'resume', by: 'operator' });
    expect(decided?.decision?.outcomes).toEqual([
      { taskId: RESUMABLE.taskId, outcome: 'resumed' },
      { taskId: FRESH.taskId, outcome: 'left_stopped', detail: 'no conversation to resume (no conversation id)' },
    ]);
  });

  test('"resume_all" also restarts the task with no conversation', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    const decided = await h.service.answerFromAsk('ask-1', 'resume_all');
    expect(h.reopened).toEqual([RESUMABLE.taskId, FRESH.taskId]);
    expect(decided?.decision?.outcomes.map((o) => o.outcome)).toEqual(['resumed', 'restarted']);
  });

  test('"leave" relaunches nothing', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    const decided = await h.service.answerFromAsk('ask-1', 'leave');
    expect(h.reopened).toEqual([]);
    expect(decided?.decision?.outcomes.every((o) => o.outcome === 'left_stopped')).toBe(true);
  });

  test('no answer by the deadline means "resume", and the open question is closed with the outcome', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    h.clock.now += 10 * MIN;
    h.fireDue();
    await settle(h);
    expect(h.reopened).toEqual([RESUMABLE.taskId]);
    expect(h.decided[0]?.decision).toMatchObject({ choice: 'resume', by: 'timeout' });
    expect(h.closed).toEqual([{
      askId: 'ask-1',
      text: 'No answer in time: 1 resumed, 1 left stopped.',
      expiryOutcome: 'No answer, so 1 of the 2 tasks was resumed and the rest stayed stopped.',
    }]);
  });

  test('a batch is decided once: an answer after the timeout changes nothing', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.clock.now += 10 * MIN;
    h.fireDue();
    await settle(h);
    expect(await h.service.answerFromAsk('ask-1', 'leave')).toBeUndefined();
    expect(h.reopened).toEqual([RESUMABLE.taskId]);
  });

  test('a task relaunched by hand meanwhile is skipped, not launched twice', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.tasks.set(RESUMABLE.taskId, { status: 'inProgress', sessions: 2 });
    const decided = await h.service.answerFromAsk('ask-1', 'resume');
    expect(h.reopened).toEqual([]);
    expect(decided?.decision?.outcomes[0]?.outcome).toBe('skipped');
  });

  test('a task acknowledged or cancelled meanwhile is not relaunched behind the operator\'s back', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.tasks.set(RESUMABLE.taskId, { status: 'cancelled', sessions: 1 });
    h.clock.now += 10 * MIN;
    h.fireDue();
    await settle(h);
    expect(h.reopened).toEqual([]);
    expect(h.decided[0]?.decision?.outcomes[0]).toMatchObject({ outcome: 'skipped' });
  });

  test('a task cancelled between crash recovery choosing it and the park is not relaunched (baseline from recovery)', async () => {
    const h = harness();
    await h.service.start();
    // Crash recovery took the baseline while the task was terminated; the operator cancelled it
    // before the batch was parked, once asks were up.
    h.tasks.set(RESUMABLE.taskId, { status: 'cancelled', sessions: 1 });
    await h.service.park([{ ...RESUMABLE, parkedAs: { status: 'terminated', sessions: 1 } }], 'restart');
    h.clock.now += 10 * MIN;
    h.fireDue();
    await settle(h);
    expect(h.reopened).toEqual([]);
    expect(h.decided[0]?.decision?.outcomes[0]?.outcome).toBe('skipped');
  });

  test('a task merged into a pending batch and cancelled meanwhile is not relaunched', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    await h.service.park([FRESH], 'operator');
    h.tasks.set(FRESH.taskId, { status: 'cancelled', sessions: 1 });
    const decided = await h.service.answerFromAsk('ask-2', 'resume_all');
    expect(h.reopened).toEqual([RESUMABLE.taskId]);
    expect(decided?.decision?.outcomes.find((o) => o.taskId === FRESH.taskId)?.outcome).toBe('skipped');
  });

  test('a task relaunched by hand that has since stopped again is not relaunched a second time', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    // Same terminal status as when parked, but it gained a session: it ran again in between.
    h.tasks.set(RESUMABLE.taskId, { status: 'terminated', sessions: 2 });
    const decided = await h.service.answerFromAsk('ask-1', 'resume');
    expect(h.reopened).toEqual([]);
    expect(decided?.decision?.outcomes[0]?.outcome).toBe('skipped');
  });

  test('"resume" leaves a task stopped when its conversation vanished meanwhile, instead of restarting it from the prompt', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.resumable.delete(RESUMABLE.taskId);
    const decided = await h.service.answerFromAsk('ask-1', 'resume');
    expect(h.reopened).toEqual([]);
    expect(decided?.decision?.outcomes[0]).toEqual({ taskId: RESUMABLE.taskId, outcome: 'left_stopped', detail: 'its conversation can no longer be resumed' });
  });

  test('a decision from the terminal closes the open question; an answer to the question does not re-close it', async () => {
    const fromCli = harness();
    await fromCli.service.start();
    const batch = await fromCli.service.park([RESUMABLE], 'restart');
    await fromCli.service.decide(batch!.id, 'leave', 'operator');
    expect(fromCli.closed).toEqual([{ askId: 'ask-1', text: 'Decided from the terminal (leave): 1 left stopped.' }]);

    const fromAsk = harness({}, { filePath: join(dir, 'from-ask.json') });
    await fromAsk.service.start();
    await fromAsk.service.park([RESUMABLE], 'restart');
    await fromAsk.service.answerFromAsk('ask-1', 'leave');
    expect(fromAsk.closed).toEqual([]);
  });

  test('a duplicate task in a merged park is listed once', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    const merged = await h.service.park([FRESH, FRESH], 'restart');
    expect(merged?.tasks.map((t) => t.taskId)).toEqual([RESUMABLE.taskId, FRESH.taskId]);
  });

  test('before the service is started, an answer or a park still sees the batch an earlier process left pending', async () => {
    const first = harness();
    await first.service.start();
    await first.service.park([RESUMABLE], 'restart');
    first.service.stop();

    // A new process: nothing loaded yet. A park arriving first merges into the pending batch.
    const parkFirst = harness({}, { filePath: first.filePath });
    const merged = await parkFirst.service.park([FRESH], 'operator');
    expect(merged?.tasks.map((t) => t.taskId)).toEqual([RESUMABLE.taskId, FRESH.taskId]);
    parkFirst.service.stop();

    // Another new process: an answer arriving before start() decides the pending batch.
    const answerFirst = harness({}, { filePath: first.filePath });
    const decided = await answerFirst.service.answerFromAsk('ask-1', 'leave');
    expect(decided?.decision?.choice).toBe('leave');
  });

  test('start applies an answer given while Kookr was restarting', async () => {
    const first = harness();
    await first.service.start();
    await first.service.park([RESUMABLE], 'restart');
    first.service.stop();

    const second = harness({}, { filePath: first.filePath });
    second.answers.set('ask-1', 'leave');
    await second.service.start();
    expect(second.service.pending()).toBeUndefined();
    expect(second.decided[0]?.decision).toMatchObject({ choice: 'leave', by: 'operator' });
    expect(second.reopened).toEqual([]);
  });

  test('a task with the same prompt started meanwhile is not given a twin by the decision (#4294)', async () => {
    const h = harness({ liveDuplicateOf: (taskId) => (taskId === RESUMABLE.taskId ? { taskId: 't-schedule-tick' } : undefined) });
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    const decided = await h.service.answerFromAsk('ask-1', 'resume_all');
    expect(h.reopened).toEqual([FRESH.taskId]);
    expect(decided?.decision?.outcomes[0]).toEqual({
      taskId: RESUMABLE.taskId,
      outcome: 'skipped',
      detail: 'a task with the same prompt is already running or queued (t-schedule-tick)',
    });
  });

  test('a crash part-way through a decision: the next start finishes it with the recorded choice (#4294)', async () => {
    const THIRD: InterruptedTaskEntry = { taskId: 't-third', name: 'Third task', mode: 'resume' };
    const first = harness({
      reopenTask: async (taskId) => {
        first.reopened.push(taskId);
        // The process dies while the second task relaunches: this reopen never returns.
        if (taskId === FRESH.taskId) return new Promise(() => undefined);
        return { ok: true, mode: 'resume' };
      },
    });
    first.tasks.set(THIRD.taskId, { status: 'terminated', sessions: 1 });
    await first.service.start();
    await first.service.park([RESUMABLE, FRESH, THIRD], 'restart');
    void first.service.answerFromAsk('ask-1', 'resume_all');
    await vi.waitFor(() => expect(first.reopened).toEqual([RESUMABLE.taskId, FRESH.taskId]));
    first.service.stop();

    // After the restart: the first task runs, the second was reopened (queued) when the process died.
    const second = harness({}, { filePath: first.filePath });
    second.tasks = new Map([
      [RESUMABLE.taskId, { status: 'pending', sessions: 1 }],
      [FRESH.taskId, { status: 'pending', sessions: 1 }],
      [THIRD.taskId, { status: 'terminated', sessions: 1 }],
    ]);
    await second.service.start();
    // Only the task the crash stranded is relaunched, under `resume_all`, not the deadline's `resume`.
    expect(second.reopened).toEqual([THIRD.taskId]);
    expect(second.decided).toHaveLength(1);
    expect(second.decided[0]?.decision).toMatchObject({ choice: 'resume_all', by: 'operator' });
    expect(second.decided[0]?.decision?.outcomes).toEqual([
      { taskId: RESUMABLE.taskId, outcome: 'resumed' },
      { taskId: FRESH.taskId, outcome: 'skipped', detail: 'task changed since it was parked (relaunched, acknowledged or cancelled)' },
      { taskId: THIRD.taskId, outcome: 'resumed' },
    ]);
    // Answered on the question: finishing it does not close that question again.
    expect(second.closed).toEqual([]);
    const onDisk = JSON.parse(await readFile(second.filePath, 'utf-8')) as { batches: InterruptedBatch[] };
    expect(onDisk.batches[0]?.decision?.applying).toBeUndefined();
    expect(second.service.pending()).toBeUndefined();
  });

  test('a decided batch with no in-progress mark is not applied again on start (#4294)', async () => {
    const decided: InterruptedBatch = {
      id: 'b-old', source: 'restart', createdAt: 0, deadlineAt: 1, state: 'decided', tasks: [RESUMABLE, FRESH],
      decision: { choice: 'resume_all', by: 'operator', at: 1, outcomes: [] },
    };
    await writeFile(join(dir, 'interrupted-tasks.json'), JSON.stringify({ batches: [decided] }));
    const h = harness();
    await h.service.start();
    expect(h.reopened).toEqual([]);
    expect(h.decided).toEqual([]);
  });

  test('a refused or throwing reopen is reported as failed and does not stop the others', async () => {
    const h = harness({
      reopenTask: async (taskId) => {
        if (taskId === RESUMABLE.taskId) throw new Error('boom');
        return { ok: false, detail: 'task_cleanup_in_progress' };
      },
    });
    await h.service.start();
    await h.service.park([RESUMABLE, FRESH], 'restart');
    const decided = await h.service.answerFromAsk('ask-1', 'resume_all');
    expect(decided?.decision?.outcomes).toEqual([
      { taskId: RESUMABLE.taskId, outcome: 'failed', detail: 'boom' },
      { taskId: FRESH.taskId, outcome: 'failed', detail: 'task_cleanup_in_progress' },
    ]);
  });

  test('a second park before the answer joins the pending batch, re-asks, and restarts the deadline', async () => {
    const h = harness();
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.clock.now += 5 * MIN;
    const merged = await h.service.park([RESUMABLE, FRESH], 'restart');
    expect(merged?.tasks.map((t) => t.taskId)).toEqual([RESUMABLE.taskId, FRESH.taskId]);
    expect(merged?.deadlineAt).toBe(h.clock.now + 10 * MIN);
    expect(h.raised).toHaveLength(2);
    expect(h.closed.map((c) => c.askId)).toEqual(['ask-1']);
    expect(h.service.list().filter((b) => b.state === 'pending')).toHaveLength(1);
  });

  test('a pending batch survives a restart: re-armed when time remains, decided at once when it has passed', async () => {
    const first = harness();
    await first.service.start();
    await first.service.park([RESUMABLE], 'restart');
    first.service.stop();

    // Restart with time left: no relaunch yet, a timer for the remaining time.
    const second = harness({}, { filePath: first.filePath });
    second.clock.now = first.clock.now + 4 * MIN;
    await second.service.start();
    expect(second.reopened).toEqual([]);
    expect(second.timers.at(-1)?.at).toBe(first.clock.now + 10 * MIN);
    second.service.stop();

    // Restart after the deadline: decided by timeout straight away.
    const third = harness({}, { filePath: first.filePath });
    third.clock.now = first.clock.now + 30 * MIN;
    await third.service.start();
    third.fireDue();
    await settle(third);
    expect(third.reopened).toEqual([RESUMABLE.taskId]);
  });

  test('a pending batch whose question was never raised gets one on start', async () => {
    const noAsk = harness({}, { withAsk: false });
    await noAsk.service.start();
    await noAsk.service.park([RESUMABLE], 'restart');
    expect(noAsk.service.pending()?.askId).toBeUndefined();
    noAsk.service.stop();

    const withAsk = harness({}, { filePath: noAsk.filePath });
    withAsk.clock.now = noAsk.clock.now + MIN;
    await withAsk.service.start();
    expect(withAsk.raised).toHaveLength(1);
    expect(withAsk.service.pending()?.askId).toBe('ask-1');
  });

  test('without an operator channel the batch is still decided at the deadline', async () => {
    const h = harness({}, { withAsk: false });
    await h.service.start();
    await h.service.park([RESUMABLE], 'restart');
    h.clock.now += 10 * MIN;
    h.fireDue();
    await settle(h);
    expect(h.reopened).toEqual([RESUMABLE.taskId]);
  });

  test('a corrupt batch file is quarantined and the service starts empty', async () => {
    const filePath = join(dir, 'interrupted-tasks.json');
    await writeFile(filePath, '{not json');
    const h = harness({}, { filePath });
    await h.service.start();
    expect(h.service.list()).toEqual([]);
  });

  test('parking nothing creates no batch', async () => {
    const h = harness();
    await h.service.start();
    expect(await h.service.park([], 'restart')).toBeUndefined();
    expect(h.raised).toEqual([]);
  });
});

describe('resolveInterruptedTasksPolicy', () => {
  test('defaults to ask with a 10 minute timeout', () => {
    expect(resolveInterruptedTasksPolicy({})).toEqual({ mode: 'ask', timeoutMs: 10 * MIN });
  });

  test('reads auto and a custom timeout, and ignores an out-of-range one', () => {
    expect(resolveInterruptedTasksPolicy({ KOOKR_INTERRUPTED_TASKS: 'auto', KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN: '3' }))
      .toEqual({ mode: 'auto', timeoutMs: 3 * MIN });
    expect(resolveInterruptedTasksPolicy({ KOOKR_INTERRUPTED_TASKS_TIMEOUT_MIN: '0' }).timeoutMs).toBe(10 * MIN);
    expect(resolveInterruptedTasksPolicy({ KOOKR_INTERRUPTED_TASKS: 'bogus' }).mode).toBe('ask');
  });
});

describe('expiryOutcomeOf: what the card says when nobody answered', () => {
  const outcomes = (...kinds: Array<'resumed' | 'restarted' | 'left_stopped' | 'skipped' | 'failed'>): InterruptedBatch =>
    ({ id: 'b', source: 'restart', createdAt: 0, deadlineAt: 0, state: 'decided', tasks: [], decision: { choice: 'resume', by: 'timeout', at: 0, outcomes: kinds.map((outcome, i) => ({ taskId: `t${i}`, outcome })) } });

  test.each([
    [['resumed', 'resumed', 'resumed', 'resumed'], 'No answer, so the 4 tasks were resumed.'],
    [['resumed'], 'No answer, so the task was resumed.'],
    [['resumed', 'failed', 'left_stopped'], 'No answer, so 1 of the 3 tasks was resumed and the rest stayed stopped.'],
    [['resumed', 'resumed', 'left_stopped'], 'No answer, so 2 of the 3 tasks were resumed and the rest stayed stopped.'],
    [['left_stopped', 'skipped'], 'No answer, but none of the 2 tasks were resumed.'],
    [['failed'], 'No answer, but the task was not resumed.'],
    [[], 'No answer, and no task was left to resume.'],
  ] as const)('%j', (kinds, text) => {
    expect(expiryOutcomeOf(outcomes(...kinds))).toBe(text);
  });
});

vi.setConfig({ testTimeout: 10_000 });
