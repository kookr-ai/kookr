import { describe, test, expect, vi } from 'vitest';
import { agentProviderPresentation, findingTypeLabel, findingWaitStartedAt, formatAge, healthyDotClass, healthyStatusLabel, projectLabel, projectColor, taskStatusLabel, turnStateLabel, turnStateClass, worktreeHealthLabel, worktreeHealthTitle } from './presentation.js';
import type { AgentEvent, AgentState } from '../shared/protocol.js';

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
  });

  test('distinguishes completed-turn signals from explicit input requests', () => {
    expect(findingTypeLabel(agent('needs_input'))).toBe('Needs Input');
    expect(findingTypeLabel(agent('needs_input', { turnState: 'completed_turn' }))).toBe('Signaled Complete');
  });
});
