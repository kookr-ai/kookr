import { describe, expect, test, vi } from 'vitest';

import type { AgentEvent } from '../core/agent-events.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { Task } from '../core/tasks.js';
import {
  createAskTaskPorts,
  createTelegramTaskBridge,
  liveSessionContinues,
  type TelegramTaskBridgeDeps,
} from './telegram-task-bridge.js';

const SESSION = 'tmux-abc';
// Stable across the broker's re-read (a fresh detectedAt each call would trip
// the anti-stale detection-mismatch guard — which is correct behavior).
const STABLE_ANOMALY = permissionAnomaly();

function liveTask(id = 'task-1'): Task {
  return {
    sessions: [{ tmuxSession: SESSION, lastStatus: 'running', crashRecovered: false }],
  } as unknown as Task;
}

function permissionAnomaly(): Anomaly {
  return {
    agentId: SESSION,
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'tool wants to run',
    detectedAt: new Date(), // recent — inside the approval TTL (anti-stale guard)
  } as Anomaly;
}

function permissionRequestEvent(): AgentEvent {
  return { type: 'permission_request', sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'git push' } } as AgentEvent;
}

function makeDeps(opts: { anomaly?: Anomaly; over?: Partial<TelegramTaskBridgeDeps> } = {}): {
  deps: TelegramTaskBridgeDeps;
  sendKeystroke: ReturnType<typeof vi.fn>;
  submitMessage: ReturnType<typeof vi.fn>;
  respondAndAdvance: ReturnType<typeof vi.fn>;
} {
  const sendKeystroke = vi.fn(async () => undefined);
  const submitMessage = vi.fn(async () => ({}));
  const respondAndAdvance = vi.fn(() => null);
  const anomaly = opts.anomaly ?? STABLE_ANOMALY;
  const deps: TelegramTaskBridgeDeps = {
    taskStore: { getTask: vi.fn(() => liveTask()) } as unknown as TelegramTaskBridgeDeps['taskStore'],
    monitor: {
      isPermissionBlocked: vi.fn(() => true),
      markInputReceived: vi.fn(() => true),
      getAgentEvents: vi.fn(() => [permissionRequestEvent()]),
    } as unknown as TelegramTaskBridgeDeps['monitor'],
    queue: {
      getAnomaly: vi.fn(() => anomaly),
      respondAndAdvance,
    } as unknown as TelegramTaskBridgeDeps['queue'],
    adapter: { sendKeystroke } as unknown as TelegramTaskBridgeDeps['adapter'],
    submitMessage,
    ...opts.over,
  };
  return { deps, sendKeystroke, submitMessage, respondAndAdvance };
}

