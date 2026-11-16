/**
 * Issue #3925 end to end: a permission prompt that has waited past the page
 * threshold reaches the operator's Telegram chat as one message with the whole
 * command and Approve once / Deny buttons, for any task (not only tasks
 * launched from Telegram).
 *
 * Real pieces: the wait alerter, the reply bridge, the Telegram integration,
 * and the in-process fake Bot API server (the one `scripts/ask-lucy-browser-proof.ts`
 * uses). Faked: the monitor, attention queue, task store and terminal, which
 * are reduced to the few reads the bridge and the alerter make.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentEvent } from '../core/agent-events.js';
import type { Task } from '../core/tasks.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { LaunchResult } from '../shared/contracts/launch.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { TelegramHandle } from '../shared/contracts/telegram.js';
import { startTelegramTrigger } from '../integrations/telegram/index.js';
import { startFakeTelegram, type FakeTelegramServer } from '../integrations/telegram/fake-telegram-server.js';
import type { TelegramUpdate } from '../integrations/telegram/api-client.js';
import { PermissionPromptWaitAlerter, collectPermissionPromptWaits } from './permission-prompt-wait-alert.js';
import { createTelegramTaskBridge, type TelegramTaskBridgeDeps } from './telegram-task-bridge.js';

const USER = 4242;
const STRANGER = 9999;
const TASK_ID = '6f1d2c3b-0a9e-4f8d-9c7b-1a2b3c4d5e6f';
const SESSION = 'kookr-6f1d2c3b';
const MIN = 60_000;

const CLAUDE_BASH_PANE = [
  '● Bash(rm -rf build)',
  'Bash command',
  'Do you want to proceed?',
  '❯ 1. Yes',
  "  2. Yes, and don't ask again for rm commands in /repo",
  '  3. No, and tell Claude what to do differently (esc)',
].join('\n');

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw lastError;
}

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

function keyboardOf(message: { reply_markup?: unknown }): Keyboard {
  return ((message.reply_markup as { inline_keyboard?: Keyboard } | undefined)?.inline_keyboard) ?? [];
}

describe('Telegram permission card (issue #3925)', () => {
  let tmp: string;
  let fake: FakeTelegramServer;
  let handle: TelegramHandle | null = null;
  const savedUrl = process.env.KOOKR_TELEGRAM_API_URL;

  // Live, mutable world the fakes read from.
  let blocked: boolean;
  let events: AgentEvent[];
  let anomaly: Anomaly;
  let pane: string;
  let taskStatus: string;
  let nowMs: number;
  const T0 = Date.parse('2026-11-16T09:00:00.000Z');

  const sendKeystroke = vi.fn(async (_session: string, _key: string) => undefined);
  const logAppend = vi.fn(async (_entry: unknown) => undefined);
  let pages: ServerMessage[];

  function openPrompt(command: string, seq = 1, sinceMs = T0): void {
    blocked = true;
    events = [{
      type: 'permission_request',
      sessionId: SESSION,
      toolName: 'Bash',
      toolInput: { command },
      eventSeq: seq,
    } as unknown as AgentEvent];
    anomaly = {
      agentId: SESSION,
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'Agent is waiting for permission for tool: Bash',
      detectedAt: new Date(sinceMs).toISOString(),
    } as unknown as Anomaly;
  }

  function answerElsewhere(): void {
    blocked = false;
    events = [...events, { type: 'input_received', sessionId: SESSION } as unknown as AgentEvent];
  }

  function task(): Task {
    return {
      id: TASK_ID,
      name: 'Implement issue 3925',
      status: taskStatus,
      cwd: '/home/op/git/kookr-worktree',
      projectId: 'kookr',
      sessions: [{ tmuxSession: SESSION, lastStatus: 'running', crashRecovered: false }],
    } as unknown as Task;
  }

  const monitor = {
    isPermissionBlocked: () => blocked,
    markInputReceived: () => true,
    getAgentEvents: () => events,
    getCurrentAnomaly: () => (blocked ? anomaly : null),
  };

  function buildWorld() {
    const bridge = createTelegramTaskBridge({
      taskStore: { getTask: (id: string) => (id === TASK_ID ? task() : undefined) } as unknown as TelegramTaskBridgeDeps['taskStore'],
      monitor: monitor as unknown as TelegramTaskBridgeDeps['monitor'],
      queue: {
        getAnomaly: () => (blocked ? anomaly : null),
        respondAndAdvance: () => null,
      } as unknown as TelegramTaskBridgeDeps['queue'],
      adapter: { sendKeystroke },
      capturePane: async () => pane,
      submitMessage: async () => ({}),
      interactionLog: { append: logAppend } as unknown as TelegramTaskBridgeDeps['interactionLog'],
      now: () => new Date(nowMs),
    });
    return bridge;
  }

  async function start(bridge: ReturnType<typeof buildWorld>): Promise<PermissionPromptWaitAlerter> {
    handle = await startTelegramTrigger({
      token: 'test-token',
      allowedUserIds: new Set([USER]),
      allowedProjects: [{ name: 'kookr', cwd: tmp }],
      dataDir: tmp,
      dryRun: false,
      dashboardBaseUrl: 'https://kookr.example.com',
      launchTask: vi.fn(async () => ({ task: { id: 't' }, queued: false } as unknown as LaunchResult)),
      llmClient: null,
      replyToTask: (taskId, text) => bridge.sendText(taskId, text),
      approveTaskPermission: (taskId, promptId, sender) =>
        bridge.approvePermission(taskId, promptId, sender === undefined ? undefined : { telegramUserId: sender }),
      permissionPromptId: (taskId) => bridge.permissionPromptId(taskId),
      denyTaskPermission: (taskId, promptId, sender) => bridge.denyPermission(taskId, promptId, { telegramUserId: sender }),
      describePermissionPrompt: (taskId) => bridge.describePermissionPrompt(taskId),
      permissionPromptClosedReason: (taskId) => bridge.permissionPromptClosedReason(taskId),
    });
    const card = handle.permissionCard;
    expect(card).toBeDefined();
    return new PermissionPromptWaitAlerter({
      broadcast: (msg) => { pages.push(msg); },
      now: () => nowMs,
      card,
    });
  }

  function tick(alerter: PermissionPromptWaitAlerter): void {
    alerter.evaluate(collectPermissionPromptWaits([task()], monitor));
  }

  function tap(data: string, opts: { from?: number; messageId: number; updateId: number }): void {
    fake.queueUpdates([{
      update_id: opts.updateId,
      callback_query: {
        id: `cb-${opts.updateId}`,
        from: { id: opts.from ?? USER },
        data,
        message: { message_id: opts.messageId, chat: { id: USER, type: 'private' } },
      },
    } as unknown as TelegramUpdate]);
  }

  /** Wait past the threshold and return the one card that was sent. */
  async function cardAfterThreshold(alerter: PermissionPromptWaitAlerter) {
    nowMs = T0 + 3 * MIN + 5_000;
    tick(alerter);
    await waitFor(() => expect(fake.outbound.sendMessage).toHaveLength(1));
    // Later ticks while the prompt is open send nothing more.
    nowMs += 30_000;
    tick(alerter);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.outbound.sendMessage).toHaveLength(1);
    // The fake numbers sent messages from 100 upward; the card is the first one.
    return { message: fake.outbound.sendMessage[0]!, messageId: 100 };
  }

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'kookr-perm-card-'));
    fake = await startFakeTelegram();
    process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
    sendKeystroke.mockClear();
    logAppend.mockClear();
    pages = [];
    pane = CLAUDE_BASH_PANE;
    taskStatus = 'inProgress';
    nowMs = T0;
    openPrompt('rm -rf build');
  });

  afterEach(async () => {
    if (handle) { await handle.stop(); handle = null; }
    await fake.stop();
    if (savedUrl === undefined) delete process.env.KOOKR_TELEGRAM_API_URL;
    else process.env.KOOKR_TELEGRAM_API_URL = savedUrl;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('a task not launched from Telegram gets exactly one card with Approve once and Deny, and no plain page', async () => {
    const alerter = await start(buildWorld());
    nowMs = T0 + 2 * MIN;
    tick(alerter);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.outbound.sendMessage).toHaveLength(0);

    const { message } = await cardAfterThreshold(alerter);
    expect(message.chat_id).toBe(USER);
    expect(message.text).toContain('"Implement issue 3925" in kookr');
    expect(message.text).toContain('permission to use Bash');
    expect(message.text).toContain('rm -rf build');
    expect(message.text).toContain(`https://kookr.example.com`);
    expect(message.text).toContain(TASK_ID);
    const buttons = keyboardOf(message).flat();
    expect(buttons.map((b) => b.text)).toEqual(['✅ Approve once', '🚫 Deny']);
    expect(buttons.every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
    expect(buttons.some((b) => /always/i.test(b.text))).toBe(false);
    expect(pages).toHaveLength(0);
  });

  test('Approve once sends the one-time Yes key once; a second tap, a stranger, and Deny afterwards send nothing', async () => {
    const alerter = await start(buildWorld());
    const { message, messageId } = await cardAfterThreshold(alerter);
    const [approve, deny] = keyboardOf(message).flat();

    tap(approve!.callback_data, { from: STRANGER, messageId, updateId: 1 });
    await waitFor(() => expect(fake.outbound.answerCallbackQuery.some((a) => a.callback_query_id === 'cb-1')).toBe(true));
    expect(sendKeystroke).not.toHaveBeenCalled();

    tap(approve!.callback_data, { messageId, updateId: 2 });
    await waitFor(() => expect(sendKeystroke).toHaveBeenCalledTimes(1));
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1');
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.message_id === messageId && e.text.endsWith('✅ Approved once from Telegram.'))).toBe(true));

    tap(approve!.callback_data, { messageId, updateId: 3 });
    tap(deny!.callback_data, { messageId, updateId: 4 });
    await waitFor(() => expect(fake.outbound.answerCallbackQuery.some((a) => a.callback_query_id === 'cb-4')).toBe(true));
    expect(sendKeystroke).toHaveBeenCalledTimes(1);
    expect(fake.outbound.answerCallbackQuery.find((a) => a.callback_query_id === 'cb-3')?.text).toMatch(/already answered/);

    // The decision is in the interaction log with who and from where.
    expect(logAppend).toHaveBeenCalledTimes(1);
    expect(logAppend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: SESSION,
      content: '[telegram approve once: 1]',
      actor: `telegram:${USER}`,
    }));

    // The tap already closed the card: answering does not overwrite "Approved".
    answerElsewhere();
    tick(alerter);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.outbound.editMessageText.filter((e) => e.message_id === messageId)).toHaveLength(1);
  });

  test('Deny sends the key of the option the reader classes as deny, once, and logs it', async () => {
    const alerter = await start(buildWorld());
    const { message, messageId } = await cardAfterThreshold(alerter);
    const deny = keyboardOf(message).flat().find((b) => b.text === '🚫 Deny')!;

    tap(deny.callback_data, { messageId, updateId: 1 });
    await waitFor(() => expect(sendKeystroke).toHaveBeenCalledTimes(1));
    expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '3');
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.text.endsWith('🚫 Denied from Telegram.'))).toBe(true));
    tap(deny.callback_data, { messageId, updateId: 2 });
    await waitFor(() => expect(fake.outbound.answerCallbackQuery.some((a) => a.callback_query_id === 'cb-2')).toBe(true));
    expect(sendKeystroke).toHaveBeenCalledTimes(1);
    expect(logAppend).toHaveBeenCalledWith(expect.objectContaining({ content: '[telegram deny: 3]', actor: `telegram:${USER}` }));
  });

  test('a tap after the prompt changed sends nothing and says why', async () => {
    const alerter = await start(buildWorld());
    const { message, messageId } = await cardAfterThreshold(alerter);
    const [approve, deny] = keyboardOf(message).flat();

    // Same command, new prompt (a later request): the card's binding no longer matches.
    openPrompt('rm -rf build', 2, T0 + 4 * MIN);
    tap(approve!.callback_data, { messageId, updateId: 1 });
    tap(deny!.callback_data, { messageId, updateId: 2 });
    await waitFor(() => expect(fake.outbound.answerCallbackQuery.some((a) => a.callback_query_id === 'cb-2')).toBe(true));
    expect(sendKeystroke).not.toHaveBeenCalled();
    for (const id of ['cb-1', 'cb-2']) {
      expect(fake.outbound.answerCallbackQuery.find((a) => a.callback_query_id === id)?.text).toMatch(/prompt changed/);
    }
    expect(logAppend).not.toHaveBeenCalled();
  });

  test('a card tapped long after the 5-minute dashboard binding limit still answers its own prompt', async () => {
    const alerter = await start(buildWorld());
    const { message, messageId } = await cardAfterThreshold(alerter);
    nowMs = T0 + 50 * MIN;
    tap(keyboardOf(message).flat()[0]!.callback_data, { messageId, updateId: 1 });
    await waitFor(() => expect(sendKeystroke).toHaveBeenCalledWith(SESSION, '1'));
  });

  test('answering in the dashboard edits the card on the next tick and removes its buttons', async () => {
    const alerter = await start(buildWorld());
    const { message, messageId } = await cardAfterThreshold(alerter);
    answerElsewhere();
    tick(alerter);
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.message_id === messageId)).toBe(true));
    const edit = fake.outbound.editMessageText.find((e) => e.message_id === messageId)!;
    expect(edit.text.startsWith(message.text)).toBe(true);
    expect(edit.text).toMatch(/Answered outside Telegram/);
    // editMessageText without reply_markup drops the inline keyboard.
    expect((edit as { reply_markup?: unknown }).reply_markup).toBeUndefined();
    expect(pages).toHaveLength(0);
  });

  test('the task ending edits the card to say so', async () => {
    const alerter = await start(buildWorld());
    const { messageId } = await cardAfterThreshold(alerter);
    taskStatus = 'failed';
    alerter.evaluate(collectPermissionPromptWaits([task()], monitor));
    await waitFor(() => expect(fake.outbound.editMessageText.some((e) => e.message_id === messageId && /task ended/.test(e.text))).toBe(true));
  });

  test('a 2500-character command is shown whole; a 6000-character one shows head and tail with the count left out', async () => {
    const long2500 = `echo ${'a'.repeat(2490)} END25`;
    openPrompt(long2500);
    let alerter = await start(buildWorld());
    let { message } = await cardAfterThreshold(alerter);
    expect(message.text).toContain(long2500);
    expect(message.text).not.toMatch(/left out/);
    await handle!.stop();
    handle = null;
    await fake.stop();

    fake = await startFakeTelegram();
    process.env.KOOKR_TELEGRAM_API_URL = fake.baseUrl;
    const head = `H${'h'.repeat(1499)}`;
    const middle = 'm'.repeat(3000);
    const tail = `${'t'.repeat(1499)}T && rm -rf /`;
    const long6000 = head + middle + tail;
    openPrompt(long6000);
    alerter = await start(buildWorld());
    ({ message } = await cardAfterThreshold(alerter));
    expect(message.text).toContain(head);
    expect(message.text).toContain(long6000.slice(-1500));
    expect(message.text).toContain('rm -rf /');
    expect(message.text).toContain(`[${long6000.length - 3000} characters left out]`);
    expect(message.text).not.toContain(middle);
    expect(message.text.length).toBeLessThan(4096);
  });

  test('a token-shaped secret in the command is replaced', async () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    openPrompt(`curl -H "x-token: ${token}" https://api.example.invalid && echo done`);
    const alerter = await start(buildWorld());
    const { message } = await cardAfterThreshold(alerter);
    expect(message.text).not.toContain(token);
    expect(message.text).toContain('[REDACTED]');
    expect(message.text).toContain('https://api.example.invalid');
  });

  test('no Deny button when the pane shows no option the reader classes as deny', async () => {
    pane = 'Do you want to proceed?\n❯ 1. Yes\n  2. Not now';
    const alerter = await start(buildWorld());
    const { message } = await cardAfterThreshold(alerter);
    expect(keyboardOf(message).flat().map((b) => b.text)).toEqual(['✅ Approve once']);
  });

  test('a task launched from Telegram keeps its immediate notice and gets no second message or page', async () => {
    mkdirSync(join(tmp, 'telegram'), { recursive: true });
    writeFileSync(join(tmp, 'telegram', 'state.json'), JSON.stringify({ offset: 0, origin: { [TASK_ID]: USER } }));
    const alerter = await start(buildWorld());
    handle!.onPermissionBlocked(TASK_ID, 'Bash(rm -rf build)');
    await waitFor(() => expect(fake.outbound.sendMessage).toHaveLength(1));
    nowMs = T0 + 4 * MIN;
    tick(alerter);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.outbound.sendMessage).toHaveLength(1);
    expect(pages).toHaveLength(0);
  });

  test('the plain page is still sent when the card cannot be sent', async () => {
    const alerter = await start(buildWorld());
    await fake.stop();
    nowMs = T0 + 3 * MIN + 5_000;
    tick(alerter);
    await waitFor(() => expect(pages.map((p) => (p as { operationalAlert?: { state?: string } }).operationalAlert?.state)).toEqual(['fired']));
    fake = await startFakeTelegram();
  });
});
