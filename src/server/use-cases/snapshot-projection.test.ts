import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonitorAgentState } from '../../core/monitor.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { TaskStore } from '../../core/tasks.js';
import { buildSnapshotProjection } from './snapshot-projection.js';
import { getHotPathSampler, resetHotPathSamplerForTests } from '../../core/hot-path-sampler.js';
import { PREAUTHORIZED_DELIVERY_GATE_SENTENCE } from '../worktree-guardrails.js';

// Count displayPromptForTask invocations while preserving real behavior so we
// can assert it is not recomputed per-session on the hot rebuild path (#2125).
const promptDisplaySpy = vi.hoisted(() => ({ taskIds: [] as (string | undefined)[] }));
vi.mock('../../core/prompt-display.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/prompt-display.js')>();
  return {
    ...actual,
    displayPromptForTask: (task: Parameters<typeof actual.displayPromptForTask>[0]) => {
      promptDisplaySpy.taskIds.push((task as { id?: string }).id);
      return actual.displayPromptForTask(task);
    },
  };
});

// Same counting-wrapper for projectDisplayLabel so the terminal-skip test can
// assert the per-session compute is actually skipped (not just displayPrompt).
const projectLabelSpy = vi.hoisted(() => ({ projectIds: [] as (string | undefined)[] }));
vi.mock('../../core/project-identity.js', async (importActual) => {
  const actual = await importActual<typeof import('../../core/project-identity.js')>();
  return {
    ...actual,
    projectDisplayLabel: (args: Parameters<typeof actual.projectDisplayLabel>[0]) => {
      projectLabelSpy.projectIds.push(args.projectId);
      return actual.projectDisplayLabel(args);
    },
  };
});

function createTaskForMutation(targetStore: TaskStore, ...args: unknown[]) {
  const created = (targetStore.createTask as (...innerArgs: unknown[]) => { id: string })(...args);
  const task = targetStore.getTaskForMutation(created.id);
  if (!task) throw new Error(`missing task ${created.id}`);
  return task;
}

function guardedWorktreePrompt(userPrompt: string, delivery: 'ask-first' | 'pre-authorized' = 'ask-first'): string {
  const gate = delivery === 'pre-authorized'
    ? PREAUTHORIZED_DELIVERY_GATE_SENTENCE
    : "After committing, don't end your turn silently - unless the task already told you to deliver, ask the user whether to push the branch and open a PR.";
  return [
    'You are currently in the main checkout `/repo` on branch `main`. Do NOT commit to main or in this checkout - every Kookr task must make tracked-file changes in a fresh git worktree of its own, not in any pre-existing checkout (the main repo, the production runtime worktree, or any sibling worktree spawned for unrelated work).',
    '- Create one: `git worktree add ../repo-<short-name> -b <feature-branch> HEAD`',
    '- Perform all tracked-file edits, commits, and pushes from that new worktree.',
    '- If the task stays read-only, you may remain in the current checkout.',
    `- ${gate}`,
    '',
    userPrompt,
  ].join('\n');
}

function project(taskStore: TaskStore, monitorStates: MonitorAgentState[] = []): AgentState[] {
  return buildSnapshotProjection({
    monitorStates,
    tasks: taskStore.getAllTasks(),
  });
}

function liveAgent(agentId: string, overrides: Partial<MonitorAgentState> = {}): MonitorAgentState {
  return {
    agentId,
    events: [],
    anomaly: null,
    lastEventSeq: 0,
    ...overrides,
  };
}

function stopEvent(lastMessage = 'Done.', eventSeq = 2) {
  return { type: 'stop' as const, sessionId: 's1', lastMessage, eventSeq };
}

function needsInput(agentId: string, explanation = 'Waiting') {
  return {
    agentId,
    type: 'needs_input' as const,
    severity: 'info' as const,
    explanation,
    detectedAt: new Date('2026-05-24T10:00:00Z'),
  };
}

