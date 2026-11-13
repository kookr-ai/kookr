import { describe, expect, test, vi } from 'vitest';
import { ECHO_TAIL_MS, HANDS_OFF_CANCEL_WINDOW_MS, LAUNCH_PROPOSAL_TTL_MS } from '../../core/lucy-operator/launch-proposal.js';
import type { LucyAutonomy } from '../../shared/contracts/lucy-launch.js';
import type { LucyLaunchRecordInput } from '../lucy-interaction-log.js';
import { createLucyLaunchController, type LucyLaunchBroadcast, type LucyLaunchControllerDeps } from './launch-controller.js';

const PROJECTS = [{ name: 'kookr', cwd: '/work/kookr' }, { name: 'research', cwd: '/work/research' }];
const INVESTIGATION = JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'Find out why the issue tasks stop chaining.' });
const WORDS = ['Lucy, investigate why the issue tasks stop chaining'];

function setup(options: { level?: LucyAutonomy; reply?: string; room?: string | null; launchFails?: boolean; projects?: typeof PROJECTS } = {}) {
  let level: LucyAutonomy = options.level ?? 'balanced';
  let clock = 1_000_000;
  let ids = 0;
  const launches: Array<{ opts: Parameters<LucyLaunchControllerDeps['launch']>[0]; server: Parameters<LucyLaunchControllerDeps['launch']>[1] }> = [];
  const writerCalls: Array<{ system: string; operatorWords: readonly string[] }> = [];
  const logs: LucyLaunchRecordInput[] = [];
  const messages: LucyLaunchBroadcast[] = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let room: string | null = options.room ?? null;
  const controller = createLucyLaunchController({
    getAutonomy: () => level,
    getProjects: () => options.projects ?? PROJECTS,
    writeSpec: async (request) => { writerCalls.push({ system: request.system, operatorWords: request.operatorWords }); return options.reply ?? INVESTIGATION; },
    checkRoom: () => room,
    launch: async (opts, server) => {
      if (options.launchFails) throw new Error('boom /home/jean/secret/path');
      launches.push({ opts, server });
      return { task: { id: `task-${launches.length}` } };
    },
    emit: (message) => messages.push(message),
    log: { recordSaid: () => {}, recordLiveTurn: () => {}, recordUi: () => {}, flush: async () => {}, recordLaunch: (r) => { logs.push(r); } },
    now: () => clock,
    newId: () => `p${++ids}`,
    warn: () => {},
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimer: (h) => { timers[h as number]!.live = false; },
  });
  return {
    controller, launches, writerCalls, logs, messages, timers,
    setLevel: (next: LucyAutonomy) => { level = next; },
    setRoom: (next: string | null) => { room = next; },
    advance: (ms: number) => { clock += ms; },
    propose: (words: readonly string[] = WORDS) => controller.propose({ conversationId: 'c1', operatorWords: words }),
  };
}

