import { describe, expect, test, vi } from 'vitest';
import { LUCY_SAYS_GROUP_WINDOW_MS, LUCY_SAYS_REPEAT_MS, type LucySaysMessage } from '../shared/contracts/lucy-says.js';
import {
  LucySaysNotifier,
  groupedEventSentence,
  pushLucySays,
  singleEventSentence,
  taskEventForFinding,
  taskEventForOutcome,
  taskEventStillTrue,
  windowLine,
  type LucyTaskEvent,
  type LucyTaskEventKind,
} from './lucy-says.js';

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

/** A notifier whose clock, timers and dashboards the test drives. */
function harness(opts: { ownLaunches?: string[] } = {}) {
  let nowMs = T0;
  let dashboards = 1;
  let ids = 0;
  const noLongerTrue = new Set<string>();
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const sent: LucySaysMessage[] = [];
  const notifier = new LucySaysNotifier({
    push: (message) => { if (dashboards > 0) sent.push(message); return dashboards; },
    isOwnLaunch: (taskId) => (opts.ownLaunches ?? []).includes(taskId),
    stillTrue: (event) => !noLongerTrue.has(`${event.taskId}:${event.kind}`),
    now: () => nowMs,
    newId: () => `says-${++ids}`,
    setTimer: (fn, ms) => { const timer = { at: nowMs + ms, fn, cancelled: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cancelled: boolean }).cancelled = true; },
  });
  /** Move the clock forward, firing the timers that come due on the way, in order. */
  function advance(ms: number): void {
    const until = nowMs + ms;
    for (;;) {
      const due = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cancelled = true;
      nowMs = due.at;
      due.fn();
    }
    nowMs = until;
  }
  const note = (taskId: string, kind: LucyTaskEventKind, taskName?: string): void => notifier.note({ taskId, kind, ...(taskName ? { taskName } : {}) });
  return {
    notifier, sent, note, advance,
    texts: () => sent.map((message) => message.text),
    setDashboards: (n: number) => { dashboards = n; },
    resolve: (taskId: string, kind: LucyTaskEventKind) => noLongerTrue.add(`${taskId}:${kind}`),
    pendingTimers: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

describe('the sentences', () => {
  test.each([
    ['failed', 'Docs link audit failed.', 'A task failed.'],
    ['stalled', 'Docs link audit has gone quiet.', 'A task has gone quiet.'],
    ['lost_contact', 'Kookr lost contact with Docs link audit.', 'Kookr lost contact with a task.'],
    ['wants_review', 'Docs link audit says it is finished and wants your review.', 'A task says it is finished and wants your review.'],
  ] as const)('one event, %s: names the task, or says "a task" when its title may not be said', (kind, named, unnamed) => {
    expect(singleEventSentence({ kind, taskName: 'Docs link audit' })).toBe(named);
    expect(singleEventSentence({ kind })).toBe(unnamed);
    expect(singleEventSentence({ kind, taskName: 'fix /srv/app/src/server/index.ts for task-0f3a9c1e' })).toBe(unnamed);
  });

  const events = (kind: LucyTaskEventKind, ...names: Array<string | undefined>): LucyTaskEvent[] =>
    names.map((taskName, i) => ({ taskId: `t${i}`, kind, ...(taskName ? { taskName } : {}) }));

  test('several events of one kind are one sentence that lists the names', () => {
    expect(groupedEventSentence('wants_review', events('wants_review', 'A', 'B'))).toBe('Two more tasks want your review: A and B.');
    expect(groupedEventSentence('failed', events('failed', 'A', 'B', 'C'))).toBe('Three more tasks failed: A, B and C.');
    expect(groupedEventSentence('stalled', events('stalled', 'A', 'B'))).toBe('Two more tasks have gone quiet: A and B.');
    expect(groupedEventSentence('lost_contact', events('lost_contact', 'A', 'B'))).toBe('Kookr lost contact with two more tasks: A and B.');
  });

  test('at most three tasks are named; the rest, and the ones with no sayable name, are counted', () => {
    expect(groupedEventSentence('failed', events('failed', 'A', 'B', 'C', 'D', 'E'))).toBe('Five more tasks failed: A, B, C and two others.');
    expect(groupedEventSentence('failed', events('failed', 'A', undefined, '/srv/app/x.ts'))).toBe('Three more tasks failed: A and two others.');
    expect(groupedEventSentence('failed', events('failed', undefined, undefined))).toBe('Two more tasks failed.');
  });

  test('a window that held several kinds is one line, the worst news first', () => {
    const line = windowLine([
      { taskId: 'r1', kind: 'wants_review', taskName: 'A' },
      { taskId: 'f1', kind: 'failed', taskName: 'C' },
      { taskId: 'r2', kind: 'wants_review', taskName: 'B' },
    ]);
    expect(line).toEqual({ text: 'C failed. Two more tasks want your review: A and B.', kind: 'several', taskIds: ['f1', 'r1', 'r2'] });
  });
});

describe('LucySaysNotifier', () => {
  test('the window is two minutes and the repeat time ten', () => {
    expect(LUCY_SAYS_GROUP_WINDOW_MS).toBe(2 * MIN);
    expect(LUCY_SAYS_REPEAT_MS).toBe(10 * MIN);
  });

  test('the first event is written at once, as one sentence naming the task', () => {
    const h = harness();
    h.note('t1', 'wants_review', 'Docs link audit');
    expect(h.sent).toEqual([{
      type: 'lucy_says', id: 'says-1', kind: 'task_wants_review', taskIds: ['t1'], at: T0,
      text: 'Docs link audit says it is finished and wants your review.',
    }]);
  });

  test('events inside the two-minute window are written together when it closes, not before', () => {
    const h = harness();
    h.note('t1', 'wants_review', 'Docs link audit');
    h.advance(20 * SEC);
    h.note('t2', 'wants_review', 'A');
    h.advance(60 * SEC);
    h.note('t3', 'wants_review', 'B');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS - 80 * SEC - 1);
    expect(h.sent).toHaveLength(1);
    h.advance(1);
    expect(h.texts()).toEqual(['Docs link audit says it is finished and wants your review.', 'Two more tasks want your review: A and B.']);
    expect(h.sent[1]).toMatchObject({ kind: 'task_wants_review', taskIds: ['t2', 't3'], at: T0 + LUCY_SAYS_GROUP_WINDOW_MS });
  });

  test('a single event that waited is written as its own sentence', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'stalled', 'B');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.texts()).toEqual(['A failed.', 'B has gone quiet.']);
    expect(h.sent[1]).toMatchObject({ kind: 'task_stalled', taskIds: ['t2'] });
  });

  test('at most one line every two minutes: a grouped line opens the next window', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'failed', 'B');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    h.note('t3', 'failed', 'C');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS - 1);
    expect(h.texts()).toEqual(['A failed.', 'B failed.']);
    h.advance(1);
    expect(h.texts()).toEqual(['A failed.', 'B failed.', 'C failed.']);
  });

  test('once a window closes with nothing waiting, the next event is written at once again', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS + SEC);
    expect(h.pendingTimers()).toBe(0);
    h.note('t2', 'failed', 'B');
    expect(h.texts()).toEqual(['A failed.', 'B failed.']);
  });

  test('an event that is no longer true when the window closes is left out', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'stalled', 'B');
    h.note('t3', 'wants_review', 'C');
    h.resolve('t2', 'stalled');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.texts()).toEqual(['A failed.', 'C says it is finished and wants your review.']);
    // Nothing at all was left: no line, and no new window.
    h.note('t4', 'stalled', 'D');
    h.resolve('t4', 'stalled');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.sent).toHaveLength(2);
    expect(h.pendingTimers()).toBe(0);
  });

  test('the same task and kind are never written twice within ten minutes; another kind for that task is', () => {
    const h = harness();
    h.note('t1', 'stalled', 'A');
    h.advance(LUCY_SAYS_REPEAT_MS - 1);
    h.note('t1', 'stalled', 'A');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.texts()).toEqual(['A has gone quiet.']);
    h.note('t1', 'failed', 'A');
    expect(h.texts()).toEqual(['A has gone quiet.', 'A failed.']);
  });

  test('ten minutes after the last occurrence, the same task and kind are written again', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.advance(LUCY_SAYS_REPEAT_MS);
    h.note('t1', 'failed', 'A');
    expect(h.texts()).toEqual(['A failed.', 'A failed.']);
  });

  test('a finding that comes back every few minutes for half an hour is written once', () => {
    const h = harness();
    for (let minute = 0; minute <= 30; minute += 3) {
      h.note('t1', 'stalled', 'A');
      h.advance(3 * MIN);
    }
    expect(h.texts()).toEqual(['A has gone quiet.']);
    // Quiet for ten minutes, then it happens again: that is news.
    h.advance(LUCY_SAYS_REPEAT_MS);
    h.note('t1', 'stalled', 'A');
    expect(h.texts()).toEqual(['A has gone quiet.', 'A has gone quiet.']);
  });

  test('the same event arriving twice while it waits in a window is written once', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'wants_review', 'B');
    h.note('t2', 'wants_review', 'B');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.texts()).toEqual(['A failed.', 'B says it is finished and wants your review.']);
  });

  test('a task Lucy launched herself is left to the launch controller', () => {
    const h = harness({ ownLaunches: ['hers'] });
    h.note('hers', 'failed', 'Her task');
    h.note('hers', 'wants_review', 'Her task');
    h.note('hers', 'stalled', 'Her task');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.sent).toEqual([]);
    h.note('t1', 'failed', 'A');
    expect(h.texts()).toEqual(['A failed.']);
  });

  test('nothing is replayed: a line that reached no dashboard is dropped, opens no window and is not sent later', () => {
    const h = harness();
    h.setDashboards(0);
    h.note('t1', 'failed', 'A');
    h.note('t2', 'failed', 'B');
    expect(h.pendingTimers()).toBe(0);
    h.setDashboards(1); // a dashboard connects
    h.advance(10 * MIN);
    expect(h.sent).toEqual([]);
    // The next thing that happens is written as a first event, with nothing of the past in it.
    h.note('t3', 'wants_review', 'C');
    expect(h.texts()).toEqual(['C says it is finished and wants your review.']);
  });

  test('a line nobody received does not count as said: the same event is written when it happens again', () => {
    const h = harness();
    h.setDashboards(0);
    h.note('t1', 'failed', 'A');
    h.setDashboards(1);
    h.advance(MIN);
    h.note('t1', 'failed', 'A');
    expect(h.texts()).toEqual(['A failed.']);
  });

  test('a grouped line that reaches nobody is dropped too', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'failed', 'B');
    h.setDashboards(0);
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    h.setDashboards(1);
    h.advance(10 * MIN);
    expect(h.texts()).toEqual(['A failed.']);
    expect(h.pendingTimers()).toBe(0);
  });

  test('every message has its own id', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'failed', 'B');
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.sent.map((message) => message.id)).toEqual(['says-1', 'says-2']);
  });

  test('dispose stops the window and drops what waited', () => {
    const h = harness();
    h.note('t1', 'failed', 'A');
    h.note('t2', 'failed', 'B');
    h.notifier.dispose();
    expect(h.pendingTimers()).toBe(0);
    h.advance(LUCY_SAYS_GROUP_WINDOW_MS);
    expect(h.texts()).toEqual(['A failed.']);
  });

  test('a push that throws is survived and counts as reaching nobody', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifier = new LucySaysNotifier({ push: () => { throw new Error('socket gone'); }, setTimer: () => { throw new Error('no window may open'); } });
    expect(() => notifier.note({ taskId: 't1', kind: 'failed' })).not.toThrow();
    warn.mockRestore();
  });
});

