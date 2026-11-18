import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InterruptedTasksService,
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
  closed: Array<{ askId: string; text: string }>;
  terminal: Set<string>;
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
    closed: [] as Array<{ askId: string; text: string }>,
    terminal: new Set([RESUMABLE.taskId, FRESH.taskId]),
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
    close: async (askId, text) => { h.closed.push({ askId, text }); },
  };
  h.service = new InterruptedTasksService({
    filePath: h.filePath,
    timeoutMs: 10 * MIN,
    reopenTask: async (taskId) => {
      h.reopened.push(taskId);
      return { ok: true, mode: taskId === FRESH.taskId ? 'not_resumable' : 'resume' };
    },
    isTaskTerminal: (taskId) => h.terminal.has(taskId),
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
    expect(h.closed).toEqual([{ askId: 'ask-1', text: 'No answer in time: 1 resumed, 1 left stopped.' }]);
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
    h.terminal.delete(RESUMABLE.taskId);
    const decided = await h.service.answerFromAsk('ask-1', 'resume');
    expect(h.reopened).toEqual([]);
    expect(decided?.decision?.outcomes[0]?.outcome).toBe('skipped');
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

vi.setConfig({ testTimeout: 10_000 });