describe('propose', () => {
  test('a clear request becomes a held proposal and a read-back; nothing is launched', async () => {
    const t = setup();
    const result = await t.propose();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal).toMatchObject({
      id: 'p1', kind: 'investigation', project: 'kookr', description: 'Find out why the issue tasks stop chaining.', level: 'balanced',
      asked: WORDS[0], expiresAt: 1_000_000 + LAUNCH_PROPOSAL_TTL_MS,
    });
    expect(result.say).toBe('I will launch an investigation in kookr: Find out why the issue tasks stop chaining. Say go to start.');
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')?.id).toBe('p1');
    expect(t.messages).toEqual([{ type: 'lucy_launch', conversationId: 'c1', proposal: result.proposal }]);
    expect(t.logs.map((l) => l.event)).toEqual(['proposed']);
  });

  test('the writer is given the operator\'s words and the project names, and nothing else', async () => {
    const t = setup();
    await t.propose(['first thing I said', 'Lucy, investigate it']);
    expect(t.writerCalls).toHaveLength(1);
    expect(t.writerCalls[0]!.operatorWords).toEqual(['first thing I said', 'Lucy, investigate it']);
    expect(t.writerCalls[0]!.system).toContain('- kookr');
    expect(t.writerCalls[0]!.system).not.toContain('/work/kookr');
  });

  test('a key in the operator\'s words does not reach the writer', async () => {
    const t = setup();
    await t.propose(['investigate with ghp_abcdefghijklmnopqrstuvwxyz0123456789']);
    expect(JSON.stringify(t.writerCalls)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  test('an unclear request gets one question and no proposal', async () => {
    const t = setup({ reply: '{"ambiguous":"Which project?"}' });
    expect(await t.propose()).toEqual({ ok: false, say: 'Which project?', why: 'ambiguous' });
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.messages).toEqual([]);
  });

  test.each([
    ['a project that is not on the list', JSON.stringify({ kind: 'investigation', project: 'secrets', description: 'x' })],
    ['a path instead of a name', JSON.stringify({ kind: 'investigation', project: '/etc', description: 'x' })],
    ['a description over the length cap', JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'x'.repeat(2001) })],
    ['an extra field', JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'x', cwd: '/etc' })],
    ['an agent that is not allowed', JSON.stringify({ kind: 'investigation', project: 'kookr', description: 'x', agentType: 'rm' })],
    ['text that is not JSON', 'sure, launching now'],
  ])('%s makes no proposal', async (_name, reply) => {
    const t = setup({ reply });
    const result = await t.propose();
    expect(result.ok).toBe(false);
    expect(t.controller.pending('c1')).toBeUndefined();
  });

  test('no projects means no proposal', async () => {
    const t = setup({ projects: [] });
    expect(await t.propose()).toMatchObject({ ok: false, why: 'no projects' });
  });

  test('a second proposal replaces the first: at most one per conversation', async () => {
    const t = setup();
    await t.propose();
    await t.propose();
    expect(t.controller.pending('c1')?.id).toBe('p2');
    expect(await t.controller.confirm('c1', 'p1', 'click')).toEqual({ outcome: 'unknown', proposalId: 'p1' });
    expect(t.launches).toHaveLength(0);
  });
});