describe('sendText', () => {
  test('delivers free text to the live session as directReply', async () => {
    const { deps, submitMessage } = makeDeps();
    const bridge = createTelegramTaskBridge(deps);
    const res = await bridge.sendText('task-1', '  do X instead  ');
    expect(res.ok).toBe(true);
    expect(submitMessage).toHaveBeenCalledWith(SESSION, 'do X instead', 'directReply');
  });

  test('rejects an empty message', async () => {
    const { deps, submitMessage } = makeDeps();
    const res = await createTelegramTaskBridge(deps).sendText('task-1', '   ');
    expect(res.ok).toBe(false);
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test('fails gracefully when there is no live session', async () => {
    const { deps } = makeDeps({
      over: { taskStore: { getTask: vi.fn(() => undefined) } as unknown as TelegramTaskBridgeDeps['taskStore'] },
    });
    const res = await createTelegramTaskBridge(deps).sendText('gone', 'hi');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no live session/);
  });

  test('fails when the only session is terminal (not live)', async () => {
    const terminalTask = { sessions: [{ tmuxSession: SESSION, lastStatus: 'completed', crashRecovered: false }] } as unknown as Task;
    const { deps } = makeDeps({
      over: { taskStore: { getTask: vi.fn(() => terminalTask) } as unknown as TelegramTaskBridgeDeps['taskStore'] },
    });
    const res = await createTelegramTaskBridge(deps).sendText('t', 'hi');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no live session/);
  });

  test('delivers to the expected session while it is still the live one', async () => {
    const { deps, submitMessage } = makeDeps();
    const res = await createTelegramTaskBridge(deps).sendText('task-1', 'hi', SESSION);
    expect(res.ok).toBe(true);
    expect(submitMessage).toHaveBeenCalledWith(SESSION, 'hi', 'directReply');
  });

  test('refuses when a different session replaced the expected one (task relaunched)', async () => {
    const relaunched = {
      sessions: [
        { tmuxSession: SESSION, lastStatus: 'aborted', crashRecovered: false },
        { tmuxSession: 'tmux-new', lastStatus: 'running', crashRecovered: false },
      ],
    } as unknown as Task;
    const { deps, submitMessage } = makeDeps({
      over: { taskStore: { getTask: vi.fn(() => relaunched) } as unknown as TelegramTaskBridgeDeps['taskStore'] },
    });
    const res = await createTelegramTaskBridge(deps).sendText('task-1', 'hi', SESSION);
    expect(res).toEqual({ ok: false, reason: 'the session that asked is no longer live' });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  test('delivers to a session that resumed the expected one (crash recovery, Reopen)', async () => {
    const resumed = {
      sessions: [
        { tmuxSession: SESSION, claudeSessionId: 'conv-1', lastStatus: 'aborted', crashRecovered: true },
        { tmuxSession: 'tmux-new', resumedConversationId: 'conv-1', lastStatus: 'running', crashRecovered: false },
      ],
    } as unknown as Task;
    const { deps, submitMessage } = makeDeps({
      over: { taskStore: { getTask: vi.fn(() => resumed) } as unknown as TelegramTaskBridgeDeps['taskStore'] },
    });
    const res = await createTelegramTaskBridge(deps).sendText('task-1', 'hi', SESSION);
    expect(res.ok).toBe(true);
    expect(submitMessage).toHaveBeenCalledWith('tmux-new', 'hi', 'directReply');
  });
});

describe('liveSessionContinues', () => {
  const asker = { tmuxSession: 'tmux-a', claudeSessionId: 'conv-a', lastStatus: 'aborted', crashRecovered: true };

  test('is true for the live session itself', () => {
    const task = { sessions: [{ ...asker, lastStatus: 'running', crashRecovered: false }] } as unknown as Task;
    expect(liveSessionContinues(task, 'tmux-a')).toBe(true);
  });

  test('follows resumed conversations back to the asking session, through several resumes', () => {
    const task = {
      sessions: [
        asker,
        { tmuxSession: 'tmux-b', claudeSessionId: 'conv-b', resumedConversationId: 'conv-a', lastStatus: 'aborted', crashRecovered: true },
        { tmuxSession: 'tmux-c', claudeSessionId: 'conv-c', resumedConversationId: 'conv-b', lastStatus: 'running' },
      ],
    } as unknown as Task;
    expect(liveSessionContinues(task, 'tmux-a')).toBe(true);
    expect(liveSessionContinues(task, 'tmux-b')).toBe(true);
  });

  test('is false for a fresh relaunch, for a resume of another conversation, and with no live session', () => {
    const fresh = { sessions: [asker, { tmuxSession: 'tmux-b', lastStatus: 'running' }] } as unknown as Task;
    expect(liveSessionContinues(fresh, 'tmux-a')).toBe(false);
    const other = {
      sessions: [asker, { tmuxSession: 'tmux-b', resumedConversationId: 'conv-unrelated', lastStatus: 'running' }],
    } as unknown as Task;
    expect(liveSessionContinues(other, 'tmux-a')).toBe(false);
    expect(liveSessionContinues({ sessions: [asker] } as unknown as Task, 'tmux-a')).toBe(false);
  });

  test('opencode keeps one conversation id across resumes: a pin on a middle session is still found', () => {
    const task = {
      sessions: [
        { tmuxSession: 'tmux-a', claudeSessionId: 'ses_1', lastStatus: 'aborted' },
        { tmuxSession: 'tmux-b', claudeSessionId: 'ses_1', resumedConversationId: 'ses_1', lastStatus: 'aborted' },
        { tmuxSession: 'tmux-c', claudeSessionId: 'ses_1', resumedConversationId: 'ses_1', lastStatus: 'running' },
      ],
    } as unknown as Task;
    expect(liveSessionContinues(task, 'tmux-b')).toBe(true);
    expect(liveSessionContinues(task, 'tmux-a')).toBe(true);
    expect(liveSessionContinues(task, 'tmux-other')).toBe(false);
  });

  test('terminates on a resume cycle', () => {
    const cyclic = {
      sessions: [
        { tmuxSession: 'tmux-x', claudeSessionId: 'conv-x', resumedConversationId: 'conv-y', lastStatus: 'aborted' },
        { tmuxSession: 'tmux-y', claudeSessionId: 'conv-y', resumedConversationId: 'conv-x', lastStatus: 'running' },
      ],
    } as unknown as Task;
    expect(liveSessionContinues(cyclic, 'tmux-a')).toBe(false);
  });
});

describe('createAskTaskPorts (the production wiring of kookr ask to tasks)', () => {
  const relaunched = {
    sessions: [
      { tmuxSession: 'tmux-a', claudeSessionId: 'conv-a', lastStatus: 'aborted' },
      { tmuxSession: 'tmux-b', lastStatus: 'running' },
    ],
  } as unknown as Task;

  function ports(task: Task | undefined, bridge?: { sendText: ReturnType<typeof vi.fn> }) {
    return createAskTaskPorts({
      taskStore: { getTask: vi.fn(() => task) } as unknown as TelegramTaskBridgeDeps['taskStore'],
      bridge: () => bridge as never,
    });
  }

  test('reports the latest live session and whether it continues a pinned one', () => {
    const p = ports(relaunched);
    expect(p.liveSession('t')).toBe('tmux-b');
    expect(p.sessionContinues('t', 'tmux-b')).toBe(true);
    expect(p.sessionContinues('t', 'tmux-a')).toBe(false);
    expect(ports(undefined).liveSession('t')).toBeUndefined();
    expect(ports(undefined).sessionContinues('t', 'tmux-a')).toBe(false);
  });

  test('passes the pinned session to the bridge, and only when there is one', async () => {
    const sendText = vi.fn(async () => ({ ok: true }));
    const p = ports(relaunched, { sendText });
    await p.deliverToTask('t', 'pinned', 'tmux-a');
    await p.deliverToTask('t', 'unpinned');
    expect(sendText.mock.calls).toEqual([['t', 'pinned', 'tmux-a'], ['t', 'unpinned']]);
  });

  test('fails cleanly before the reply bridge exists', async () => {
    expect(await ports(relaunched).deliverToTask('t', 'hi')).toEqual({ ok: false, reason: 'reply bridge not ready' });
  });

  test('end to end with the real bridge: a fresh relaunch is not typed into', async () => {
    const { deps, submitMessage } = makeDeps({
      over: { taskStore: { getTask: vi.fn(() => relaunched) } as unknown as TelegramTaskBridgeDeps['taskStore'] },
    });
    const bridge = createTelegramTaskBridge(deps);
    const p = createAskTaskPorts({ taskStore: deps.taskStore, bridge: () => bridge });
    expect(await p.deliverToTask('t', 'hi', 'tmux-a')).toEqual({ ok: false, reason: 'the session that asked is no longer live' });
    expect(submitMessage).not.toHaveBeenCalled();
    expect(await p.deliverToTask('t', 'hi', 'tmux-b')).toEqual({ ok: true });
  });
});

describe('approvePermission', () => {
  test('approves the current prompt with keystroke 1 and advances the queue', async () => {
    const { deps, sendKeystroke, respondAndAdvance } = makeDeps();
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1');
    expect(res.ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1');
    expect(respondAndAdvance).toHaveBeenCalledWith(SESSION);
  });

  test('approves when the button prompt id matches the live prompt', async () => {
    const { deps, sendKeystroke } = makeDeps();
    const bridge = createTelegramTaskBridge(deps);
    const pid = bridge.permissionPromptId('task-1');
    expect(pid).toBeTruthy();
    const res = await bridge.approvePermission('task-1', pid!);
    expect(res.ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1');
  });

  test('REFUSES when the button prompt id no longer matches (stale button, different prompt)', async () => {
    const { deps, sendKeystroke, respondAndAdvance } = makeDeps();
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1', 'deadbeef0000');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/prompt changed/);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(respondAndAdvance).not.toHaveBeenCalled();
  });

  test('refuses (and does not advance the queue) when no longer permission-blocked', async () => {
    const { deps, sendKeystroke, respondAndAdvance } = makeDeps({
      over: {
        monitor: {
          isPermissionBlocked: vi.fn(() => false),
          markInputReceived: vi.fn(() => true),
          getAgentEvents: vi.fn(() => []),
        } as unknown as TelegramTaskBridgeDeps['monitor'],
      },
    });
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1');
    expect(res.ok).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(respondAndAdvance).not.toHaveBeenCalled();
  });

  test('REFUSES a stale prompt (binding past its TTL) via the broker', async () => {
    const stale = { ...permissionAnomaly(), detectedAt: new Date(Date.now() - 10 * 60 * 1000) } as Anomaly;
    const { deps, sendKeystroke, respondAndAdvance } = makeDeps({ anomaly: stale });
    const res = await createTelegramTaskBridge(deps).approvePermission('task-1');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/stale/i);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect(respondAndAdvance).not.toHaveBeenCalled();
  });
});

describe('Telegram permission card decisions (issue #3925)', () => {
  const CLAUDE_PANE = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for git commands\n  3. No, and tell Claude what to do differently (esc)';

  test('deny presses the option the reader classes as deny', async () => {
    const { deps, sendKeystroke } = makeDeps({ over: { capturePane: vi.fn(async () => CLAUDE_PANE) } });
    const bridge = createTelegramTaskBridge(deps);
    const res = await bridge.denyPermission('task-1', bridge.permissionPromptId('task-1')!);
    expect(res).toEqual({ ok: true });
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '3');
  });

  test('deny refuses when no deny option is on screen, and a later approve still works', async () => {
    const { deps, sendKeystroke } = makeDeps({ over: { capturePane: vi.fn(async () => 'Do you want to proceed?\n❯ 1. Yes\n  2. Later') } });
    const bridge = createTelegramTaskBridge(deps);
    const pid = bridge.permissionPromptId('task-1')!;
    const res = await bridge.denyPermission('task-1', pid);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no Deny option/);
    expect(sendKeystroke).not.toHaveBeenCalled();
    expect((await bridge.approvePermission('task-1', pid)).ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1');
  });

  test('deny without a prompt id is refused', async () => {
    const { deps, sendKeystroke } = makeDeps({ over: { capturePane: vi.fn(async () => CLAUDE_PANE) } });
    const res = await createTelegramTaskBridge(deps).denyPermission('task-1', '');
    expect(res.ok).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  test('approve refuses a menu with no one-time Yes instead of pressing 1', async () => {
    const pane = 'Do you want to proceed?\n❯ 1. Yes, allow all edits during this session\n  2. No';
    const { deps, sendKeystroke } = makeDeps({ over: { capturePane: vi.fn(async () => pane) } });
    const bridge = createTelegramTaskBridge(deps);
    const res = await bridge.approvePermission('task-1', bridge.permissionPromptId('task-1')!);
    expect(res.ok).toBe(false);
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  test('approve then deny on the same prompt sends one key', async () => {
    const { deps, sendKeystroke } = makeDeps({ over: { capturePane: vi.fn(async () => CLAUDE_PANE) } });
    const bridge = createTelegramTaskBridge(deps);
    const pid = bridge.permissionPromptId('task-1')!;
    const [a, b] = await Promise.all([bridge.approvePermission('task-1', pid), bridge.denyPermission('task-1', pid)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(sendKeystroke).toHaveBeenCalledTimes(1);
  });

  test('a bound button is not refused by the 5-minute binding limit; an unbound one still is', async () => {
    const old = { ...permissionAnomaly(), detectedAt: new Date(Date.now() - 40 * 60 * 1000) } as Anomaly;
    const { deps, sendKeystroke } = makeDeps({ anomaly: old });
    const bridge = createTelegramTaskBridge(deps);
    expect((await bridge.approvePermission('task-1')).reason).toMatch(/stale/i);
    expect((await bridge.approvePermission('task-1', bridge.permissionPromptId('task-1')!)).ok).toBe(true);
    expect(sendKeystroke).toHaveBeenCalledTimes(1);
  });

  test('describePermissionPrompt returns the whole command with secrets hidden, and deny availability', async () => {
    const long = `git push https://x-access-token:ghp_${'a'.repeat(36)}@github.com/o/r ${'z'.repeat(600)}`;
    const { deps } = makeDeps({
      over: {
        capturePane: vi.fn(async () => CLAUDE_PANE),
        monitor: {
          isPermissionBlocked: vi.fn(() => true),
          markInputReceived: vi.fn(() => true),
          getAgentEvents: vi.fn(() => [{ ...permissionRequestEvent(), toolInput: { command: long } } as AgentEvent]),
        } as unknown as TelegramTaskBridgeDeps['monitor'],
      },
    });
    const info = await createTelegramTaskBridge(deps).describePermissionPrompt('task-1');
    expect(info?.toolName).toBe('Bash');
    expect(info?.canDeny).toBe(true);
    expect(info?.command).not.toContain('ghp_');
    expect(info?.command).toContain('z'.repeat(600));
  });

  test('describePermissionPrompt is null when the task is not blocked', async () => {
    const { deps } = makeDeps({
      over: {
        monitor: {
          isPermissionBlocked: vi.fn(() => false),
          markInputReceived: vi.fn(() => true),
          getAgentEvents: vi.fn(() => []),
        } as unknown as TelegramTaskBridgeDeps['monitor'],
      },
    });
    expect(await createTelegramTaskBridge(deps).describePermissionPrompt('task-1')).toBeNull();
  });
});
