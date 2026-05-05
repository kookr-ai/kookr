import { describe, test, expect } from 'vitest';
import { normalizeAgentType, DEFAULT_AGENT_TYPE, AVAILABLE_AGENT_TYPES } from './agent-types.js';

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
