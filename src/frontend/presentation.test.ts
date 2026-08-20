import { describe, test, expect, vi } from 'vitest';
import { agentProviderPresentation, anomalyTypeLabel, cacheHitRatio, deriveTaskNextStepRecommendations, findingTypeLabel, findingWaitStartedAt, formatAge, formatCacheHit, formatCostRate, formatDuration, formatOldestFindingWait, healthyCurrentToolLabel, healthyDotClass, healthyStatusLabel, oldestFindingWaitStartedAt, projectLabel, projectColor, taskStatusLabel, turnStateLabel, turnStateClass, worktreeHealthLabel, worktreeHealthTitle } from './presentation.js';
import type { AgentEvent, AgentState, GitHubPRState, TokenUsage } from '../shared/protocol.js';

function makeCompletedAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Ship issue',
    events: [],
    anomaly: null,
    cwd: '/tmp/kookr',
    taskStatus: 'completed',
    ...overrides,
  };
}

function makePr(overrides: Partial<GitHubPRState> = {}): GitHubPRState {
  const prNumber = 1151;
  return {
    ref: {
      type: 'pr',
      owner: 'kookr-ai',
      repo: 'kookr',
      number: prNumber,
      url: `https://github.com/kookr-ai/kookr/pull/${prNumber}`,
      detectedAt: new Date('2026-06-27T10:00:00.000Z'),
      detectedFrom: 'test',
      taskId: 'task-1',
    },
    title: 'Show next actions',
    status: 'merged',
    author: 'jeanibarz',
    branch: 'feat/next-actions',
    baseBranch: 'main',
    reviewDecision: 'approved',
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-06-27T10:05:00.000Z'),
    ...overrides,
  };
}

describe('healthyDotClass', () => {
  test('returns "running" for agent with no events', () => {
    expect(healthyDotClass([])).toBe('running');
  });

  test('returns "running" for agent whose last event is tool_use', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t.jsonl' },
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    expect(healthyDotClass(events)).toBe('running');
  });

  test('returns "done" for agent whose last event is stop', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t.jsonl' },
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } },
      { type: 'stop', sessionId: 's1', lastMessage: 'All done!' },
    ];
    expect(healthyDotClass(events)).toBe('done');
  });
});

describe('finding wait age', () => {
  test('formats day-old waits compactly', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T18:57:00Z'));

    expect(formatAge('2026-06-07T22:47:00Z')).toBe('3d');

    vi.useRealTimers();
  });

  test('uses pendingSignal.raisedAt instead of re-stamped anomaly.detectedAt', () => {
    const agent = {
      agentId: 'agent-1',
      events: [],
      turnState: 'completed_turn',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: '2026-06-07T22:47:00Z',
      },
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'warning',
        explanation: 'Agent is waiting for review.',
        detectedAt: new Date('2026-06-11T18:49:00Z'),
      },
    } satisfies AgentState;

    expect(findingWaitStartedAt(agent)).toBe('2026-06-07T22:47:00Z');
  });

  test('picks the earliest wait among several findings', () => {
    const newer = {
      agentId: 'newer',
      events: [],
      anomaly: {
        agentId: 'newer',
        type: 'needs_input',
        severity: 'warning',
        explanation: 'newer wait',
        detectedAt: new Date('2026-06-11T18:50:00Z'),
      },
    } satisfies AgentState;
    const older = {
      agentId: 'older',
      events: [],
      turnState: 'completed_turn',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: '2026-06-11T18:10:00Z',
      },
      anomaly: {
        agentId: 'older',
        type: 'needs_input',
        severity: 'warning',
        explanation: 'older wait',
        detectedAt: new Date('2026-06-11T18:49:00Z'),
      },
    } satisfies AgentState;

    expect(oldestFindingWaitStartedAt([newer, older])).toBe('2026-06-11T18:10:00Z');
    expect(oldestFindingWaitStartedAt([])).toBeUndefined();
  });

  test('formats a live oldest wait and keeps sub-two-minute findings visible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T18:57:00Z'));

    expect(formatOldestFindingWait('2026-06-11T18:45:00Z')).toBe('12m');
    expect(formatOldestFindingWait('2026-06-11T18:56:00Z')).toBe('<2m');
    expect(formatOldestFindingWait(undefined)).toBeNull();
    expect(formatOldestFindingWait('not-a-date')).toBeNull();
    expect(formatOldestFindingWait('2026-06-11T19:00:00Z')).toBeNull();

    vi.useRealTimers();
  });
});

