/**
 * What Lucy says without being asked reaches her next turn (issue #4143). Each test goes through the
 * real writer (the permission notifier, the line writer, the launch controller), the real record and
 * the real conversation service, and reads what the model was sent.
 */
import { describe, expect, test } from 'vitest';
import type { AgentEvent } from '../core/agent-events.js';
import { boardTask, fakeSource, scriptedModel } from '../core/lucy-operator/__fixtures__/scripted.js';
import type { LucyTurnEvent } from '../shared/contracts/lucy-turn.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import { LUCY_PERMISSION_NOTICE_GAP_MS } from '../shared/contracts/lucy-permission.js';
import { createLucyLaunchController } from './lucy-operator/launch-controller.js';
import { createLucyOperator } from './lucy-operator/service.js';
import { UNPROMPTED_ASK_NOTE } from './lucy-live/session.js';
import { LucyPermissionNotifier } from './lucy-permission-notice.js';
import { LucySaysNotifier } from './lucy-says.js';
import { createLucyUnpromptedLog } from './lucy-unprompted.js';
import type { PermissionPromptWait } from './permission-prompt-wait-alert.js';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const SEC = 1000;
const COMMAND = 'for f in fixtures/*.sql; do psql staging -f "$f"; done';
const PANE = ['● Bash(for f in fixtures/*.sql)', 'Do you want to proceed?', '❯ 1. Yes', '  3. No, and tell Claude what to do differently (esc)'].join('\n');
const NOTICE = 'The task "Staging fixture refresh" is waiting for your permission to use Bash. The command is on my card.';
const HEADER = 'What you told the operator without being asked';

async function drain(events: AsyncIterable<LucyTurnEvent>): Promise<void> {
  for await (const _ of events) { /* read to the end */ }
}

function world() {
  let nowMs = T0;
  let dashboards = 1;
  const now = (): number => nowMs;
  const log = createLucyUnpromptedLog({ now });
  const model = scriptedModel(Array.from({ length: 12 }, (_, i) => ({ text: `Reply ${i}.` })));
  const tasks = [
    boardTask({ id: 'aaaa1111', name: 'Staging fixture refresh', updatedAt: T0, attention: 'it is blocked on a permission' }),
    boardTask({ id: 'bbbb2222', name: 'Billing migration', updatedAt: T0, attention: 'it asked you a question' }),
    boardTask({ id: 'cccc3333', name: 'Docs link audit', updatedAt: T0, attention: 'it asked you a question' }),
  ];
  const service = createLucyOperator({
    model: model.port,
    modelName: 'test/model',
    source: fakeSource({ tasks }),
    unprompted: (conversationId) => log.recent(conversationId),
    now,
    warn: () => {},
  });

  const sessions = new Map<string, { events: AgentEvent[]; anomaly: Anomaly | null }>();
  const permission = new LucyPermissionNotifier({
    push: () => dashboards,
    getAnomaly: (id) => sessions.get(id)?.anomaly ?? null,
    getAgentEvents: (id) => sessions.get(id)?.events ?? [],
    capturePane: async () => PANE,
    getAfterMs: () => 60 * SEC,
    now,
    onSaid: (said) => log.record({ key: `permission:${said.noticeId}`, text: said.text, tasks: said.tasks, stillOpen: said.stillOpen }),
  });
  const block = (taskId: string, taskName: string): PermissionPromptWait => {
    const sessionId = `kookr-${taskId}`;
    sessions.set(sessionId, {
      events: [{ type: 'permission_request', sessionId, toolName: 'Bash', toolInput: { command: COMMAND }, eventSeq: 7 }],
      anomaly: { agentId: sessionId, type: 'permission_blocked', severity: 'warning', explanation: 'Permission request pending for tool: Bash', detectedAt: new Date(T0) },
    });
    return { taskId, taskName, sessionId, toolName: 'Bash', command: COMMAND, sinceMs: T0 };
  };
  const says = new LucySaysNotifier({
    push: () => dashboards,
    now,
    newId: () => 'says-1',
    setTimer: () => 0,
    clearTimer: () => {},
    onWritten: (written) => log.record({ key: `says:${written.id}`, text: written.text, tasks: written.tasks }),
  });

  return {
    log, service, model, permission, says, block,
    at: (ms: number) => { nowMs = T0 + ms; },
    setDashboards: (n: number) => { dashboards = n; },
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    turn: (conversationId: string, text: string, input: 'typed' | 'voice' = 'typed') => drain(service.runTurn({ text, conversationId, input })),
    /** Her instructions for the nth model call, and the messages that followed them. */
    system: (n: number): string => (model.requests[n]!.messages[0] as { content: string }).content,
    rest: (n: number) => model.requests[n]!.messages.slice(1),
  };
}