describe('snapshot projection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records snapshot_rebuild into the hot-path sampler on each build (issue #1781)', () => {
    resetHotPathSamplerForTests();
    try {
      const taskStore = new TaskStore();
      createTaskForMutation(taskStore, 'Fix auth', '/cwd');
      project(taskStore);
      project(taskStore);
      const entry = getHotPathSampler()
        .snapshot()
        .windows[0].paths.find((p) => p.label === 'snapshot_rebuild');
      expect(entry).toBeDefined();
      expect(entry?.count).toBe(2);
    } finally {
      resetHotPathSamplerForTests();
    }
  });

  it('suppresses a ghost monitor state whose id is in suppressSessionIds but has no owning task (issue #2408)', () => {
    // A terminal task owning this live session was dropped from the bounded
    // clone set (`tasks` omits it), so there is no session-index entry. Without
    // the guard the raw monitor state leaks as an unattributed agent card.
    const taskStore = new TaskStore();
    const states = buildSnapshotProjection({
      monitorStates: [liveAgent('kookr-ghost')],
      tasks: taskStore.getAllTasks(),
      suppressSessionIds: new Set(['kookr-ghost']),
    });
    expect(states.find((s) => s.agentId === 'kookr-ghost')).toBeUndefined();
    expect(states.filter((s) => !s.taskId)).toEqual([]);
  });

  it('still surfaces an orphan monitor state whose id is NOT in suppressSessionIds (issue #2408)', () => {
    // Only terminal-owned dropped sessions are suppressed; an unowned orphan
    // (e.g. a live session with no store task yet) surfaces as before.
    const taskStore = new TaskStore();
    const states = buildSnapshotProjection({
      monitorStates: [liveAgent('kookr-orphan')],
      tasks: taskStore.getAllTasks(),
      suppressSessionIds: new Set(['kookr-ghost']),
    });
    expect(states.find((s) => s.agentId === 'kookr-orphan')).toBeDefined();
  });

  it('enriches live monitor state with linked task metadata without mutating the raw state', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Fix auth token refresh in the login flow', '/workspace/webapp');
    taskStore.setProjectId(task.id, 'github.com/acme/webapp');
    taskStore.setTaskPriority(task.id, 'high');
    const sessionCreatedAt = new Date('2026-03-24T10:00:00Z');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/workspace/webapp',
      createdAt: sessionCreatedAt,
    });
    const rawState = liveAgent('agent-1', {
      events: [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }],
      lastEventSeq: 1,
    });

    const [projected] = project(taskStore, [rawState]);

    expect(projected).toMatchObject({
      agentId: 'agent-1',
      taskId: task.id,
      taskName: 'Fix auth token refresh in the login flow',
      taskStatus: 'inProgress',
      cwd: '/workspace/webapp',
      agentType: 'claude-code',
      startedAt: sessionCreatedAt.toISOString(),
      projectId: 'github.com/acme/webapp',
      projectDisplayLabel: 'webapp',
      priority: 'high',
      lastEventSeq: 1,
    });
    expect(rawState).not.toHaveProperty('taskId');
  });

  it('projects latestCompletionSignal for an in-progress completed turn', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Review completed work', '/workspace/app');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-complete-turn',
      agentType: 'codex-cli',
      cwd: '/workspace/app',
      createdAt: new Date(),
    });
    const rawState = liveAgent('agent-complete-turn', {
      turnState: 'completed_turn',
      events: [
        { type: 'user_prompt', sessionId: 's1', prompt: 'please implement', eventSeq: 1 },
        stopEvent('Implemented the requested change.', 2),
      ],
    });

    const [projected] = project(taskStore, [rawState]);

    expect(projected.latestCompletionSignal?.id).toHaveLength(16);
    expect(rawState.latestCompletionSignal).toBeUndefined();
  });

  it('does not project latestCompletionSignal for terminal tasks', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Already completed task', '/workspace/app');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-terminal',
      agentType: 'codex-cli',
      cwd: '/workspace/app',
      createdAt: new Date(),
    });
    taskStore.completeTask(task.id);

    const snapshot = project(taskStore, [liveAgent('agent-terminal', {
      turnState: 'completed_turn',
      events: [stopEvent('Done.', 1)],
    })]);

    expect(snapshot.find((state) => state.taskId === task.id)?.latestCompletionSignal).toBeUndefined();
  });

  it('uses the task name, else the full single-line prompt (client truncates) for live labels', () => {
    const taskStore = new TaskStore();
    const named = createTaskForMutation(taskStore, 'Fix auth token refresh in the login flow', '/cwd');
    taskStore.renameTask(named.id, 'Auth fix');
    taskStore.addSession(named.id, {
      tmuxSession: 'agent-named',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    // A realistic long prompt (~130 chars) is now sent in full, single-line and
    // WITHOUT a baked "..." — the card truncates to the available width, so the
    // visible ellipsis is CSS-driven and grows/shrinks as the panel resizes.
    const longPrompt = 'Refactor the authentication middleware to support OAuth2 with PKCE flow and add comprehensive integration tests for all edge cases';
    const long = createTaskForMutation(taskStore, longPrompt, '/cwd');
    taskStore.addSession(long.id, {
      tmuxSession: 'agent-long',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    // Only a pathologically long prompt is capped — a payload safety valve, not
    // a display choice — collapsed to one line with a single-char ellipsis.
    const hugePrompt = `Implement the feature end to end.\n${'detail '.repeat(80)}`;
    const huge = createTaskForMutation(taskStore, hugePrompt, '/cwd');
    taskStore.addSession(huge.id, {
      tmuxSession: 'agent-huge',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    // This test exercises the projection's `promptTitle` fallback, which now
    // only applies to legacy tasks with no name — tasks are named from birth
    // (issue #1554) and named tasks short-circuit the fallback. Clear the
    // creation-time placeholder to reach the fallback path.
    for (const id of [long.id, huge.id]) {
      const stored = taskStore.getTaskForMutation(id)!;
      delete stored.name;
      delete stored.autoNamed;
    }

    const snapshot = project(taskStore, [liveAgent('agent-named'), liveAgent('agent-long'), liveAgent('agent-huge')]);

    expect(snapshot.find((state) => state.agentId === 'agent-named')?.taskName).toBe('Auth fix');

    const longName = snapshot.find((state) => state.agentId === 'agent-long')?.taskName;
    expect(longName).toBe(longPrompt);
    expect(longName).not.toMatch(/\.\.\.$/);

    const hugeName = snapshot.find((state) => state.agentId === 'agent-huge')?.taskName;
    expect(hugeName).not.toContain('\n');
    expect(hugeName!.length).toBeLessThanOrEqual(201);
    expect(hugeName!.endsWith('…')).toBe(true);
  });

  it('strips launch guardrail preambles from live, pending, and terminal task descriptions', () => {
    const taskStore = new TaskStore();
    const live = createTaskForMutation(taskStore, {
      prompt: guardedWorktreePrompt('Fix duplicate task prompt in activity panel.'),
      userPrompt: 'Fix duplicate task prompt in activity panel.',
      cwd: '/repo',
    });
    taskStore.addSession(live.id, {
      tmuxSession: 'agent-live',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00Z'),
    });
    const pending = createTaskForMutation(taskStore, {
      prompt: guardedWorktreePrompt('Prepare the release checklist.'),
      userPrompt: 'Prepare the release checklist.',
      cwd: '/workspace/app',
    });
    taskStore.pendTask(pending.id);
    const done = createTaskForMutation(taskStore, {
      prompt: guardedWorktreePrompt('Archive completed evidence.'),
      cwd: '/workspace/app',
    });
    taskStore.addSession(done.id, {
      tmuxSession: 'agent-done',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-03-30T12:00:00Z'),
    });
    taskStore.completeTask(done.id);
    const preAuthorized = createTaskForMutation(taskStore, {
      prompt: guardedWorktreePrompt('Open the implementation PR.', 'pre-authorized'),
      cwd: '/workspace/app',
    });
    taskStore.addSession(preAuthorized.id, {
      tmuxSession: 'agent-preauth',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-03-30T12:00:00Z'),
    });
    taskStore.completeTask(preAuthorized.id);

    const snapshot = project(taskStore, [liveAgent('agent-live')]);

    expect(snapshot.find((state) => state.agentId === 'agent-live')).toMatchObject({
      taskName: 'Fix duplicate task prompt in activity panel.',
      description: 'Fix duplicate task prompt in activity panel.',
    });
    expect(snapshot.find((state) => state.agentId === `pending-${pending.id}`)).toMatchObject({
      taskName: 'Prepare the release checklist.',
      description: 'Prepare the release checklist.',
    });
    expect(snapshot.find((state) => state.taskId === done.id)).toMatchObject({
      taskName: 'Archive completed evidence.',
      description: 'Archive completed evidence.',
    });
    expect(snapshot.find((state) => state.taskId === preAuthorized.id)).toMatchObject({
      taskName: 'Open the implementation PR.',
      description: 'Open the implementation PR.',
    });
  });

  it('projects exact playbook configuration for live, pending, and terminal tasks', () => {
    const taskStore = new TaskStore();
    const playbookSource = {
      id: 'analyze.md',
      scope: 'user' as const,
      sourceCwd: '/user/playbooks',
      sourceDigest: 'sha256:original',
    };
    const playbookParameterValues = { repo: 'owner/repo', count: '10' };
    const createPlaybookTask = (prompt: string) => createTaskForMutation(taskStore, {
      prompt,
      cwd: '/workspace/app',
      playbookId: 'analyze.md',
      playbookSource,
      playbookParameterValues,
    });
    const live = createPlaybookTask('Live analysis');
    taskStore.addSession(live.id, {
      tmuxSession: 'agent-playbook-live',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-08-01T10:00:00Z'),
    });
    const pending = createPlaybookTask('Pending analysis');
    taskStore.pendTask(pending.id);
    const terminal = createPlaybookTask('Completed analysis');
    taskStore.addSession(terminal.id, {
      tmuxSession: 'agent-playbook-terminal',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-08-01T09:00:00Z'),
    });
    taskStore.completeTask(terminal.id);

    const snapshot = project(taskStore, [liveAgent('agent-playbook-live')]);
    const entries = [
      snapshot.find((state) => state.taskId === live.id),
      snapshot.find((state) => state.taskId === pending.id),
      snapshot.find((state) => state.taskId === terminal.id),
    ];

    for (const entry of entries) {
      expect(entry).toMatchObject({
        playbookId: 'analyze.md',
        playbookSource,
        playbookParameterValues,
      });
    }
    expect(entries.map((entry) => entry?.taskStatus)).toEqual([
      'inProgress',
      'pending',
      'completed',
    ]);
  });

  it('creates synthetic entries for pending tasks', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, {
      prompt: 'Analyze owner/repo',
      cwd: '/workspace/app',
      playbookSource: {
        id: 'analyze.md',
        scope: 'user',
        sourceCwd: '/user/playbooks',
        sourceDigest: 'sha256:original',
      },
      playbookParameterValues: { repo: 'owner/repo', count: '10' },
    });
    task.playbookId = 'analyze.md';
    taskStore.setTaskPriority(task.id, 'high');
    taskStore.pendTask(task.id);

    const entry = project(taskStore).find((state) => state.agentId === `pending-${task.id}`);

    expect(entry).toMatchObject({
      taskId: task.id,
      taskName: 'Analyze owner/repo',
      taskStatus: 'pending',
      events: [],
      anomaly: null,
      lastEventSeq: 0,
      cwd: '/workspace/app',
      priority: 'high',
      playbookId: 'analyze.md',
      playbookSource: {
        id: 'analyze.md',
        scope: 'user',
        sourceCwd: '/user/playbooks',
        sourceDigest: 'sha256:original',
      },
      playbookParameterValues: { repo: 'owner/repo', count: '10' },
    });
  });

  // issue #1562: the unattended + operator-needed flags must cross the
  // store→AgentState projection so the dashboard/tasks API can render the block.
  it('projects unattended + operatorNeeded onto live and pending entries', () => {
    const taskStore = new TaskStore();
    const live = createTaskForMutation(taskStore, {
      prompt: 'Autonomous work',
      cwd: '/workspace/app',
      unattended: true,
    });
    taskStore.addSession(live.id, {
      tmuxSession: 'agent-unattended',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-07-28T10:00:00Z'),
    });
    taskStore.setOperatorNeeded(live.id, {
      reason: 'interactive_tool_denied',
      toolName: 'AskUserQuestion',
      detectedAt: new Date('2026-07-28T10:05:00Z'),
      message: 'blocked',
    });

    const pending = createTaskForMutation(taskStore, {
      prompt: 'Pending autonomous work',
      cwd: '/workspace/app',
      unattended: true,
    });
    taskStore.pendTask(pending.id);

    const snapshot = project(taskStore, [liveAgent('agent-unattended')]);

    const liveEntry = snapshot.find((s) => s.agentId === 'agent-unattended');
    expect(liveEntry?.unattended).toBe(true);
    expect(liveEntry?.operatorNeeded).toMatchObject({
      reason: 'interactive_tool_denied',
      toolName: 'AskUserQuestion',
    });

    const pendingEntry = snapshot.find((s) => s.agentId === `pending-${pending.id}`);
    expect(pendingEntry?.unattended).toBe(true);
    expect(pendingEntry?.operatorNeeded).toBeUndefined();
  });

  it('projects reapOutcome from a delivered_then_hung disposition, and omits it for a plain terminate (issue #1559)', () => {
    const taskStore = new TaskStore();

    const delivered = createTaskForMutation(taskStore, { prompt: 'Delivered then hung', cwd: '/workspace/app' });
    taskStore.addSession(delivered.id, {
      tmuxSession: 'agent-delivered',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-07-25T17:43:00Z'),
    });
    taskStore.terminateTask(delivered.id);
    taskStore.setDisposition(delivered.id, {
      reason: 'hung_reap',
      at: '2026-07-25T21:13:18.000Z',
      source: 'hung-task-reaper',
      outcome: 'delivered_then_hung',
      deliveredPr: { number: 1542, url: 'https://github.com/kookr-ai/kookr/pull/1542' },
    });

    const plain = createTaskForMutation(taskStore, { prompt: 'Plain hung reap', cwd: '/workspace/app' });
    taskStore.addSession(plain.id, {
      tmuxSession: 'agent-plain',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-07-25T17:43:00Z'),
    });
    taskStore.terminateTask(plain.id);
    taskStore.setDisposition(plain.id, {
      reason: 'hung_reap',
      at: '2026-07-25T21:13:18.000Z',
      source: 'hung-task-reaper',
      outcome: 'terminated',
    });

    const snapshot = project(taskStore);

    // The delivered-then-hung reap surfaces the outcome the dashboard reads.
    const deliveredEntry = snapshot.find((s) => s.taskId === delivered.id);
    expect(deliveredEntry?.taskStatus).toBe('terminated');
    expect(deliveredEntry?.reapOutcome).toBe('delivered_then_hung');

    // A plain terminate carries outcome `terminated` — no distinct dashboard badge.
    const plainEntry = snapshot.find((s) => s.taskId === plain.id);
    expect(plainEntry?.taskStatus).toBe('terminated');
    expect(plainEntry?.reapOutcome).toBe('terminated');
  });

  it('replaces terminal live sessions with clean synthetic terminal entries', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Run database migration', '/workspace/app');
    taskStore.setTaskPriority(task.id, 'high');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-c1',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-03-30T12:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.updateTokenUsage(task.id, {
      inputTokens: 1500,
      outputTokens: 800,
      cacheRead: 200,
      cacheWrite: 50,
      costUsd: 0.042,
    });
    taskStore.completeTask(task.id);
    const rawAnomaly = {
      agentId: 'agent-c1',
      type: 'needs_input' as const,
      severity: 'info' as const,
      explanation: 'stale terminal wait',
      detectedAt: new Date('2026-03-30T12:05:00Z'),
    };

    const snapshot = project(taskStore, [liveAgent('agent-c1', { anomaly: rawAnomaly })]);
    const entry = snapshot.find((state) => state.taskId === task.id);

    expect(snapshot.filter((state) => state.agentId === 'agent-c1')).toHaveLength(1);
    expect(entry).toMatchObject({
      agentId: 'agent-c1',
      taskStatus: 'completed',
      priority: 'high',
      events: [],
      anomaly: null,
      taskName: 'Run database migration',
      cwd: '/workspace/app',
      tokenUsage: {
        inputTokens: 1500,
        outputTokens: 800,
        cacheRead: 200,
        cacheWrite: 50,
        costUsd: 0.042,
      },
    });
  });

  it('projects a stable terminal finishedAt timestamp after later task edits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Ship completed row timestamps', '/workspace/app');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-finished',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-06-20T09:00:00.000Z'),
    });

    taskStore.completeTask(task.id);
    vi.setSystemTime(new Date('2026-06-20T11:00:00.000Z'));
    taskStore.renameTask(task.id, 'Renamed after completion');

    const entry = project(taskStore).find((state) => state.taskId === task.id);

    expect(entry).toMatchObject({
      taskName: 'Renamed after completion',
      taskStatus: 'completed',
      finishedAt: '2026-06-20T10:00:00.000Z',
    });
  });

  it('normalizes terminal worktree health and handles terminal tasks without sessions', () => {
    const taskStore = new TaskStore();
    const completed = createTaskForMutation(taskStore, 'Ship implementation PR', '/workspace/app');
    taskStore.addSession(completed.id, {
      tmuxSession: 'agent-cleaned',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date(),
      worktreeHealth: 'missing',
    });
    taskStore.completeTask(completed.id);

    const cancelled = createTaskForMutation(taskStore, 'Build docker image', '/workspace/app');
    taskStore.startTask(cancelled.id);
    taskStore.cancelTask(cancelled.id);

    const snapshot = project(taskStore);

    expect(snapshot.find((state) => state.taskId === completed.id)).toMatchObject({
      taskStatus: 'completed',
      worktreeHealth: 'cleaned_up',
    });
    expect(snapshot.find((state) => state.taskId === cancelled.id)).toMatchObject({
      agentId: `done-${cancelled.id}`,
      taskStatus: 'cancelled',
    });
  });

  it('does not duplicate an active task that already has a live monitor state', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Fix login bug', '/workspace/app');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-d1',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date(),
    });

    const entries = project(taskStore, [liveAgent('agent-d1')]).filter((state) => state.taskId === task.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].agentId).toBe('agent-d1');
  });

  it('suppresses the synthetic terminal entry when a task id is already present in states (issue #2514)', () => {
    // Equivalence pin for the O(1) `presentTaskIds` Set that replaced the former
    // O(n²) `states.some((s) => s.taskId === task.id)` terminal-dedup scan
    // (PR #2310): when a task's id is already represented in `states`, the
    // terminal pass must not append a second synthetic entry for it.
    //
    // The input is deliberately synthetic. Real callers source `monitorStates`
    // from `Monitor.getSnapshot()`/`getAgentState()`, whose states never carry a
    // pre-set `taskId` — projection assigns `taskId` only via `enrichLiveState`,
    // which is skipped for terminal tasks by the terminal-status `continue`
    // above. So a raw state that both carries a terminal task's id AND is
    // retained (its agentId matches no session, so it is not enriched or
    // skipped) is the one shape that drives `presentTaskIds.has(task.id) === true`
    // for a terminal candidate. This pins the Set's behavioral equivalence with
    // the old scan directly; it is not reproducing a live dashboard duplication.
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Deploy release', '/workspace/app');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-terminal-session',
      agentType: 'claude-code',
      cwd: '/workspace/app',
      createdAt: new Date('2026-03-30T12:00:00Z'),
    });
    taskStore.completeTask(task.id);

    const snapshot = project(taskStore, [liveAgent('external-agent', { taskId: task.id })]);
    const entries = snapshot.filter((state) => state.taskId === task.id);

    expect(entries).toHaveLength(1);
    expect(entries[0].agentId).toBe('external-agent');
    // Without the dedup, `buildTerminalTaskEntry` would append a second entry
    // whose agentId is the terminal session id.
    expect(snapshot.some((state) => state.agentId === 'agent-terminal-session')).toBe(false);
    // No duplicate row of any kind was appended for this task.
    expect(snapshot).toHaveLength(1);
  });

  it('links descendant findings to a likely root cause finding', () => {
    const taskStore = new TaskStore();
    const parent = createTaskForMutation(taskStore, { prompt: 'Coordinate release', cwd: '/repo' });
    const childA = createTaskForMutation(taskStore, { prompt: 'Implement frontend', cwd: '/repo', parentTaskId: parent.id });
    const childB = createTaskForMutation(taskStore, { prompt: 'Implement backend', cwd: '/repo', parentTaskId: parent.id });
    taskStore.addSession(parent.id, {
      tmuxSession: 'agent-parent',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00Z'),
    });
    taskStore.addSession(childA.id, {
      tmuxSession: 'agent-child-a',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:01:00Z'),
    });
    taskStore.addSession(childB.id, {
      tmuxSession: 'agent-child-b',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:02:00Z'),
    });

    const snapshot = project(taskStore, [
      liveAgent('agent-parent', { anomaly: needsInput('agent-parent', 'Waiting on child decisions') }),
      liveAgent('agent-child-a', { anomaly: needsInput('agent-child-a', 'Need parent direction') }),
      liveAgent('agent-child-b', { anomaly: needsInput('agent-child-b', 'Need parent direction') }),
    ]);
    const root = snapshot.find((state) => state.agentId === 'agent-parent')!.anomaly!;
    const childAFinding = snapshot.find((state) => state.agentId === 'agent-child-a')!.anomaly!;
    const childBFinding = snapshot.find((state) => state.agentId === 'agent-child-b')!.anomaly!;

    expect(root.likelyRootCause).toBe(true);
    expect(root.relatedFindingIds).toEqual(['agent-child-a', 'agent-child-b']);
    expect(root.causalityReason).toContain(parent.id);
    expect(childAFinding.rootCauseFindingId).toBe('agent-parent');
    expect(childBFinding.rootCauseFindingId).toBe('agent-parent');
    expect(childAFinding.causalityReason).toContain('agent-parent');
  });

  it('picks the highest-priority anomalous ancestor as root cause', () => {
    const taskStore = new TaskStore();
    const grandparent = createTaskForMutation(taskStore, { prompt: 'Coordinate launch', cwd: '/repo' });
    const parent = createTaskForMutation(taskStore, { prompt: 'Implement API', cwd: '/repo', parentTaskId: grandparent.id });
    const child = createTaskForMutation(taskStore, { prompt: 'Implement endpoint', cwd: '/repo', parentTaskId: parent.id });
    taskStore.addSession(grandparent.id, {
      tmuxSession: 'agent-grandparent',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:00:00Z'),
    });
    taskStore.addSession(parent.id, {
      tmuxSession: 'agent-parent',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:01:00Z'),
    });
    taskStore.addSession(child.id, {
      tmuxSession: 'agent-child',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-24T10:02:00Z'),
    });
    const criticalGrandparent = {
      agentId: 'agent-grandparent',
      type: 'repeated_error' as const,
      severity: 'critical' as const,
      explanation: 'Same error repeated: launch command fails',
      detectedAt: new Date('2026-05-24T10:00:00Z'),
    };

    const snapshot = project(taskStore, [
      liveAgent('agent-grandparent', { anomaly: criticalGrandparent }),
      liveAgent('agent-parent', { anomaly: needsInput('agent-parent', 'Need launch direction') }),
      liveAgent('agent-child', { anomaly: needsInput('agent-child', 'Need API direction') }),
    ]);
    const root = snapshot.find((state) => state.agentId === 'agent-grandparent')!.anomaly!;
    const parentFinding = snapshot.find((state) => state.agentId === 'agent-parent')!.anomaly!;
    const childFinding = snapshot.find((state) => state.agentId === 'agent-child')!.anomaly!;

    expect(root.likelyRootCause).toBe(true);
    expect(root.relatedFindingIds).toEqual(['agent-child', 'agent-parent']);
    expect(parentFinding.likelyRootCause).toBeUndefined();
    expect(parentFinding.rootCauseFindingId).toBe('agent-grandparent');
    expect(childFinding.rootCauseFindingId).toBe('agent-grandparent');
  });

  it('hides completed Ralph iteration sessions while keeping the live owner visible', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, { prompt: 'loop', cwd: '/repo' });
    task.ralphLoop = {
      prompt: 'again',
      iterationCap: 5,
      currentIteration: 2,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 2,
      ownerSessionId: 'agent-live',
    };
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-old',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-08T10:00:00Z'),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-live',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-08T10:05:00Z'),
    });

    const snapshot = project(taskStore, [liveAgent('agent-old'), liveAgent('agent-live')]);

    expect(snapshot.some((state) => state.agentId === 'agent-old')).toBe(false);
    const live = snapshot.find((state) => state.agentId === 'agent-live');
    expect(live).toMatchObject({
      taskId: task.id,
      anomaly: null,
      taskStatus: 'inProgress',
      ralphLoop: { ownerSessionId: 'agent-live' },
    });
  });

  it('evaluates displayPromptForTask at most once per task for a multi-session live task', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Multi-session live task', '/workspace/app');
    for (const tmuxSession of ['live-a', 'live-b', 'live-c']) {
      taskStore.addSession(task.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: '/workspace/app',
        createdAt: new Date(),
      });
    }

    promptDisplaySpy.taskIds.length = 0;
    project(taskStore, [liveAgent('live-a'), liveAgent('live-b'), liveAgent('live-c')]);

    // Hoisted + memoized: one compute for the task even across three sessions.
    expect(promptDisplaySpy.taskIds.filter((id) => id === task.id)).toHaveLength(1);
  });

  it('skips per-session displayPrompt/projectDisplayLabel compute for terminal-task sessions', () => {
    const taskStore = new TaskStore();
    const task = createTaskForMutation(taskStore, 'Completed multi-session task', '/workspace/app');
    taskStore.setProjectId(task.id, 'github.com/acme/webapp');
    for (const tmuxSession of ['done-a', 'done-b', 'done-c']) {
      taskStore.addSession(task.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: '/workspace/app',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
    }
    taskStore.completeTask(task.id);

    promptDisplaySpy.taskIds.length = 0;
    projectLabelSpy.projectIds.length = 0;
    const snapshot = project(taskStore, [
      liveAgent('done-a'),
      liveAgent('done-b'),
      liveAgent('done-c'),
    ]);

    // sessionIndex loop skips both computes for all three terminal sessions; the
    // only remaining call to each is the single synthetic terminal entry.
    expect(promptDisplaySpy.taskIds.filter((id) => id === task.id)).toHaveLength(1);
    expect(projectLabelSpy.projectIds.filter((id) => id === 'github.com/acme/webapp')).toHaveLength(1);
    // The retained synthetic terminal entry still carries the real fields.
    const entry = snapshot.find((state) => state.taskId === task.id);
    expect(entry).toMatchObject({
      taskStatus: 'completed',
      taskName: 'Completed multi-session task',
      projectDisplayLabel: 'webapp',
    });
  });
});
