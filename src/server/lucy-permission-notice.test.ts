import { describe, expect, test } from 'vitest';
import type { AgentEvent } from '../core/agent-events.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import {
  LUCY_PERMISSION_NOTICE_GAP_MS,
  type LucyPermissionAnnouncement,
  type LucyPermissionCardView,
} from '../shared/contracts/lucy-permission.js';
import {
  LucyPermissionNotifier,
  groupedNoticeSentence,
  pushLucyPermissionCards,
  singleNoticeSentence,
  spokenToolName,
} from './lucy-permission-notice.js';
import type { PermissionPromptWait } from './permission-prompt-wait-alert.js';
import { validatePermissionApprovalBinding } from './permission-request-binding.js';

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.parse('2026-11-16T10:00:00.000Z');

const BASH_PANE = [
  '● Bash(rm -rf build)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for rm commands in /repo",
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n');

/** Built at run time so the source holds no token-shaped literal. */
const TOKEN = ['gh', 'p_', 'Zx9'.repeat(8)].join('');
const LONG_COMMAND = `git push origin feat &&\n  gh-login ${TOKEN} &&\n  curl https://api.github.com/${'repos/x/'.repeat(40)}`;

interface Session {
  events: AgentEvent[];
  anomaly: Anomaly | null;
  pane: string;
}

function harness(opts: { afterMs?: number } = {}) {
  let nowMs = T0;
  let dashboards = 1;
  let afterMs = opts.afterMs;
  const sessions = new Map<string, Session>();
  const pushes: Array<{ cards: LucyPermissionCardView[]; announce?: LucyPermissionAnnouncement }> = [];
  const notifier = new LucyPermissionNotifier({
    push: (cards, announce) => { pushes.push({ cards, ...(announce ? { announce } : {}) }); return dashboards; },
    getAnomaly: (id) => sessions.get(id)?.anomaly ?? null,
    getAgentEvents: (id) => sessions.get(id)?.events ?? [],
    capturePane: async (id) => sessions.get(id)?.pane ?? '',
    getAfterMs: () => afterMs ?? 60 * SEC,
    now: () => nowMs,
  });
  /** A task whose session is blocked on a Bash prompt first seen at `sinceMs`. */
  function block(taskId: string, sinceMs: number, command = 'rm -rf build', pane = BASH_PANE): PermissionPromptWait {
    const sessionId = `kookr-${taskId}`;
    sessions.set(sessionId, {
      events: [{ type: 'permission_request', sessionId, toolName: 'Bash', toolInput: { command }, eventSeq: 7 }],
      anomaly: { agentId: sessionId, type: 'permission_blocked', severity: 'warning', explanation: 'Permission request pending for tool: Bash', detectedAt: new Date(sinceMs) },
      pane,
    });
    return { taskId, taskName: `Fix the ${taskId} build`, sessionId, toolName: 'Bash', command: command.slice(0, 20), sinceMs };
  }
  return {
    notifier,
    pushes,
    sessions,
    block,
    at(ms: number) { nowMs = T0 + ms; },
    setDashboards(n: number) { dashboards = n; },
    setAfterMs(ms: number) { afterMs = ms; },
    announcements: () => pushes.flatMap((p) => (p.announce ? [p.announce] : [])),
    lastCards: () => pushes[pushes.length - 1]?.cards ?? [],
    /** Let the async pane read settle. */
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  };
}

describe('LucyPermissionNotifier', () => {
  test('a prompt that waits 60 s gets one card and one sentence; later ticks and a reconnect say nothing more', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.at(59 * SEC);
    h.notifier.evaluate([w]);
    await h.settle();
    expect(h.pushes).toEqual([]);

    h.at(60 * SEC);
    h.notifier.evaluate([w]);
    await h.settle();
    expect(h.lastCards()).toHaveLength(1);
    expect(h.announcements()).toHaveLength(1);
    const [announce] = h.announcements();
    expect(announce?.promptIds).toEqual([h.lastCards()[0]?.promptId]);
    expect(h.notifier.notice(announce!.noticeId)).toMatchObject({
      text: 'The task "Fix the a build" is waiting for your permission to use Bash. The command is on my card.',
      open: true,
      taskId: 'a',
    });

    for (const t of [65, 120, 300]) {
      h.at(t * SEC);
      h.notifier.evaluate([w]);
      await h.settle();
    }
    expect(h.announcements()).toHaveLength(1);
    // What a dashboard gets on connect (after a reload): the card, no sentence.
    expect(h.notifier.list()).toHaveLength(1);
  });

  test('three tasks blocked within a minute: one sentence now, one grouped sentence after the gap, three cards', async () => {
    const h = harness();
    const a = h.block('a', T0);
    const b = h.block('b', T0 + 20 * SEC);
    const c = h.block('c', T0 + 50 * SEC);
    const tick = async (ms: number) => { h.at(ms); h.notifier.evaluate([a, b, c]); await h.settle(); };

    await tick(60 * SEC);
    expect(h.announcements()).toHaveLength(1);
    await tick(80 * SEC);
    await tick(110 * SEC);
    expect(h.lastCards()).toHaveLength(3);
    expect(h.announcements()).toHaveLength(1);

    await tick(60 * SEC + LUCY_PERMISSION_NOTICE_GAP_MS - 1);
    expect(h.announcements()).toHaveLength(1);
    await tick(60 * SEC + LUCY_PERMISSION_NOTICE_GAP_MS);
    const announced = h.announcements();
    expect(announced).toHaveLength(2);
    expect(h.notifier.notice(announced[1]!.noticeId)?.text).toBe('Two more tasks are waiting for you.');
    expect(announced[1]!.promptIds).toHaveLength(2);

    await tick(10 * MIN);
    expect(h.announcements()).toHaveLength(2);
    expect(h.lastCards().map((card) => card.taskId)).toEqual(['a', 'b', 'c']);
  });

  test('a card answered before the gap is over is left out of the grouped sentence; none left, nothing said', async () => {
    const h = harness();
    const a = h.block('a', T0);
    const b = h.block('b', T0 + 10 * SEC);
    const c = h.block('c', T0 + 20 * SEC);
    h.at(60 * SEC); h.notifier.evaluate([a, b, c]); await h.settle();
    h.at(80 * SEC); h.notifier.evaluate([a, b, c]); await h.settle();
    expect(h.announcements()).toHaveLength(1);
    // b and c are answered (in the terminal, on Telegram, ...): their cards go.
    h.at(100 * SEC); h.notifier.evaluate([a]); await h.settle();
    expect(h.lastCards().map((card) => card.taskId)).toEqual(['a']);
    h.at(60 * SEC + LUCY_PERMISSION_NOTICE_GAP_MS); h.notifier.evaluate([a]); await h.settle();
    expect(h.announcements()).toHaveLength(1);
  });

  test('one card left after the gap is said in full, not as "one more"', async () => {
    const h = harness();
    const a = h.block('a', T0);
    const b = h.block('b', T0 + 30 * SEC);
    h.at(60 * SEC); h.notifier.evaluate([a, b]); await h.settle();
    h.at(90 * SEC); h.notifier.evaluate([a, b]); await h.settle();
    h.at(60 * SEC + LUCY_PERMISSION_NOTICE_GAP_MS); h.notifier.evaluate([a, b]); await h.settle();
    const second = h.announcements()[1];
    expect(h.notifier.notice(second!.noticeId)?.text).toBe(
      'The task "Fix the b build" is waiting for your permission to use Bash. The command is on my card.',
    );
  });

  test('the sentence never holds the command; the card holds all of it, secrets hidden', async () => {
    const h = harness();
    const w = h.block('a', T0, LONG_COMMAND);
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card.command.length).toBeGreaterThan(200);
    expect(card.command).toContain('\n  curl');
    expect(card.command).toContain('api.github.com');
    expect(card.command).not.toContain(TOKEN);
    expect(card.command).toContain('[REDACTED]');
    const text = h.notifier.notice(h.announcements()[0]!.noticeId)!.text;
    for (const fragment of ['git', 'push', 'curl', 'github', 'rm ']) expect(text).not.toContain(fragment);
  });

  test('the buttons carry the binding the permissionChoice check accepts and the keys read from the pane', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card).toMatchObject({ agentId: 'kookr-a', toolName: 'Bash', approveKey: '1', denyKey: '3', since: T0 });
    const session = h.sessions.get('kookr-a')!;
    const check = validatePermissionApprovalBinding({
      sessionId: 'kookr-a',
      events: session.events,
      anomaly: session.anomaly,
      payload: { permissionRequest: card.permissionRequest },
      now: new Date(T0 + MIN),
    });
    expect(check.ok).toBe(true);
    expect(card.promptId).toBe(card.permissionRequest?.requestId);
  });

  test('an option missing from the pane gets no button', async () => {
    const h = harness();
    const w = h.block('a', T0, 'ls', 'Do you want to proceed?\n❯ 1. Yes\n  2. Not now');
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card.approveKey).toBe('1');
    expect(card.denyKey).toBeUndefined();
  });

  test('a block seen only on the pane (no hook event) gets a card without buttons', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.sessions.get('kookr-a')!.events = [];
    h.at(MIN); h.notifier.evaluate([{ ...w, command: '' }]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card.permissionRequest).toBeUndefined();
    expect(card.approveKey).toBeUndefined();
    expect(card.denyKey).toBeUndefined();
    expect(card.promptId).toBe(`pane:a:${T0}`);
    expect(h.announcements()).toHaveLength(1);
  });

  test('a prompt replaced while the pane was read gets its card on the next tick, for the new prompt', async () => {
    const h = harness();
    const w = h.block('a', T0);
    const session = h.sessions.get('kookr-a')!;
    h.at(MIN);
    h.notifier.evaluate([w]);
    // Before the pane read returns, the agent moves on to another prompt.
    session.events = [{ type: 'permission_request', sessionId: 'kookr-a', toolName: 'Bash', toolInput: { command: 'ls' }, eventSeq: 9 }];
    await h.settle();
    expect(h.pushes).toEqual([]);
    h.at(MIN + 5 * SEC); h.notifier.evaluate([w]); await h.settle();
    expect(h.lastCards()[0]?.command).toBe('ls');
  });

  test('the card goes when the prompt is answered, and its notice is then closed', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const noticeId = h.announcements()[0]!.noticeId;
    h.at(MIN + 5 * SEC); h.notifier.evaluate([]); await h.settle();
    expect(h.lastCards()).toEqual([]);
    expect(h.notifier.notice(noticeId)?.open).toBe(false);
    expect(h.notifier.notice('perm-unknown')).toBeUndefined();
  });

  test('a new prompt on the same task replaces the card', async () => {
    const h = harness();
    const first = h.block('a', T0);
    h.at(MIN); h.notifier.evaluate([first]); await h.settle();
    const firstId = h.lastCards()[0]!.promptId;
    const second = h.block('a', T0 + 2 * MIN, 'ls');
    h.at(2 * MIN); h.notifier.evaluate([second]); await h.settle();
    expect(h.lastCards()).toEqual([]);
    h.at(3 * MIN); h.notifier.evaluate([second]); await h.settle();
    expect(h.lastCards().map((card) => card.promptId)).not.toContain(firstId);
    expect(h.lastCards()).toHaveLength(1);
  });

  test('the same prompts give the same notice id, so a browser that spoke it once does not say it again', async () => {
    const one = harness();
    const two = harness();
    for (const h of [one, two]) {
      const w = h.block('a', T0);
      h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    }
    expect(one.announcements()[0]!.noticeId).toBe(two.announcements()[0]!.noticeId);
  });

  test('a sentence nobody received is not used up: it is said once a dashboard is open', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.setDashboards(0);
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    h.at(MIN + 5 * SEC); h.notifier.evaluate([w]); await h.settle();
    const unheard = h.announcements().length;
    expect(unheard).toBeGreaterThan(0);
    h.setDashboards(1);
    h.at(5 * MIN); h.notifier.evaluate([w]); await h.settle();
    expect(h.announcements()).toHaveLength(unheard + 1);
    h.at(5 * MIN + 5 * SEC); h.notifier.evaluate([w]); await h.settle();
    expect(h.announcements()).toHaveLength(unheard + 1);
  });

  test('a card whose prompt changed under the same finding is rebuilt for the new prompt', async () => {
    const h = harness();
    const w = h.block('a', T0);
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const firstId = h.lastCards()[0]!.promptId;
    h.sessions.get('kookr-a')!.events = [{ type: 'permission_request', sessionId: 'kookr-a', toolName: 'Bash', toolInput: { command: 'ls -la' }, eventSeq: 11 }];
    h.at(MIN + 5 * SEC); h.notifier.evaluate([w]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card.promptId).not.toBe(firstId);
    expect(card.command).toBe('ls -la');
    // The new prompt is said too, once the gap since the first sentence is over.
    expect(h.announcements()).toHaveLength(1);
    h.at(MIN + LUCY_PERMISSION_NOTICE_GAP_MS); h.notifier.evaluate([w]); await h.settle();
    expect(h.announcements()).toHaveLength(2);
    expect(h.announcements()[1]!.promptIds).toEqual([card.promptId]);
  });

  test('with a hook event but no queue finding the card still has the whole command, and no buttons', async () => {
    const h = harness();
    const w = h.block('a', T0, LONG_COMMAND);
    h.sessions.get('kookr-a')!.anomaly = null;
    h.at(MIN); h.notifier.evaluate([w]); await h.settle();
    const card = h.lastCards()[0]!;
    expect(card.command.length).toBeGreaterThan(200);
    expect(card.permissionRequest).toBeUndefined();
    expect(card.approveKey).toBeUndefined();
  });

  test('0 turns the notices off', async () => {
    const h = harness({ afterMs: 0 });
    const w = h.block('a', T0);
    h.at(10 * MIN); h.notifier.evaluate([w]); await h.settle();
    expect(h.pushes).toEqual([]);
  });

  test('setting 0 while cards are shown takes them off the panel, and nothing more is said', async () => {
    const h = harness();
    const a = h.block('a', T0);
    const b = h.block('b', T0 + 10 * SEC);
    h.at(MIN); h.notifier.evaluate([a, b]); await h.settle();
    h.at(MIN + 10 * SEC); h.notifier.evaluate([a, b]); await h.settle();
    expect(h.lastCards()).toHaveLength(2);
    const said = h.announcements().length;
    h.setAfterMs(0);
    h.at(MIN + 20 * SEC); h.notifier.evaluate([a, b]); await h.settle();
    expect(h.pushes[h.pushes.length - 1]).toEqual({ cards: [] });
    h.at(MIN + LUCY_PERMISSION_NOTICE_GAP_MS); h.notifier.evaluate([a, b]); await h.settle();
    expect(h.announcements()).toHaveLength(said);
  });

  test('the delay follows the setting', async () => {
    const h = harness({ afterMs: 5 * MIN });
    const w = h.block('a', T0);
    h.at(4 * MIN); h.notifier.evaluate([w]); await h.settle();
    expect(h.pushes).toEqual([]);
    h.at(5 * MIN); h.notifier.evaluate([w]); await h.settle();
    expect(h.lastCards()).toHaveLength(1);
  });
});