/** A permission prompt on "Staging fixture refresh" that has waited a minute: the card is up and she has spoken. */
async function spokenNotice(w: ReturnType<typeof world>): Promise<PermissionPromptWait> {
  const wait = w.block('aaaa1111', 'Staging fixture refresh');
  w.at(60 * SEC);
  w.permission.evaluate([wait]);
  await w.settle();
  return wait;
}

describe('what Lucy said unprompted reaches her next turn (issue #4143)', () => {
  test('after a permission notice, "can you make it proceed ?" typed 30 seconds later is sent with the notice, the task and its age', async () => {
    const w = world();
    await spokenNotice(w);
    w.at(90 * SEC);
    await w.turn('typed-1', 'can you make it proceed ?');

    expect(w.system(0)).toContain(`- 30 seconds ago (NEW), about [aaaa] "Staging fixture refresh": ${NOTICE}`);
    // It is a note next to the board, after it, and not an invented exchange: the only other message is the operator's.
    expect(w.system(0).indexOf(HEADER)).toBeGreaterThan(w.system(0).indexOf('The board (current):'));
    expect(w.rest(0)).toEqual([{ role: 'user', content: 'can you make it proceed ?' }]);
  });

  test('the notice is never copied into the history, and neither is the command; once she has replied it is no longer marked NEW', async () => {
    const w = world();
    await spokenNotice(w);
    w.at(90 * SEC);
    await w.turn('typed-1', 'can you make it proceed ?');
    w.at(100 * SEC);
    await w.turn('typed-1', 'and now?');

    expect(w.rest(1)).toEqual([
      { role: 'user', content: 'can you make it proceed ?' },
      { role: 'assistant', content: 'Reply 0.' },
      { role: 'user', content: 'and now?' },
    ]);
    expect(w.system(1)).toContain(`- 40 seconds ago, about [aaaa] "Staging fixture refresh": ${NOTICE}`);
    expect(w.system(1)).not.toContain('(NEW)');
    // The notifier hands over the sentence and the tasks only: the command reaches no message of either turn.
    expect(JSON.stringify(w.model.requests)).not.toContain('psql staging');
  });

  test('every conversation is shown it: a second typed one and a spoken one, each as NEW', async () => {
    const w = world();
    await spokenNotice(w);
    w.at(70 * SEC);
    await w.turn('typed-1', 'what was that?');
    await w.turn('typed-2', 'make it proceed');
    await w.turn('live-1', 'yes do it', 'voice');
    for (const n of [0, 1, 2]) expect(w.system(n)).toContain(`(NEW), about [aaaa] "Staging fixture refresh": ${NOTICE}`);
  });

  test('once the prompt is answered the notice is gone, so "it" no longer points at it', async () => {
    const w = world();
    await spokenNotice(w);
    w.at(70 * SEC);
    w.permission.evaluate([]);
    await w.turn('typed-1', 'can you make it proceed ?');
    expect(w.system(0)).not.toContain(HEADER);
    expect(w.system(0)).not.toContain(NOTICE);
  });

  test('a notice that reached no dashboard was not said, so it is not shown', async () => {
    const w = world();
    w.setDashboards(0);
    await spokenNotice(w);
    w.says.note({ taskId: 'bbbb2222', taskName: 'Billing migration', kind: 'failed' });
    await w.turn('typed-1', 'anything new?');
    expect(w.system(0)).not.toContain(HEADER);
  });

  test('prompts said together are one item about all of their tasks', async () => {
    const w = world();
    const first = await spokenNotice(w);
    const waits = [first, w.block('bbbb2222', 'Billing migration'), w.block('cccc3333', 'Docs link audit')];
    w.at(70 * SEC);
    w.permission.evaluate(waits);
    await w.settle();
    // One sentence every two minutes: the two new cards are said together once the gap is over.
    w.at(60 * SEC + LUCY_PERMISSION_NOTICE_GAP_MS);
    w.permission.evaluate(waits);
    await w.settle();
    await w.turn('typed-1', 'make them proceed');
    expect(w.system(0)).toContain('- a moment ago (NEW), about [bbbb] "Billing migration", [cccc] "Docs link audit": Two more tasks are waiting for you.');
    expect(w.system(0)).toContain(`- 2 minutes ago (NEW), about [aaaa] "Staging fixture refresh": ${NOTICE}`);
  });

  test('a line she wrote about a task that failed is shown too, with its task', async () => {
    const w = world();
    w.says.note({ taskId: 'bbbb2222', taskName: 'Billing migration', kind: 'failed' });
    w.at(3 * 60 * SEC);
    await w.turn('typed-1', 'why?');
    expect(w.system(0)).toContain('- 3 minutes ago (NEW), about [bbbb] "Billing migration": Billing migration failed.');
  });

  test('the newest thing she said comes first, so a notice after several lines is the one a bare "it" answers', async () => {
    const w = world();
    w.says.note({ taskId: 'cccc3333', taskName: 'Docs link audit', kind: 'failed' });
    await spokenNotice(w);
    w.at(80 * SEC);
    await w.turn('typed-1', 'can you make it proceed ?');
    const lines = w.system(0).slice(w.system(0).indexOf(HEADER)).split('\n').slice(1);
    expect(lines).toEqual([
      `- 20 seconds ago (NEW), about [aaaa] "Staging fixture refresh": ${NOTICE}`,
      '- 1 minute ago (NEW), about [cccc] "Docs link audit": Docs link audit failed.',
    ]);
  });

  test('the report of a task she launched is shown in every conversation, not only the one that launched it', async () => {
    const w = world();
    const controller = createLucyLaunchController({
      getAutonomy: () => 'balanced',
      getProjects: () => [{ name: 'kookr', cwd: '/work/kookr' }],
      writeSpec: async () => JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'Find out why the tasks stop chaining.' }),
      checkRoom: () => null,
      launch: async () => ({ task: { id: 'dddd4444' } }),
      newId: () => 'p1',
      warn: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
      onReport: (report) => w.log.record({ key: `launch:${report.taskId}`, text: report.text, tasks: [{ id: report.taskId, ...(report.taskName ? { name: report.taskName } : {}) }] }),
    });
    await controller.propose({ conversationId: 'typed-1', operatorWords: ['investigate why the tasks stop chaining'] });
    await controller.confirm('typed-1', 'p1', 'click');
    controller.onTaskOutcome('dddd4444', { kind: 'completed' }, 'Chaining investigation');

    await w.turn('typed-2', 'open it');
    expect(w.system(0)).toContain('(NEW), about "Chaining investigation" (no longer on the board): The task I started "Chaining investigation" has finished.');
  });
});