describe('agentProviderPresentation', () => {
  test('labels Claude Code as an Anthropic-backed agent', () => {
    expect(agentProviderPresentation('claude-code')).toMatchObject({
      label: 'Claude Code',
      provider: 'Anthropic',
    });
    expect(agentProviderPresentation('claude-code').iconPath).toMatch(/^M.+Z$/);
  });

  test('labels Codex CLI as an OpenAI-backed agent', () => {
    expect(agentProviderPresentation('codex-cli')).toMatchObject({
      label: 'Codex CLI',
      provider: 'OpenAI',
    });
    expect(agentProviderPresentation('codex-cli').iconPath).toMatch(/^M.+Z$/);
  });

  test('labels Grok Build as an xAI-backed agent with the product mark', () => {
    expect(agentProviderPresentation('grok-build')).toMatchObject({
      label: 'Grok Build',
      provider: 'xAI',
    });
    expect(agentProviderPresentation('grok-build').iconPath).toMatch(/^M.+Z$/);
    // Not the old placeholder X glyph
    expect(agentProviderPresentation('grok-build').iconPath).not.toContain('M3 3h3l6 8');
  });
});

describe('healthyStatusLabel', () => {
  test('returns "done" when last event is stop', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } },
      { type: 'stop', sessionId: 's1', lastMessage: 'All done!' },
    ];
    expect(healthyStatusLabel(events, '2026-03-24T10:00:00.000Z')).toBe('done');
  });

  test('returns formatted duration when last event is not stop', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:15:00.000Z'));
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'ls' } },
    ];
    expect(healthyStatusLabel(events, '2026-03-24T10:00:00.000Z')).toBe('15m');
    vi.useRealTimers();
  });

  test('returns formatted duration when events are empty', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T10:05:00.000Z'));
    expect(healthyStatusLabel([], '2026-03-24T10:00:00.000Z')).toBe('5m');
    vi.useRealTimers();
  });
});

describe('healthyCurrentToolLabel', () => {
  test('returns a compact toolLabel when the last event is tool_use Read of auth.ts', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1' },
      { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/tmp/src/auth.ts' } },
    ];
    expect(healthyCurrentToolLabel(events)).toBe('Read auth.ts');
  });

  test('returns empty when the last event is stop', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/tmp/src/auth.ts' } },
      { type: 'stop', sessionId: 's1', lastMessage: 'All done!' },
    ];
    expect(healthyCurrentToolLabel(events)).toBe('');
  });

  test('returns empty when the last event is session_end', () => {
    const events: AgentEvent[] = [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'pnpm test' } },
      { type: 'session_end', sessionId: 's1', reason: 'complete' },
    ];
    expect(healthyCurrentToolLabel(events)).toBe('');
  });

  test('returns empty when there is no tool event', () => {
    expect(healthyCurrentToolLabel([])).toBe('');
    expect(healthyCurrentToolLabel([{ type: 'session_start', sessionId: 's1' }])).toBe('');
  });
});

describe('projectLabel', () => {
  test('extracts last path segment from absolute path', () => {
    expect(projectLabel('/workspace/kookr')).toBe('kookr');
  });

  test('extracts last segment from deeply nested path', () => {
    expect(projectLabel('/workspace/projects/frontend/my-app')).toBe('my-app');
  });

  test('handles trailing slash', () => {
    expect(projectLabel('/workspace/kookr/')).toBe('kookr');
  });

  test('handles multiple trailing slashes', () => {
    expect(projectLabel('/workspace/kookr///')).toBe('kookr');
  });

  test('handles root path', () => {
    expect(projectLabel('/')).toBe('');
  });

  test('handles single segment (no slash)', () => {
    expect(projectLabel('kookr')).toBe('kookr');
  });

  test('returns empty string for undefined', () => {
    expect(projectLabel(undefined)).toBe('');
  });

  test('returns empty string for empty string', () => {
    expect(projectLabel('')).toBe('');
  });

  test('handles path with spaces', () => {
    expect(projectLabel('/workspace/my projects/cool app')).toBe('cool app');
  });

  test('handles path with dots', () => {
    expect(projectLabel('/workspace/.config/nvim')).toBe('nvim');
  });
});

