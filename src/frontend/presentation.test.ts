import { describe, test, expect, vi } from 'vitest';
import { agentProviderPresentation, healthyDotClass, healthyStatusLabel, projectLabel, projectColor } from './presentation.js';
import type { AgentEvent } from '../shared/protocol.js';

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