describe('confirm, decline and expiry', () => {
  test('"go" launches exactly what the card shows, as lucy-operator', async () => {
    const t = setup();
    await t.propose();
    const handled = await t.controller.handleReply('c1', 'Go.', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'launched', taskId: 'task-1', project: 'kookr' } });
    expect(t.launches).toHaveLength(1);
    const { opts } = t.launches[0]!;
    expect(opts).toMatchObject({ cwd: '/work/kookr', launchSource: 'api', launchActorId: 'lucy-operator' });
    // The task description is the card's, with the report-only wording added by the server.
    expect(opts.prompt.startsWith('Find out why the issue tasks stop chaining.')).toBe(true);
    expect(opts.prompt).toMatch(/do not open a pull request unless/i);
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.logs.map((l) => l.event)).toEqual(['proposed', 'launched']);
    expect(t.logs[1]).toMatchObject({ taskId: 'task-1', level: 'balanced', via: 'typed' });
  });

  test('Enter or a click (the confirm route) launches it once, however many times it arrives', async () => {
    const t = setup();
    await t.propose();
    const [a, b] = await Promise.all([t.controller.confirm('c1', 'p1', 'enter'), t.controller.confirm('c1', 'p1', 'click')]);
    expect([a.outcome, b.outcome].sort()).toEqual(['launched', 'unknown']);
    expect(t.launches).toHaveLength(1);
  });

  test('a confirmation for another proposal id or another conversation launches nothing', async () => {
    const t = setup();
    await t.propose();
    expect((await t.controller.confirm('c1', 'wrong', 'click')).outcome).toBe('unknown');
    expect((await t.controller.confirm('c2', 'p1', 'click')).outcome).toBe('unknown');
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')?.id).toBe('p1');
  });

  test('anything else the operator says drops the proposal and goes on as a new request', async () => {
    const t = setup();
    await t.propose();
    expect(await t.controller.handleReply('c1', 'actually, what is running?', { input: 'typed' })).toEqual({ handled: false });
    expect(t.controller.pending('c1')).toBeUndefined();
    expect((await t.controller.confirm('c1', 'p1', 'click')).outcome).toBe('unknown');
    expect(t.launches).toHaveLength(0);
    expect(t.logs.map((l) => l.event)).toEqual(['proposed', 'dropped']);
  });

  test('"go and also ..." is not a confirmation', async () => {
    const t = setup();
    await t.propose();
    expect(await t.controller.handleReply('c1', 'go and also delete the logs', { input: 'typed' })).toEqual({ handled: false });
    expect(t.launches).toHaveLength(0);
  });

  test('"no" declines it', async () => {
    const t = setup();
    await t.propose();
    const handled = await t.controller.handleReply('c1', 'no', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'declined', proposalId: 'p1' } });
    expect(t.launches).toHaveLength(0);
  });

  test('a proposal older than its time limit cannot be confirmed, by click or by voice', async () => {
    const t = setup();
    await t.propose();
    t.advance(LAUNCH_PROPOSAL_TTL_MS);
    expect(await t.controller.confirm('c1', 'p1', 'click')).toEqual({ outcome: 'expired', proposalId: 'p1' });
    expect(t.launches).toHaveLength(0);

    await t.propose();
    t.advance(LAUNCH_PROPOSAL_TTL_MS + 1);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'expired' } });
    expect(t.launches).toHaveLength(0);
  });

  test('a launch the server would refuse is refused with the reason, and nothing starts', async () => {
    const t = setup({ room: 'All 5 task slots are busy, so I cannot start another one now.' });
    await t.propose();
    const handled = await t.controller.handleReply('c1', 'go', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, say: 'All 5 task slots are busy, so I cannot start another one now.', outcome: { outcome: 'refused' } });
    expect(t.launches).toHaveLength(0);
    expect(t.logs.at(-1)).toMatchObject({ event: 'refused' });
  });

  test('a launch that throws is refused without quoting the error', async () => {
    const t = setup({ launchFails: true });
    await t.propose();
    const outcome = await t.controller.confirm('c1', 'p1', 'click');
    expect(outcome).toEqual({ outcome: 'refused', proposalId: 'p1', reason: 'Kookr could not start the task.' });
    expect(JSON.stringify(t.logs)).not.toContain('secret/path');
  });
});

describe('the read-back cannot confirm itself', () => {
  test('spoken words that began while she was still reading the proposal neither confirm nor drop it', async () => {
    const t = setup();
    await t.propose();
    // Her own "Say go to start." coming back through the microphone: it began during the read-back.
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: 1_000_000 + 500 });
    expect(handled).toEqual({ handled: true, say: '', ignored: true });
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')?.id).toBe('p1');
    expect(t.logs.at(-1)).toMatchObject({ event: 'ignored', via: 'spoken' });
  });

  test('so does speech the dashboard says overlapped the read-back', async () => {
    const t = setup();
    await t.propose();
    t.advance(60_000);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', overlapsReadBack: true, speechStartedAt: 1_060_000 });
    expect(handled).toMatchObject({ ignored: true });
    expect(t.launches).toHaveLength(0);
  });

  test('a spoken "go" that began after she had finished confirms', async () => {
    const t = setup();
    await t.propose();
    t.advance(15_000);
    const handled = await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: 1_015_000 });
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'launched' } });
    expect(t.logs.at(-1)).toMatchObject({ via: 'spoken' });
  });

  test('typing is not held to this: typed "go" confirms at once', async () => {
    const t = setup();
    await t.propose();
    expect(await t.controller.handleReply('c1', 'go', { input: 'typed' })).toMatchObject({ outcome: { outcome: 'launched' } });
  });
});