describe('a launch report that follows an earlier one about the same task', () => {
  test('"has finished" after "needs your input" is a new saying: NEW and shown at its own time', async () => {
    const w = world();
    const key = 'launch:dddd4444';
    const tasks = [{ id: 'dddd4444', name: 'Chaining investigation' }];
    w.log.record({ key, text: 'The task I started "Chaining investigation" needs your input.', tasks });
    w.at(60 * SEC);
    await w.turn('typed-1', 'what is it?');
    w.at(6 * 60 * SEC);
    w.log.record({ key, text: 'The task I started "Chaining investigation" has finished.', tasks });
    w.at(6 * 60 * SEC + 10 * SEC);
    await w.turn('typed-1', 'open it');
    expect(w.system(1)).toContain('- 10 seconds ago (NEW), about "Chaining investigation" (no longer on the board): The task I started "Chaining investigation" has finished.');
    expect(w.system(1)).not.toContain('needs your input');
  });
});

describe('a launch report repeated word for word', () => {
  test('"needs your input" said again five minutes later, with a reply in between, is NEW the second time', async () => {
    const w = world();
    const key = 'launch:dddd4444';
    const text = 'The task I started "Chaining investigation" needs your input.';
    const tasks = [{ id: 'dddd4444', name: 'Chaining investigation' }];
    w.log.record({ key, text, tasks });
    w.at(60 * SEC);
    await w.turn('typed-1', 'what about the other task?');
    w.at(5 * 60 * SEC + 10 * SEC);
    w.log.record({ key, text, tasks });
    w.at(5 * 60 * SEC + 30 * SEC);
    await w.turn('typed-1', 'open it');
    expect(w.system(1)).toContain(`- 20 seconds ago (NEW), about "Chaining investigation" (no longer on the board): ${text}`);
  });
});

