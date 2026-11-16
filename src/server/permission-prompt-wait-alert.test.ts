import { describe, expect, test, vi } from 'vitest';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';
import type { AgentEvent } from '../core/agent-events.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { parseHookEvent } from '../core/hook-parser.js';
import { Monitor } from '../core/monitor.js';
import { TaskStore } from '../core/tasks.js';
import { Watchdog } from '../core/watchdog.js';
import { operationalAlertToSignal } from '../observability/signal-delivery/operational-alert-bridge.js';
import {
  PERMISSION_PROMPT_WAIT_THRESHOLD_MS,
  PermissionPromptWaitAlerter,
  collectPermissionPromptWaits,
  describePermissionToolInput,
  permissionPromptAlertKey,
  type PermissionPromptTaskView,
  type PermissionPromptWait,
} from './permission-prompt-wait-alert.js';

type AlertMessage = Extract<ServerMessage, { type: 'alert' }>;

const MIN = 60_000;
const T0 = Date.parse('2026-11-15T21:12:35.000Z');

function harness() {
  let nowMs = T0;
  const sent: AlertMessage[] = [];
  const alerter = new PermissionPromptWaitAlerter({
    broadcast: (msg) => { sent.push(msg as AlertMessage); },
    now: () => nowMs,
  });
  return {
    alerter,
    sent,
    at(ms: number) { nowMs = T0 + ms; },
  };
}

function wait(overrides: Partial<PermissionPromptWait> = {}): PermissionPromptWait {
  return {
    taskId: 'task-1',
    taskName: 'Implement kookr issue 3743 merge PR',
    toolName: 'Bash',
    command: 'rm -rf "$(cat /tmp/mutdir.txt)"',
    sinceMs: T0,
    ...overrides,
  };
}

function states(sent: AlertMessage[]): string[] {
  return sent.map((m) => `${m.operationalAlert?.state}:${m.operationalAlert?.key}`);
}