describe('how the task is delivered', () => {
  test('an investigation is not told to push, open a pull request and merge; an implementation gets the usual delivery wording', async () => {
    const investigation = setup();
    await investigation.propose();
    await investigation.controller.confirm('c1', 'p1', 'click');
    expect(investigation.launches[0]!.server).toMatchObject({ deliveryPolicy: 'ask-first' });

    const implementation = setup({ reply: JSON.stringify({ kind: 'implementation', project: 'kookr', description: 'Fix the sweep button.' }) });
    await implementation.propose();
    await implementation.controller.confirm('c1', 'p1', 'click');
    expect('deliveryPolicy' in implementation.launches[0]!.server).toBe(false);
  });
});

describe('the three levels', () => {
  test('Careful forces permission prompts on', async () => {
    const t = setup({ level: 'careful' });
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: false });
  });

  test('Balanced leaves the permission setting to the install, as a Launch-tab launch does', async () => {
    const t = setup({ level: 'balanced' });
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    expect('bypassPermissions' in t.launches[0]!.server).toBe(false);
  });

  test('Hands-off bypasses every permission', async () => {
    const t = setup({ level: 'hands-off' });
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: true });
  });

  test('the level is read when the task is launched, not when the card was made', async () => {
    const t = setup({ level: 'balanced' });
    await t.propose();
    t.setLevel('careful');
    await t.controller.confirm('c1', 'p1', 'click');
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: false });
    expect(t.logs.at(-1)).toMatchObject({ level: 'careful' });
  });

  test('Hands-off makes no card to wait on: it launches after the cancel window', async () => {
    const t = setup({ level: 'hands-off' });
    const result = await t.propose();
    // The window starts after the read-back, which is estimated here until the real length is known.
    const launchesAt = result.ok ? result.proposal.launchesAt! : 0;
    expect(launchesAt).toBeGreaterThan(1_000_000 + HANDS_OFF_CANCEL_WINDOW_MS);
    expect(result.ok && result.say).toContain('Say cancel to stop it.');
    expect(t.launches).toHaveLength(0);
    expect(t.timers).toHaveLength(1);
    expect(t.timers[0]!.ms).toBe(launchesAt - 1_000_000);
    t.advance(launchesAt - 1_000_000);
    t.timers[0]!.fn();
    await vi.waitFor(() => expect(t.launches).toHaveLength(1));
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: true });
    expect(t.logs.at(-1)).toMatchObject({ event: 'launched', via: 'timer', level: 'hands-off' });
  });

  test('when the read-back turns out to end later, the cancel window moves with it', async () => {
    const t = setup({ level: 'hands-off' });
    const result = await t.propose();
    const first = result.ok ? result.proposal.launchesAt! : 0;
    // Her voice is audible for another 20 s (a long read-back, synthesised late).
    t.controller.noteSpeaking('c1', 1_000_000 + 20_000);
    const moved = t.controller.pending('c1')!.launchesAt!;
    expect(moved).toBeGreaterThan(first);
    expect(moved).toBe(1_000_000 + 20_000 + ECHO_TAIL_MS + HANDS_OFF_CANCEL_WINDOW_MS);
    expect(t.timers[0]!.live).toBe(false);
    expect(t.timers[1]!.live).toBe(true);
    expect(t.timers[1]!.ms).toBe(moved - 1_000_000);
    // The dashboards are told, so the countdown follows.
    expect(t.messages.at(-1)).toMatchObject({ proposal: { launchesAt: moved } });
    // Saying no is always safe: a spoken "cancel" is heard even while she is still reading, so the operator is never ignored.
    expect(await t.controller.handleReply('c1', 'cancel', { input: 'voice', speechStartedAt: 1_000_000 + 15_000 })).toMatchObject({ outcome: { outcome: 'cancelled' } });
  });

  test('"cancel" within the window stops a Hands-off launch', async () => {
    const t = setup({ level: 'hands-off' });
    await t.propose();
    const handled = await t.controller.handleReply('c1', 'cancel', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true, outcome: { outcome: 'cancelled', proposalId: 'p1' } });
    expect(t.timers[0]!.live).toBe(false);
    expect(t.launches).toHaveLength(0);
  });

  test('if the level was lowered during the window, the held launch is not made', async () => {
    const t = setup({ level: 'hands-off' });
    await t.propose();
    t.setLevel('balanced');
    t.advance(60_000);
    t.timers[0]!.fn();
    await Promise.resolve();
    expect(t.launches).toHaveLength(0);
    expect(t.messages.at(-1)).toMatchObject({ outcome: { outcome: 'cancelled' } });
  });

  test('no step of the controller takes a level from its input', async () => {
    // The only way in is deps.getAutonomy(); the confirm, decline and cancel methods take no level.
    const t = setup({ level: 'careful' });
    await t.propose();
    const outcome = await t.controller.confirm('c1', 'p1', 'click');
    expect(outcome.outcome).toBe('launched');
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: false });
  });
});

