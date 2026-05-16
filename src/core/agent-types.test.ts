import { describe, test, expect } from 'vitest';
import {
  normalizeAgentType,
  normalizeAgentSelection,
  resolveRoundRobinAgent,
  buildAgentSelectionOptions,
  DEFAULT_AGENT_TYPE,
  AVAILABLE_AGENT_TYPES,
  ROUND_ROBIN_AGENT_TYPE,
  ROUND_ROBIN_OPTION,
} from './agent-types.js';

describe('normalizeAgentType', () => {
  test('returns claude-code for "claude-code"', () => {
    expect(normalizeAgentType('claude-code')).toBe('claude-code');
  });

  test('returns claude-code for legacy alias "claude"', () => {
    expect(normalizeAgentType('claude')).toBe('claude-code');
  });

  test('returns codex-cli for "codex-cli"', () => {
    expect(normalizeAgentType('codex-cli')).toBe('codex-cli');
  });

  test('returns codex-cli for legacy alias "codex"', () => {
    expect(normalizeAgentType('codex')).toBe('codex-cli');
  });

  test('returns default for undefined', () => {
    expect(normalizeAgentType(undefined)).toBe(DEFAULT_AGENT_TYPE);
  });

  test('returns default for null', () => {
    expect(normalizeAgentType(null)).toBe(DEFAULT_AGENT_TYPE);
  });

  test('returns default for unrecognized string', () => {
    expect(normalizeAgentType('unknown-agent')).toBe(DEFAULT_AGENT_TYPE);
  });

  test('returns default for empty string', () => {
    expect(normalizeAgentType('')).toBe(DEFAULT_AGENT_TYPE);
  });
});

describe('AVAILABLE_AGENT_TYPES', () => {
  test('contains claude-code and codex-cli', () => {
    const types = AVAILABLE_AGENT_TYPES.map((a) => a.type);
    expect(types).toContain('claude-code');
    expect(types).toContain('codex-cli');
  });

  test('each entry has a label', () => {
    for (const entry of AVAILABLE_AGENT_TYPES) {
      expect(entry.label).toBeTruthy();
    }
  });
});

describe('normalizeAgentSelection', () => {
  test('preserves the round-robin sentinel', () => {
    expect(normalizeAgentSelection('round-robin')).toBe('round-robin');
    expect(normalizeAgentSelection('round-robin')).toBe(ROUND_ROBIN_AGENT_TYPE);
  });

  test('normalizes concrete agents like normalizeAgentType', () => {
    expect(normalizeAgentSelection('claude')).toBe('claude-code');
    expect(normalizeAgentSelection('codex-cli')).toBe('codex-cli');
  });

  test('falls back to the default for unknown or empty input', () => {
    expect(normalizeAgentSelection('robin')).toBe(DEFAULT_AGENT_TYPE);
    expect(normalizeAgentSelection(undefined)).toBe(DEFAULT_AGENT_TYPE);
    expect(normalizeAgentSelection(null)).toBe(DEFAULT_AGENT_TYPE);
  });
});

describe('resolveRoundRobinAgent', () => {
  const both: ReadonlyArray<'claude-code' | 'codex-cli'> = ['claude-code', 'codex-cli'];

  test('alternates agents as the cursor advances', () => {
    expect(resolveRoundRobinAgent(0, both)).toBe('claude-code');
    expect(resolveRoundRobinAgent(1, both)).toBe('codex-cli');
    expect(resolveRoundRobinAgent(2, both)).toBe('claude-code');
    expect(resolveRoundRobinAgent(3, both)).toBe('codex-cli');
  });

  test('collapses to the only available agent', () => {
    expect(resolveRoundRobinAgent(0, ['codex-cli'])).toBe('codex-cli');
    expect(resolveRoundRobinAgent(1, ['codex-cli'])).toBe('codex-cli');
    expect(resolveRoundRobinAgent(0, ['claude-code'])).toBe('claude-code');
  });

  test('falls back to the default when no agents are available', () => {
    expect(resolveRoundRobinAgent(0, [])).toBe(DEFAULT_AGENT_TYPE);
  });

  test('ignores rotation order beyond the canonical set', () => {
    // Only registered agents from the canonical order are rotated.
    expect(resolveRoundRobinAgent(0, ['codex-cli', 'claude-code'])).toBe('claude-code');
    expect(resolveRoundRobinAgent(1, ['codex-cli', 'claude-code'])).toBe('codex-cli');
  });

  test('handles a negative or non-integer cursor defensively', () => {
    expect(resolveRoundRobinAgent(-1, both)).toBe('claude-code');
    expect(resolveRoundRobinAgent(1.5, both)).toBe('claude-code');
  });
});

describe('buildAgentSelectionOptions', () => {
  test('appends the round-robin option when both agents are available', () => {
    const options = buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES);
    expect(options).toContainEqual(ROUND_ROBIN_OPTION);
    expect(options[options.length - 1]).toEqual(ROUND_ROBIN_OPTION);
  });

  test('omits the round-robin option with a single agent', () => {
    const options = buildAgentSelectionOptions([{ type: 'claude-code', label: 'Claude Code' }]);
    expect(options.map((o) => o.type)).toEqual(['claude-code']);
  });

  test('falls back to the canonical list (with round-robin) when none are supplied', () => {
    const options = buildAgentSelectionOptions([]);
    expect(options.map((o) => o.type)).toEqual(['claude-code', 'codex-cli', 'round-robin']);
  });
});