describe('PermissionPromptWaitAlerter (issue #3872)', () => {
  test('a prompt older than 3 minutes emits one alert, and answering it emits the clear', () => {
    const h = harness();
    // Liveness ticks every few seconds; only the first tick past the threshold pages.
    for (let ms = 0; ms <= 10 * MIN; ms += 5_000) {
      h.at(ms);
      h.alerter.evaluate([wait()]);
    }
    expect(states(h.sent)).toEqual([`fired:${permissionPromptAlertKey('task-1')}`]);
    const alert = h.sent[0];
    expect(alert.severity).toBe('warning');
    expect(alert.operationalAlert?.metric).toBe('permission_prompt_wait');
    // The page names the task, the tool and the command.
    expect(alert.summary).toContain('Implement kookr issue 3743 merge PR');
    expect(alert.summary).toContain('task-1');
    expect(alert.summary).toContain('Bash: rm -rf "$(cat /tmp/mutdir.txt)"');
    expect(alert.summary).toContain('3m');

    // Answered: the task no longer appears in the blocked list.
    h.at(10 * MIN + 5_000);
    h.alerter.evaluate([]);
    expect(states(h.sent)).toEqual([
      `fired:${permissionPromptAlertKey('task-1')}`,
      `recovered:${permissionPromptAlertKey('task-1')}`,
    ]);
    expect(h.sent[1].severity).toBe('info');
    expect(h.sent[1].summary).toContain('Implement kookr issue 3743 merge PR');

    // Further ticks with nothing blocked stay quiet.
    h.at(11 * MIN);
    h.alerter.evaluate([]);
    expect(h.sent).toHaveLength(2);
  });

  test('a prompt answered within 3 minutes emits nothing', () => {
    const h = harness();
    for (let ms = 0; ms < PERMISSION_PROMPT_WAIT_THRESHOLD_MS; ms += 5_000) {
      h.at(ms);
      h.alerter.evaluate([wait()]);
    }
    h.at(PERMISSION_PROMPT_WAIT_THRESHOLD_MS);
    h.alerter.evaluate([]);
    h.at(20 * MIN);
    h.alerter.evaluate([]);
    expect(h.sent).toEqual([]);
  });

  test('the wait is measured from when the prompt opened, not from the first tick that saw it', () => {
    const h = harness();
    // The alerter first hears of the prompt 4 minutes after it opened.
    h.at(4 * MIN);
    h.alerter.evaluate([wait()]);
    expect(states(h.sent)).toEqual([`fired:${permissionPromptAlertKey('task-1')}`]);
    expect(h.sent[0].summary).toContain('4m');
  });

  test('a new prompt on the same task clears the old page and waits a full threshold again', () => {
    const h = harness();
    h.at(5 * MIN);
    h.alerter.evaluate([wait()]);
    // First prompt answered and a second one opened between two ticks.
    const second = wait({ sinceMs: T0 + 5 * MIN + 2_000, command: 'git push --force' });
    h.at(5 * MIN + 5_000);
    h.alerter.evaluate([second]);
    expect(states(h.sent)).toEqual([
      `fired:${permissionPromptAlertKey('task-1')}`,
      `recovered:${permissionPromptAlertKey('task-1')}`,
    ]);
    h.at(7 * MIN);
    h.alerter.evaluate([second]);
    expect(h.sent).toHaveLength(2);
    h.at(8 * MIN + 2_000);
    h.alerter.evaluate([second]);
    expect(h.sent).toHaveLength(3);
    expect(h.sent[2].summary).toContain('git push --force');
  });

  test('tasks are tracked separately; one clearing does not clear the other', () => {
    const h = harness();
    h.at(4 * MIN);
    h.alerter.evaluate([wait(), wait({ taskId: 'task-2', taskName: 'other' })]);
    expect(h.sent).toHaveLength(2);
    h.at(5 * MIN);
    h.alerter.evaluate([wait({ taskId: 'task-2', taskName: 'other' })]);
    expect(states(h.sent).slice(2)).toEqual([`recovered:${permissionPromptAlertKey('task-1')}`]);
    expect(h.alerter.firingTaskIds()).toEqual(['task-2']);
  });

  test('alert and clear become operator signals with matching keys', () => {
    const h = harness();
    h.at(4 * MIN);
    h.alerter.evaluate([wait()]);
    h.alerter.evaluate([]);
    const [fire, clear] = h.sent.map((m) => operationalAlertToSignal(m));
    expect(fire).toMatchObject({ kind: 'alert', key: 'op:permission_prompt:task-1:alert' });
    expect(clear).toMatchObject({ kind: 'clear', key: 'op:permission_prompt:task-1:clear' });
  });

  test('a throwing broadcast does not break evaluation', () => {
    const alerter = new PermissionPromptWaitAlerter({
      broadcast: () => { throw new Error('boom'); },
      now: () => T0 + 4 * MIN,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(() => alerter.evaluate([wait()])).not.toThrow();
      expect(alerter.firingTaskIds()).toEqual(['task-1']);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('describePermissionToolInput', () => {
  test('quotes the command, collapses whitespace, and caps the length', () => {
    expect(describePermissionToolInput({ command: 'ls\n  -la' })).toBe('ls -la');
    expect(describePermissionToolInput({ file_path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(describePermissionToolInput(undefined)).toBe('');
    const long = describePermissionToolInput({ command: 'x'.repeat(500) }, 50);
    expect(long).toHaveLength(50);
    expect(long.endsWith('…')).toBe(true);
  });

  test('redacts secrets in the command', () => {
    const text = describePermissionToolInput({
      command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://x',
    });
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('collectPermissionPromptWaits', () => {
  // Hook lines shaped like the 15 Nov incident (kookr-28245f61): a subagent's
  // Bash call hits a PermissionRequest, then Claude Code sends a
  // Notification(permission_prompt) about 7 seconds later, and nothing else
  // arrives for 76 minutes.
  const SESSION_ID = '74759e0a-656f-4000-8dfa-59f27d67582f';
  const SUBAGENT = { agent_id: 'a18ab191049154951', agent_type: 'general-purpose' };
  const COMMAND = 'rm -rf "$(cat /tmp/scratchpad/mutdir.txt)" /tmp/scratchpad/mut';
  const incidentHookLines = [
    { hook_event_name: 'SubagentStart', ...SUBAGENT },
    { hook_event_name: 'PreToolUse', ...SUBAGENT, tool_name: 'Bash', tool_input: { command: COMMAND }, tool_use_id: 'toolu_1' },
    { hook_event_name: 'PermissionRequest', ...SUBAGENT, tool_name: 'Bash', tool_input: { command: COMMAND }, permission_suggestions: [] },
    { hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' },
  ].map((line) => JSON.stringify({ session_id: SESSION_ID, cwd: '/tmp', ...line }));

  function parse(lines: string[]): AgentEvent[] {
    return lines.map((line) => {
      const event = parseHookEvent(line);
      if (!event) throw new Error(`unparsed hook line: ${line}`);
      return event;
    });
  }

  // Shape of the incident tasks: spawned by a parent task, no `unattended` flag.
  const incidentTask: PermissionPromptTaskView = {
    id: 'b2f615d1-5453-4fc0-8a11-297cc67ad2d6',
    name: 'Implement kookr issue 3743 merge PR',
    status: 'inProgress',
    sessions: [{ tmuxSession: 'kookr-28245f61' }],
  };

  test('the incident hook sequence yields a blocked task naming the tool and command, then pages', () => {
    const monitor = new Monitor(new TaskStore(), new AttentionQueue());
    monitor.processEvents('kookr-28245f61', parse(incidentHookLines));

    const waits = collectPermissionPromptWaits([incidentTask], monitor);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      taskId: incidentTask.id,
      taskName: incidentTask.name,
      toolName: 'Bash',
      command: COMMAND,
    });

    // The prompt's open time is stable across reads, so the alerter can
    // measure the wait and recognize the same prompt on every tick.
    const again = collectPermissionPromptWaits([incidentTask], monitor);
    expect(again[0].sinceMs).toBe(waits[0].sinceMs);

    const sent: AlertMessage[] = [];
    const alerter = new PermissionPromptWaitAlerter({
      broadcast: (msg) => { sent.push(msg as AlertMessage); },
      now: () => waits[0].sinceMs + 4 * MIN,
    });
    alerter.evaluate(waits);
    expect(states(sent)).toEqual([`fired:${permissionPromptAlertKey(incidentTask.id)}`]);

    // The tool runs once the prompt is answered: PostToolUse clears the block.
    monitor.processEvents('kookr-28245f61', parse([JSON.stringify({
      session_id: SESSION_ID,
      cwd: '/tmp',
      hook_event_name: 'PostToolUse',
      ...SUBAGENT,
      tool_name: 'Bash',
      tool_input: { command: COMMAND },
      tool_use_id: 'toolu_1',
    })]));
    const afterAnswer = collectPermissionPromptWaits([incidentTask], monitor);
    expect(afterAnswer).toEqual([]);
    alerter.evaluate(afterAnswer);
    expect(states(sent)).toEqual([
      `fired:${permissionPromptAlertKey(incidentTask.id)}`,
      `recovered:${permissionPromptAlertKey(incidentTask.id)}`,
    ]);
  });

  function anomaly(agentId: string, type: Anomaly['type'], explanation: string): Anomaly {
    return { agentId, type, severity: 'warning', explanation, detectedAt: new Date(T0) };
  }

  test('skips tasks that are not in progress, sessions with no finding, and other finding types', () => {
    const findings: Record<string, Anomaly> = {
      s1: anomaly('s1', 'permission_blocked', 'Permission request pending for tool: Write'),
      s3: anomaly('s3', 'needs_input', 'Agent is waiting for input. Last message: "done?"'),
      s4: anomaly('s4', 'stale_agent', 'No activity for 30 minutes'),
    };
    const monitor = {
      getCurrentAnomaly: (agentId: string) => findings[agentId] ?? null,
      getAgentEvents: () => [],
    };
    const tasks: PermissionPromptTaskView[] = [
      { id: 'done', status: 'completed', sessions: [{ tmuxSession: 's1' }] },
      { id: 'idle', status: 'inProgress', sessions: [{ tmuxSession: 's2' }] },
      { id: 'asking', status: 'inProgress', sessions: [{ tmuxSession: 's3' }] },
      { id: 'stale', status: 'inProgress', sessions: [{ tmuxSession: 's4' }] },
      { id: 'none', status: 'inProgress', sessions: [] },
      // Only the latest session counts.
      { id: 'resumed', status: 'inProgress', sessions: [{ tmuxSession: 's1' }, { tmuxSession: 's2' }] },
      { id: 'live', status: 'inProgress', sessions: [{ tmuxSession: 's1' }] },
    ];
    // A watchdog-detected block with no permission_request event still pages,
    // with the tool taken from the watchdog's explanation.
    expect(collectPermissionPromptWaits(tasks, monitor)).toEqual([
      { taskId: 'live', sessionId: 's1', toolName: 'Write', command: '', sinceMs: T0 },
    ]);
  });

  test('a pane-detected block does not quote an earlier request that was already answered', () => {
    const events: AgentEvent[] = [
      { type: 'permission_request', sessionId: 's', toolName: 'Bash', toolInput: { command: 'cmdA' } },
      { type: 'tool_result', sessionId: 's', toolName: 'Bash' },
    ];
    const monitor = {
      getCurrentAnomaly: (agentId: string) => anomaly(agentId, 'permission_blocked', 'Pane shows permission dialog: "Do you want to proceed?"'),
      getAgentEvents: () => events,
    };
    const task: PermissionPromptTaskView = { id: 't', status: 'inProgress', sessions: [{ tmuxSession: 's1' }] };
    expect(collectPermissionPromptWaits([task], monitor)).toEqual([
      { taskId: 't', sessionId: 's1', toolName: 'unknown tool', command: '', sinceMs: T0 },
    ]);
  });

  test('quotes the open request, not an older answered one, past trailing notifications', () => {
    const events: AgentEvent[] = [
      { type: 'permission_request', sessionId: 's', toolName: 'Bash', toolInput: { command: 'old command' } },
      { type: 'tool_result', sessionId: 's', toolName: 'Bash' },
      { type: 'permission_request', sessionId: 's', toolName: 'Write', toolInput: { file_path: '/repo/new.ts' } },
      { type: 'notification', sessionId: 's', notificationType: 'permission_prompt', message: 'Claude needs your permission' },
      { type: 'subagent_stop', sessionId: 's', agentId: 'a1', agentType: 'general-purpose', lastMessage: '' },
    ];
    const monitor = {
      getCurrentAnomaly: (agentId: string) => anomaly(agentId, 'permission_blocked', 'Agent is blocked on permission for tool: Write'),
      getAgentEvents: () => events,
    };
    const task: PermissionPromptTaskView = { id: 't', status: 'inProgress', sessions: [{ tmuxSession: 's1' }] };
    expect(collectPermissionPromptWaits([task], monitor)).toEqual([
      { taskId: 't', sessionId: 's1', toolName: 'Write', command: '/repo/new.ts', sinceMs: T0 },
    ]);
  });

  // Issue #3911: a sibling subagent starting after the request ends the hook
  // finding, but the watchdog still holds the request as pending. The page
  // must still quote the command.
  test('a watchdog-held block quotes the command when a sibling subagent starts after the request', () => {
    const SIBLING = { agent_id: 'b29bc302160265062', agent_type: 'Explore' };
    const events = parse([
      ...incidentHookLines,
      JSON.stringify({ session_id: SESSION_ID, cwd: '/tmp', hook_event_name: 'SubagentStart', ...SIBLING }),
    ]);
    const monitor = new Monitor(new TaskStore(), new AttentionQueue());
    const watchdog = new Watchdog();
    watchdog.registerAgent('kookr-28245f61', T0, T0);
    monitor.processEvents('kookr-28245f61', events);
    watchdog.recordEvents('kookr-28245f61', events, T0 + 1_000);
    const verdict = watchdog.tick('kookr-28245f61', '', [], T0 + 5 * MIN);
    monitor.applyWatchdogVerdict('kookr-28245f61', verdict, { paneCaptureSucceeded: true, paneText: '' });
    expect(monitor.getCurrentAnomaly('kookr-28245f61')?.explanation)
      .toBe('Permission request pending for tool: Bash');

    expect(collectPermissionPromptWaits([incidentTask], monitor)).toEqual([{
      taskId: incidentTask.id,
      taskName: incidentTask.name,
      sessionId: 'kookr-28245f61',
      toolName: 'Bash',
      command: COMMAND,
      sinceMs: T0 + 1_000,
    }]);
  });

  test('a finding that names a tool does not quote a request that was answered, or one for another tool', () => {
    const task: PermissionPromptTaskView = { id: 't', status: 'inProgress', sessions: [{ tmuxSession: 's1' }] };
    const withEvents = (explanation: string, events: AgentEvent[]) => ({
      getCurrentAnomaly: (agentId: string) => anomaly(agentId, 'permission_blocked', explanation),
      getAgentEvents: () => events,
    });
    const answered = withEvents('Permission request pending for tool: Bash', [
      { type: 'permission_request', sessionId: 's', toolName: 'Bash', toolInput: { command: 'cmdA' } },
      { type: 'tool_result', sessionId: 's', toolName: 'Bash' },
      { type: 'subagent_start', sessionId: 's', agentId: 'b1', agentType: 'Explore' },
    ]);
    expect(collectPermissionPromptWaits([task], answered)).toEqual([
      { taskId: 't', sessionId: 's1', toolName: 'Bash', command: '', sinceMs: T0 },
    ]);
    const otherTool = withEvents('Permission request pending for tool: Write', [
      { type: 'permission_request', sessionId: 's', toolName: 'Bash', toolInput: { command: 'cmdA' } },
      { type: 'subagent_start', sessionId: 's', agentId: 'b1', agentType: 'Explore' },
    ]);
    expect(collectPermissionPromptWaits([task], otherTool)).toEqual([
      { taskId: 't', sessionId: 's1', toolName: 'Write', command: '', sinceMs: T0 },
    ]);
  });
});

describe('PermissionPromptWaitAlerter with a Telegram card (issue #3925)', () => {
  function cardHarness(offerResult: () => Promise<boolean>) {
    let nowMs = T0;
    const sent: AlertMessage[] = [];
    const offer = vi.fn((_taskId: string, _waitedMs: number) => offerResult());
    const close = vi.fn((_taskId: string) => undefined);
    const alerter = new PermissionPromptWaitAlerter({
      broadcast: (msg) => { sent.push(msg as AlertMessage); },
      now: () => nowMs,
      card: { offer, close },
    });
    return { alerter, sent, offer, close, at(ms: number) { nowMs = T0 + ms; } };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  test('a card in place replaces the page and its clear; the card is closed when the prompt goes', async () => {
    const h = cardHarness(async () => true);
    for (let ms = 0; ms <= 6 * MIN; ms += 30_000) { h.at(ms); h.alerter.evaluate([wait()]); }
    await flush();
    expect(h.offer).toHaveBeenCalledTimes(1);
    expect(h.offer).toHaveBeenCalledWith('task-1', 3 * MIN);
    expect(h.sent).toHaveLength(0);
    h.alerter.evaluate([]);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledWith('task-1');
    expect(h.sent).toHaveLength(0);
  });

  test('the page still fires, and clears, when the card is not in place', async () => {
    const h = cardHarness(async () => false);
    h.at(3 * MIN);
    h.alerter.evaluate([wait()]);
    await flush();
    expect(states(h.sent)).toEqual([`fired:${permissionPromptAlertKey('task-1')}`]);
    h.alerter.evaluate([]);
    expect(states(h.sent)).toEqual([
      `fired:${permissionPromptAlertKey('task-1')}`,
      `recovered:${permissionPromptAlertKey('task-1')}`,
    ]);
  });

  test('a rejected offer falls back to the page', async () => {
    const h = cardHarness(async () => { throw new Error('boom'); });
    h.at(3 * MIN);
    h.alerter.evaluate([wait()]);
    await flush();
    expect(states(h.sent)).toEqual([`fired:${permissionPromptAlertKey('task-1')}`]);
  });

  test('a prompt answered while its card was being sent gets no late page', async () => {
    let resolveOffer: (v: boolean) => void = () => undefined;
    const h = cardHarness(() => new Promise<boolean>((r) => { resolveOffer = r; }));
    h.at(3 * MIN);
    h.alerter.evaluate([wait()]);
    h.alerter.evaluate([]);
    expect(h.close).toHaveBeenCalledTimes(1);
    resolveOffer(false);
    await flush();
    expect(h.sent).toHaveLength(0);
  });
});