describe('sentences', () => {
  test('an unsayable task name and an MCP tool are not read out', () => {
    expect(singleNoticeSentence({ taskName: 'Implement GitHub issue #3932 in kookr-ai/kookr', toolName: 'mcp__evil__drop_tables' }))
      .toBe('A task is waiting for your permission to use an MCP tool. The command is on my card.');
    expect(singleNoticeSentence({ toolName: 'Bash' })).toBe('A task is waiting for your permission to use Bash. The command is on my card.');
  });

  test('tool names', () => {
    expect(spokenToolName('WebFetch')).toBe('WebFetch');
    expect(spokenToolName('mcp__github__create_issue')).toBe('an MCP tool');
    expect(spokenToolName('rm -rf /; Bash')).toBe('a tool');
  });

  test('grouped sentences', () => {
    expect(groupedNoticeSentence(2, true)).toBe('Two more tasks are waiting for you.');
    expect(groupedNoticeSentence(3, false)).toBe('Three tasks are waiting for your permission. The commands are on my cards.');
    expect(groupedNoticeSentence(12, true)).toBe('12 more tasks are waiting for you.');
  });
});

describe('pushLucyPermissionCards', () => {
  test('owner connections only, open sockets only', () => {
    const sent: string[] = [];
    const ws = (readyState: number) => ({ readyState, send: (data: string) => { sent.push(data); } });
    const count = pushLucyPermissionCards([
      { ws: ws(1), actor: { kind: 'owner' } },
      { ws: ws(1), actor: { kind: 'viewer', shareId: 's', tier: 'read' } as never },
      { ws: ws(3), actor: { kind: 'owner' } },
    ], [], { noticeId: 'perm-x', promptIds: ['p'] });
    expect(count).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual({ type: 'lucyPermissionCards', cards: [], serverNow: expect.any(Number), announce: { noticeId: 'perm-x', promptIds: ['p'] } });
  });
});