describe('which events are worth a word', () => {
  test('only a task that went quiet or lost contact, among the findings', () => {
    expect(taskEventForFinding('stale_agent')).toBe('stalled');
    expect(taskEventForFinding('hook_disconnected')).toBe('lost_contact');
    for (const other of ['needs_input', 'permission_blocked', 'repeated_error', 'merge_conflict', 'hook_missing', 'api_error']) {
      expect(taskEventForFinding(other)).toBeUndefined();
    }
  });

  test('a task that has said it is finished is not then reported as gone quiet', () => {
    expect(taskEventForFinding('stale_agent', 'completion_ready')).toBeUndefined();
    expect(taskEventForFinding('hook_disconnected', 'completion_ready')).toBeUndefined();
    expect(taskEventForFinding('stale_agent', 'help')).toBe('stalled');
  });

  test('a failure and "finished, please review", among the outcomes; not a task the operator stopped or a restart cut off', () => {
    expect(taskEventForOutcome('completion_ready')).toBe('wants_review');
    expect(taskEventForOutcome('failed')).toBe('failed');
    expect(taskEventForOutcome('failed', 'timeout')).toBe('failed');
    expect(taskEventForOutcome('failed', 'unknown')).toBe('failed');
    expect(taskEventForOutcome('failed', 'supervisor')).toBe('failed');
    expect(taskEventForOutcome('failed', 'manual')).toBeUndefined();
    expect(taskEventForOutcome('failed', 'server-restart')).toBeUndefined();
    expect(taskEventForOutcome('completed')).toBeUndefined();
    expect(taskEventForOutcome('cancelled')).toBeUndefined();
  });

  test('an event is still true while the task is still in that state', () => {
    const sessions = [{ tmuxSession: 's1' }, { tmuxSession: 's2' }];
    const finding = (type?: string) => (sessionId: string) => (sessionId === 's2' ? type : undefined);
    expect(taskEventStillTrue({ kind: 'failed' }, { status: 'terminated', sessions }, finding())).toBe(true);
    // Resumed after the crash: no longer failed.
    expect(taskEventStillTrue({ kind: 'failed' }, { status: 'inProgress', sessions }, finding())).toBe(false);
    expect(taskEventStillTrue({ kind: 'wants_review' }, { status: 'inProgress', sessions, pendingSignal: { kind: 'completion_ready' } }, finding())).toBe(true);
    expect(taskEventStillTrue({ kind: 'wants_review' }, { status: 'inProgress', sessions }, finding())).toBe(false);
    expect(taskEventStillTrue({ kind: 'wants_review' }, { status: 'completed', sessions, pendingSignal: { kind: 'completion_ready' } }, finding())).toBe(false);
    expect(taskEventStillTrue({ kind: 'stalled' }, { status: 'inProgress', sessions }, finding('stale_agent'))).toBe(true);
    expect(taskEventStillTrue({ kind: 'stalled' }, { status: 'inProgress', sessions }, finding('needs_input'))).toBe(false);
    expect(taskEventStillTrue({ kind: 'stalled' }, { status: 'terminated', sessions }, finding('stale_agent'))).toBe(false);
    // It said it is finished while the event waited in the window.
    expect(taskEventStillTrue({ kind: 'stalled' }, { status: 'inProgress', sessions, pendingSignal: { kind: 'completion_ready' } }, finding('stale_agent'))).toBe(false);
    expect(taskEventStillTrue({ kind: 'lost_contact' }, { status: 'inProgress', sessions }, finding('hook_disconnected'))).toBe(true);
    expect(taskEventStillTrue({ kind: 'lost_contact' }, { status: 'inProgress', sessions }, finding())).toBe(false);
    expect(taskEventStillTrue({ kind: 'failed' }, undefined, finding())).toBe(false);
  });
});