describe('a request to change her level', () => {
  test('is answered with where the setting is, changes nothing and drops a pending proposal', async () => {
    const t = setup({ level: 'careful' });
    await t.propose();
    const handled = await t.controller.handleReply('c1', 'switch to hands off mode', { input: 'typed' });
    expect(handled).toMatchObject({ handled: true });
    expect(handled.handled && handled.say).toMatch(/set in Settings/);
    expect(t.controller.pending('c1')).toBeUndefined();
    await t.propose();
    await t.controller.confirm('c1', 'p2', 'click');
    expect(t.launches[0]!.server).toMatchObject({ bypassPermissions: false });
  });
});

describe('the report back', () => {
  test('a task she launched is reported in the conversation that launched it', async () => {
    const t = setup();
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    t.messages.length = 0;
    t.controller.onTaskOutcome('task-1', { kind: 'completed' }, 'Chaining investigation');
    expect(t.messages).toEqual([{
      type: 'lucy_launch', conversationId: 'c1',
      report: { taskId: 'task-1', conversationId: 'c1', kind: 'finished', text: 'The task I started "Chaining investigation" has finished.' },
    }]);
  });

  test('the task name is cleaned like on the board: secrets hidden, a generic name left out', async () => {
    const t = setup();
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    t.messages.length = 0;
    t.controller.onTaskOutcome('task-1', { kind: 'failed' }, 'Fix ghp_abcdefghijklmnopqrstuvwxyz0123456789 now');
    expect(JSON.stringify(t.messages)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(t.controller.reportText('task-1')).toMatch(/^The task I started/);
  });

  test('a task she did not launch is not reported', async () => {
    const t = setup();
    t.controller.onTaskOutcome('someone-elses', { kind: 'completed' });
    expect(t.messages).toEqual([]);
  });

  test('a task that keeps raising the same finding is announced once, then again after a while', async () => {
    const t = setup();
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    t.messages.length = 0;
    t.controller.onTaskOutcome('task-1', { kind: 'needs_input' });
    t.controller.onTaskOutcome('task-1', { kind: 'needs_input' });
    t.advance(6 * 60 * 1000);
    t.controller.onTaskOutcome('task-1', { kind: 'needs_input' });
    expect(t.messages).toHaveLength(2);
  });

  test('needing the operator is reported, and the task is still followed to its end', async () => {
    const t = setup();
    await t.propose();
    await t.controller.confirm('c1', 'p1', 'click');
    t.messages.length = 0;
    t.controller.onTaskOutcome('task-1', { kind: 'needs_input' });
    t.controller.onTaskOutcome('task-1', { kind: 'completion_ready' });
    t.controller.onTaskOutcome('task-1', { kind: 'completed' });
    expect(t.messages.map((m) => ('report' in m ? m.report?.kind : null))).toEqual(['needs_input', 'finished']);
  });
});

describe('hardening from review', () => {
  test('one proposal across conversations: a new one replaces the other, and "go" from either confirms the one shown', async () => {
    const t = setup();
    await t.controller.propose({ conversationId: 'live-1', operatorWords: WORDS });
    await t.controller.propose({ conversationId: 'typed-1', operatorWords: WORDS });
    expect(t.controller.pending('live-1')).toBeUndefined();
    expect(t.messages.some((m) => 'outcome' in m && m.conversationId === 'live-1' && m.outcome?.outcome === 'cancelled')).toBe(true);
    // Spoken in the other conversation, it still means the card that is on screen.
    const handled = await t.controller.handleReply('live-1', 'go', { input: 'typed' });
    expect(handled).toMatchObject({ outcome: { outcome: 'launched', proposalId: 'p2' } });
    expect(t.launches).toHaveLength(1);
  });

  test('a spoken hands-off proposal is not launched while nothing has reported the read-back audible; it is dropped after a wait', async () => {
    const t = setup({ level: 'hands-off' });
    await t.controller.propose({ conversationId: 'c1', operatorWords: WORDS, spoken: true });
    t.advance(30_000);
    t.timers[0]!.fn();
    await Promise.resolve();
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')).toBeDefined();
    t.advance(61_000);
    t.timers.filter((x) => x.live).at(-1)!.fn();
    await Promise.resolve();
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.logs.at(-1)).toMatchObject({ event: 'dropped', reason: 'read-back never heard' });
  });

  test('a spoken hands-off proposal launches once the read-back was heard and its window has passed', async () => {
    const t = setup({ level: 'hands-off' });
    await t.controller.propose({ conversationId: 'c1', operatorWords: WORDS, spoken: true });
    t.controller.noteSpeaking('c1', 1_000_000 + 4_000);
    t.advance(30_000);
    t.timers.filter((x) => x.live).at(-1)!.fn();
    await vi.waitFor(() => expect(t.launches).toHaveLength(1));
  });

  test('a timer that fires before the window after her voice has passed waits instead of launching', async () => {
    const t = setup({ level: 'hands-off' });
    await t.controller.propose({ conversationId: 'c1', operatorWords: WORDS });
    t.controller.noteSpeaking('c1', 1_000_000 + 40_000);
    // The first timer (cleared by the re-arm) cannot launch anything.
    t.advance(20_000);
    t.timers.filter((x) => x.live).at(-1)!.fn();
    await Promise.resolve();
    expect(t.launches).toHaveLength(0);
    expect(t.controller.pending('c1')).toBeDefined();
  });

  test('closing the voice conversation drops its proposal, so nothing launches after the tab is gone', async () => {
    const t = setup({ level: 'hands-off' });
    await t.controller.propose({ conversationId: 'c1', operatorWords: WORDS, spoken: true });
    t.controller.closeConversation('c1');
    expect(t.controller.pending('c1')).toBeUndefined();
    expect(t.timers[0]!.live).toBe(false);
    expect(t.launches).toHaveLength(0);
  });

  test('a decline is heard even while she is still reading; a confirmation is not', async () => {
    const t = setup();
    await t.propose();
    expect(await t.controller.handleReply('c1', 'go', { input: 'voice', speechStartedAt: 1_000_100 })).toMatchObject({ ignored: true });
    expect(await t.controller.handleReply('c1', 'no', { input: 'voice', speechStartedAt: 1_000_100 })).toMatchObject({ outcome: { outcome: 'declined' } });
  });

  test('a level that became looser since the card was made is refused, not launched under a card that says otherwise', async () => {
    const t = setup({ level: 'balanced' });
    await t.propose();
    t.setLevel('hands-off');
    const outcome = await t.controller.confirm('c1', 'p1', 'click');
    expect(outcome).toMatchObject({ outcome: 'refused', reason: expect.stringMatching(/level changed/) });
    expect(t.launches).toHaveLength(0);
    // A stricter level than the card promised is fine.
    await t.propose();
    t.setLevel('careful');
    expect((await t.controller.confirm('c1', 'p2', 'click')).outcome).toBe('launched');
  });
});