describe('a question Talk read out (the hands-free path) is not shown twice', () => {
  const QUESTION = 'The task Billing migration needs your input: Run it on production now? Three choices are on my card.';
  /** Talk read the question in `live-1`: the record gets it when it is heard, the history just before the next answer. */
  function heardInTalk(w: ReturnType<typeof world>): void {
    w.log.record({ key: 'ask:q1', text: QUESTION, tasks: [{ id: 'bbbb2222', name: 'Billing migration' }], inConversation: 'live-1' });
  }

  test('the Talk conversation has it in its history and not in the note; a typed conversation has it in the note', async () => {
    const w = world();
    heardInTalk(w);
    w.at(20 * SEC);
    w.service.rememberSaid!('live-1', UNPROMPTED_ASK_NOTE, QUESTION);
    await w.turn('live-1', 'the second one', 'voice');
    await w.turn('typed-1', 'what did you ask me?');

    expect(w.rest(0)).toEqual([
      { role: 'user', content: UNPROMPTED_ASK_NOTE },
      { role: 'assistant', content: QUESTION },
      { role: 'user', content: 'the second one' },
    ]);
    expect(w.system(0)).not.toContain(HEADER);
    expect(w.system(0)).not.toContain('Run it on production now?');
    expect(JSON.stringify(w.model.requests[0]!.messages).split('Run it on production now?')).toHaveLength(2);

    expect(w.system(1)).toContain(`- 20 seconds ago (NEW), about [bbbb] "Billing migration": ${QUESTION}`);
    expect(w.rest(1)).toEqual([{ role: 'user', content: 'what did you ask me?' }]);
  });

  test('in the Talk conversation a notice said before that question is not NEW, and one said after it is', async () => {
    const before = world();
    await spokenNotice(before);
    before.at(80 * SEC);
    heardInTalk(before);
    before.at(90 * SEC);
    before.service.rememberSaid!('live-1', UNPROMPTED_ASK_NOTE, QUESTION);
    await before.turn('live-1', 'yes', 'voice');
    expect(before.system(0)).toContain(`- 30 seconds ago, about [aaaa] "Staging fixture refresh": ${NOTICE}`);
    expect(before.system(0)).not.toContain('(NEW)');

    const after = world();
    heardInTalk(after);
    await spokenNotice(after);
    after.at(90 * SEC);
    // The note for the history is only added now, just before the answer: it must not hide the newer notice.
    after.service.rememberSaid!('live-1', UNPROMPTED_ASK_NOTE, QUESTION);
    await after.turn('live-1', 'make it proceed', 'voice');
    expect(after.system(0)).toContain(`- 30 seconds ago (NEW), about [aaaa] "Staging fixture refresh": ${NOTICE}`);
  });
});

describe('the record failing never costs a turn', () => {
  test('a record that throws is reported to the log and the turn runs without the note', async () => {
    const warnings: string[] = [];
    const model = scriptedModel([{ text: 'Hello.' }]);
    const service = createLucyOperator({
      model: model.port, modelName: 'test/model', source: fakeSource({ tasks: [] }),
      unprompted: () => { throw new Error('record gone'); },
      warn: (message) => warnings.push(message),
    });
    await drain(service.runTurn({ text: 'hi', conversationId: 'typed-1' }));
    expect(model.requests).toHaveLength(1);
    expect(warnings).toEqual(['could not read what she said unprompted: record gone']);
  });
});