describe('pushLucySays', () => {
  const message: LucySaysMessage = { type: 'lucy_says', id: 'says-1', kind: 'task_failed', text: 'A failed.', taskIds: ['t1'], at: T0 };
  const socket = (readyState = 1) => ({ readyState, sent: [] as string[], send(data: string) { this.sent.push(data); } });

  test('sends to open owner connections only, and says how many it reached', () => {
    const owner = socket();
    const viewer = socket();
    const closed = socket(3);
    const reached = pushLucySays([
      { ws: owner, actor: { kind: 'owner' } },
      { ws: viewer, actor: { kind: 'viewer', grantId: 'g1', scope: { kind: 'all' } } },
      { ws: closed, actor: { kind: 'owner' } },
    ], message);
    expect(reached).toBe(1);
    expect(owner.sent.map((data) => JSON.parse(data))).toEqual([message]);
    expect(viewer.sent).toEqual([]);
    expect(closed.sent).toEqual([]);
  });

  test('a connection that throws does not stop the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { readyState: 1, send: () => { throw new Error('gone'); } };
    const owner = socket();
    expect(pushLucySays([{ ws: broken, actor: { kind: 'owner' } }, { ws: owner, actor: { kind: 'owner' } }], message)).toBe(1);
    expect(owner.sent).toHaveLength(1);
    warn.mockRestore();
  });
});