describe('projectColor', () => {
  test('returns a number between 0 and 7', () => {
    const paths = [
      '/workspace/kookr',
      '/workspace/openclaw',
      '/workspace/aegiscore',
      '/tmp/test',
      '/usr/local/bin',
    ];
    for (const p of paths) {
      const color = projectColor(p);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThan(8);
    }
  });

  test('returns the same color for the same path (deterministic)', () => {
    const path = '/workspace/kookr';
    const first = projectColor(path);
    const second = projectColor(path);
    expect(first).toBe(second);
  });

  test('returns different colors for different paths (likely)', () => {
    // Not guaranteed but with enough variety we expect at least some different colors
    const colors = new Set([
      projectColor('/workspace/kookr'),
      projectColor('/workspace/openclaw'),
      projectColor('/workspace/aegiscore'),
      projectColor('/tmp/project-a'),
      projectColor('/tmp/project-b'),
    ]);
    expect(colors.size).toBeGreaterThan(1);
  });

  test('returns 0 for undefined', () => {
    expect(projectColor(undefined)).toBe(0);
  });

  test('returns 0 for empty string', () => {
    expect(projectColor('')).toBe(0);
  });

  test('never returns negative values', () => {
    // Test a variety of paths including ones that might produce negative hashes
    const paths = ['/a', '/b', '/abc', '/xyz', '/123', '/-test', '/~user'];
    for (const p of paths) {
      expect(projectColor(p)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('agentProviderPresentation', () => {
  test('labels Claude Code as an Anthropic-backed agent', () => {
    expect(agentProviderPresentation('claude-code')).toMatchObject({
      label: 'Claude Code',
      provider: 'Anthropic',
    });
    expect(agentProviderPresentation('claude-code').iconPath).toMatch(/^M.+Z$/);
  });

  test('labels Codex CLI as an OpenAI-backed agent', () => {
    expect(agentProviderPresentation('codex-cli')).toMatchObject({
      label: 'Codex CLI',
      provider: 'OpenAI',
    });
    expect(agentProviderPresentation('codex-cli').iconPath).toMatch(/^M.+Z$/);
  });

  test('labels Grok Build as an xAI-backed agent with the product mark', () => {
    expect(agentProviderPresentation('grok-build')).toMatchObject({
      label: 'Grok Build',
      provider: 'xAI',
    });
    expect(agentProviderPresentation('grok-build').iconPath).toMatch(/^M.+Z$/);
    expect(agentProviderPresentation('grok-build').iconPath).not.toContain('M3 3h3l6 8');
  });
});

describe('turnStateLabel (issue #358)', () => {
  test('completed_turn reads as an idle, review-ready turn', () => {
    expect(turnStateLabel('completed_turn')).toBe('Signaled complete — waiting for review');
  });

  test('running keeps active work distinct from an idle turn', () => {
    expect(turnStateLabel('running')).toBe('Running');
  });

  test('waiting_for_input and blocked have their own copy', () => {
    expect(turnStateLabel('waiting_for_input')).toBe('Waiting for your input');
    expect(turnStateLabel('blocked')).toBe('Blocked');
  });

  test('unknown and undefined render nothing', () => {
    expect(turnStateLabel('unknown')).toBe('');
    expect(turnStateLabel(undefined)).toBe('');
  });
});

describe('turnStateClass', () => {
  test('maps each turn state to a CSS suffix', () => {
    expect(turnStateClass('running')).toBe('running');
    expect(turnStateClass('waiting_for_input')).toBe('waiting');
    expect(turnStateClass('completed_turn')).toBe('complete');
    expect(turnStateClass('blocked')).toBe('blocked');
  });

  test('unknown and undefined yield no class', () => {
    expect(turnStateClass('unknown')).toBe('');
    expect(turnStateClass(undefined)).toBe('');
  });
});

describe('deriveTaskNextStepRecommendations', () => {
  test('suggests merged PR and playbook follow-up actions for a completed playbook task', () => {
    const recommendations = deriveTaskNextStepRecommendations(
      makeCompletedAgent({
        playbookId: 'oss-pr-lessons',
        playbookParameterValues: { repo: 'kookr-ai/kookr' },
      }),
      [makePr()],
    );

    expect(recommendations.map((recommendation) => recommendation.id)).toEqual([
      'merged-pr-kookr-ai-kookr-1151',
      'continue-playbook-oss-pr-lessons',
      'snapshot-reflect',
    ]);
    expect(recommendations[0]).toMatchObject({
      title: 'PR #1151 merged',
      actionLabel: 'Open PR #1151',
      action: { type: 'open-pr', href: 'https://github.com/kookr-ai/kookr/pull/1151' },
    });
    expect(recommendations[1]).toMatchObject({
      title: 'Continue the playbook',
      actionLabel: 'Launch follow-up',
      action: { type: 'relaunch' },
    });
  });

  test('suggests snapshot reflection as a maintenance action after completion', () => {
    const recommendations = deriveTaskNextStepRecommendations(makeCompletedAgent());

    expect(recommendations).toEqual([{
      id: 'snapshot-reflect',
      title: 'Capture a task snapshot',
      detail: 'Run snapshot reflection now to preserve what happened and surface reusable follow-up notes.',
      actionLabel: 'Run snapshot',
      action: { type: 'snapshot-reflect' },
    }]);
  });

  test('does not suggest next steps for active tasks', () => {
    expect(deriveTaskNextStepRecommendations(makeCompletedAgent({ taskStatus: 'inProgress' }))).toEqual([]);
  });
});

describe('worktreeHealthLabel (F14)', () => {
  test('missing states say "worktree" so the badge is unambiguous', () => {
    expect(worktreeHealthLabel('missing_unexpectedly')).toBe('worktree missing');
    expect(worktreeHealthLabel('missing')).toBe('worktree missing');
  });

  test('registry-stale flag wins over health', () => {
    expect(worktreeHealthLabel('missing_unexpectedly', true)).toBe('git stale');
  });

  test('ok and undefined render no badge', () => {
    expect(worktreeHealthLabel('ok')).toBe('');
    expect(worktreeHealthLabel(undefined)).toBe('');
  });

  test('other states keep their short labels', () => {
    expect(worktreeHealthLabel('stale')).toBe('stale');
    expect(worktreeHealthLabel('cleaned_up')).toBe('cleaned up');
  });
});

describe('worktreeHealthTitle (F14)', () => {
  test('missing_unexpectedly explains the working copy may be gone and to check before sending work', () => {
    const title = worktreeHealthTitle('missing_unexpectedly');
    expect(title).toBe(
      "Worktree directory is missing unexpectedly — the agent's working copy may have been deleted. Check the session before sending new work.",
    );
  });

  test('legacy missing carries the same working-copy warning', () => {
    expect(worktreeHealthTitle('missing')).toContain("the agent's working copy may have been deleted");
    expect(worktreeHealthTitle('missing')).toContain('Check the session before sending new work.');
  });

  test('registry-stale flag wins over health', () => {
    expect(worktreeHealthTitle('missing_unexpectedly', true)).toBe(
      'Worktree registry refresh failed; showing stale git state',
    );
  });

  test('ok and undefined render no tooltip', () => {
    expect(worktreeHealthTitle(undefined)).toBe('');
  });
});

describe('taskStatusLabel', () => {
  test('maps raw task-status enums to human labels', () => {
    expect(taskStatusLabel('open')).toBe('Open');
    expect(taskStatusLabel('pending')).toBe('Pending');
    expect(taskStatusLabel('inProgress')).toBe('In progress');
    expect(taskStatusLabel('completed')).toBe('Completed');
    expect(taskStatusLabel('terminated')).toBe('Terminated');
    expect(taskStatusLabel('cancelled')).toBe('Cancelled');
  });

  test('falls back to the raw value for unknown statuses and empty for undefined', () => {
    expect(taskStatusLabel('someFutureStatus')).toBe('someFutureStatus');
    expect(taskStatusLabel(undefined)).toBe('');
  });
});

describe('findingTypeLabel', () => {
  function agent(type: NonNullable<AgentState['anomaly']>['type'], overrides: Partial<AgentState> = {}): AgentState {
    return {
      agentId: 'agent-1',
      events: [],
      anomaly: {
        agentId: 'agent-1',
        type,
        severity: 'warning',
        explanation: 'Waiting',
        detectedAt: new Date('2026-06-21T00:00:00.000Z'),
      },
      ...overrides,
    };
  }

  test('uses curated labels for protocol anomaly types', () => {
    expect(findingTypeLabel(agent('api_error'))).toBe('API Error');
    expect(findingTypeLabel(agent('merge_conflict'))).toBe('Merge Conflict');
    expect(findingTypeLabel(agent('permission_blocked'))).toBe('Permission');
    expect(findingTypeLabel(agent('backend_unreachable'))).toBe('Backend Unreachable');
  });

  test('distinguishes completed-turn signals from explicit input requests', () => {
    expect(findingTypeLabel(agent('needs_input'))).toBe('Needs Input');
    expect(findingTypeLabel(agent('needs_input', { turnState: 'completed_turn' }))).toBe('Signaled Complete');
  });

  test('anomalyTypeLabel is type-only so chips do not split needs_input by turn state', () => {
    expect(anomalyTypeLabel('permission_blocked')).toBe('Permission');
    expect(anomalyTypeLabel('needs_input')).toBe('Needs Input');
    expect(anomalyTypeLabel('future_kind')).toBe('future kind');
  });
});

describe('cacheHitRatio / formatCacheHit', () => {
  function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      ...overrides,
    };
  }

  test('returns null / empty string when there is no billed input (zero-cache, zero-input)', () => {
    expect(cacheHitRatio(usage())).toBeNull();
    expect(cacheHitRatio(undefined)).toBeNull();
    expect(formatCacheHit(usage())).toBe('');
    expect(formatCacheHit(undefined)).toBe('');
  });

  test('yields a well-defined 0% when input was paid in full with no cache reads', () => {
    const u = usage({ inputTokens: 1000, cacheReadTokens: 0 });
    expect(cacheHitRatio(u)).toBe(0);
    expect(formatCacheHit(u)).toBe('0%');
  });

  test('computes the mixed cache-hit ratio over inputTokens + cacheReadTokens', () => {
    // 8500 read / (1500 fresh + 8500 read) = 0.85
    const u = usage({ inputTokens: 1500, cacheReadTokens: 8500 });
    expect(cacheHitRatio(u)).toBeCloseTo(0.85, 5);
    expect(formatCacheHit(u)).toBe('85%');
  });

  test('all input served from cache reads as 100%', () => {
    const u = usage({ inputTokens: 0, cacheReadTokens: 4000 });
    expect(cacheHitRatio(u)).toBe(1);
    expect(formatCacheHit(u)).toBe('100%');
  });

  test('rounds a non-exact ratio to the nearest whole percent', () => {
    // 2 read / (1 fresh + 2 read) = 0.6666… → rounds up to 67%
    const u = usage({ inputTokens: 1, cacheReadTokens: 2 });
    expect(cacheHitRatio(u)).toBeCloseTo(2 / 3, 5);
    expect(formatCacheHit(u)).toBe('67%');
  });
});

describe('formatCostRate', () => {
  const START = '2026-06-11T10:00:00.000Z';

  test('one-hour fixture is total cost as $X.XX/h', () => {
    const nowMs = Date.parse('2026-06-11T11:00:00.000Z');
    expect(formatCostRate(4, START, nowMs)).toBe('$4.00/h');
  });

  test('omits the rate when the session is younger than two minutes', () => {
    const justUnderFloor = Date.parse(START) + 119_999;
    expect(formatCostRate(4, START, justUnderFloor)).toBe('');
  });

  test('shows the rate at the two-minute floor (same cutoff as formatAge)', () => {
    const atFloor = Date.parse(START) + 120_000;
    // $4 over 2 minutes = $120/h
    expect(formatCostRate(4, START, atFloor)).toBe('$120.00/h');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(atFloor));
    expect(formatAge(START)).toBe('2m');
    vi.useRealTimers();
  });

  test('omits the rate when cost or start is missing, zero, or invalid', () => {
    const nowMs = Date.parse('2026-06-11T11:00:00.000Z');
    expect(formatCostRate(undefined, START, nowMs)).toBe('');
    expect(formatCostRate(0, START, nowMs)).toBe('');
    expect(formatCostRate(-1, START, nowMs)).toBe('');
    expect(formatCostRate(Number.NaN, START, nowMs)).toBe('');
    expect(formatCostRate(Number.POSITIVE_INFINITY, START, nowMs)).toBe('');
    expect(formatCostRate(4, undefined, nowMs)).toBe('');
    expect(formatCostRate(4, 'not-a-date', nowMs)).toBe('');
    expect(formatCostRate(4, START, Date.parse('2026-06-11T09:00:00.000Z'))).toBe('');
  });

  test('never returns NaN or Infinity in the string', () => {
    const nowMs = Date.parse('2026-06-11T11:00:00.000Z');
    const samples = [
      formatCostRate(4, START, nowMs),
      formatCostRate(4, START, Date.parse(START) + 119_999),
      formatCostRate(0, START, nowMs),
      formatCostRate(Number.NaN, START, nowMs),
      formatCostRate(Number.POSITIVE_INFINITY, START, nowMs),
    ];
    for (const sample of samples) {
      expect(sample).not.toMatch(/NaN|Infinity/i);
    }
  });
});

describe('formatDuration (issue #2737)', () => {
  test('freezes at finishedAt - startedAt for a completed task, unchanged across re-renders', () => {
    const startedAt = '2026-08-19T10:00:00.000Z';
    const finishedAt = '2026-08-19T12:41:00.000Z'; // 2h 41m later

    // Set "now" far past finishedAt to prove the live counter is not used.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T06:00:00.000Z'));
      const first = formatDuration(startedAt, finishedAt);
      expect(first).toBe('2h 41m');

      // Advance the clock; a frozen duration must not change.
      vi.setSystemTime(new Date('2026-08-21T06:00:00.000Z'));
      const second = formatDuration(startedAt, finishedAt);
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps ticking against now when no end time is given (live task)', () => {
    const startedAt = '2026-08-20T10:00:00.000Z';

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T10:30:00.000Z'));
      expect(formatDuration(startedAt)).toBe('30m');

      vi.setSystemTime(new Date('2026-08-20T11:15:00.000Z'));
      expect(formatDuration(startedAt)).toBe('1h 15m');
    } finally {
      vi.useRealTimers();
    }
  });

  test('returns empty string when startedAt is absent', () => {
    expect(formatDuration(undefined, '2026-08-20T12:00:00.000Z')).toBe('');
    expect(formatDuration()).toBe('');
  });

  test('returns empty string for an unparseable startedAt instead of "NaNh NaNm"', () => {
    expect(formatDuration('not-a-date')).toBe('');
    expect(formatDuration('not-a-date', '2026-08-20T12:00:00.000Z')).toBe('');
  });

  test('falls back to the live clock when endedAt is unparseable', () => {
    const startedAt = '2026-08-20T10:00:00.000Z';
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-20T10:45:00.000Z'));
      // A present-but-invalid finishedAt must not render "NaNh NaNm"; it ticks live.
      expect(formatDuration(startedAt, 'not-a-date')).toBe('45m');
    } finally {
      vi.useRealTimers();
    }
  });

  test('renders "<1m" for a zero or clock-skewed (finishedAt before startedAt) duration', () => {
    const startedAt = '2026-08-20T10:00:00.000Z';
    expect(formatDuration(startedAt, startedAt)).toBe('<1m');
    expect(formatDuration(startedAt, '2026-08-20T09:59:00.000Z')).toBe('<1m');
  });
});
