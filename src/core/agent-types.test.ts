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
  CLAUDE_CODE_EFFORT_LEVELS,
  CODEX_CLI_EFFORT_LEVELS,
  GROK_BUILD_EFFORT_LEVELS,
  ALL_EFFORT_LEVELS,
  effortLevelsForAgent,
  modelsForAgent,
  isValidModelForAgent,
  isKnownModelId,
  CLAUDE_CODE_MODEL_IDS,
  ALL_MODEL_IDS,
  isValidEffortForAgent,
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
  test('contains claude-code, codex-cli, and grok-build in canonical order', () => {
    expect(AVAILABLE_AGENT_TYPES.map((a) => a.type)).toEqual(['claude-code', 'codex-cli', 'grok-build']);
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

  test('normalizes grok aliases to grok-build', () => {
    expect(normalizeAgentType('grok')).toBe('grok-build');
    expect(normalizeAgentType('grok-build')).toBe('grok-build');
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

  test('rotates across all three agents when grok-build is registered', () => {
    const all: ReadonlyArray<'claude-code' | 'codex-cli' | 'grok-build'> = [
      'claude-code',
      'codex-cli',
      'grok-build',
    ];
    expect(resolveRoundRobinAgent(0, all)).toBe('claude-code');
    expect(resolveRoundRobinAgent(1, all)).toBe('codex-cli');
    expect(resolveRoundRobinAgent(2, all)).toBe('grok-build');
    expect(resolveRoundRobinAgent(3, all)).toBe('claude-code');
  });

  test('skips grok-build when its adapter is not registered (absent binary)', () => {
    expect(resolveRoundRobinAgent(0, ['claude-code', 'codex-cli'])).toBe('claude-code');
    expect(resolveRoundRobinAgent(1, ['claude-code', 'codex-cli'])).toBe('codex-cli');
    expect(resolveRoundRobinAgent(2, ['claude-code', 'codex-cli'])).toBe('claude-code');
  });

  test('handles a negative or non-integer cursor defensively', () => {
    expect(resolveRoundRobinAgent(-1, both)).toBe('claude-code');
    expect(resolveRoundRobinAgent(1.5, both)).toBe('claude-code');
  });

  describe('boot-reliability deprioritization (#1898)', () => {
    const all: ReadonlyArray<'claude-code' | 'codex-cli' | 'grok-build'> = [
      'claude-code',
      'codex-cli',
      'grok-build',
    ];

    test('skips a deprioritized agent at the cursor that would otherwise pick it', () => {
      // Cursor 2 lands on grok-build in the full three-agent rotation...
      expect(resolveRoundRobinAgent(2, all)).toBe('grok-build');
      // ...but with grok-build deprioritized the rotation is [claude, codex]:
      // 2 % 2 === 0 → claude-code, never the unhealthy agent.
      expect(resolveRoundRobinAgent(2, all, ['grok-build'])).toBe('claude-code');
      expect(resolveRoundRobinAgent(3, all, ['grok-build'])).toBe('codex-cli');
    });

    test('never yields a deprioritized agent while a healthy one remains', () => {
      for (let cursor = 0; cursor < 6; cursor += 1) {
        expect(resolveRoundRobinAgent(cursor, all, ['grok-build'])).not.toBe('grok-build');
      }
    });

    test('collapses to the sole healthy agent when all others are deprioritized', () => {
      // Two of three deprioritized, exactly one healthy → every cursor yields it.
      for (let cursor = 0; cursor < 5; cursor += 1) {
        expect(resolveRoundRobinAgent(cursor, all, ['codex-cli', 'grok-build'])).toBe('claude-code');
      }
    });

    test('falls back to the full rotation when every agent is deprioritized', () => {
      // Something must launch; the fire() wall-clock cap is the backstop.
      expect(resolveRoundRobinAgent(2, all, all)).toBe('grok-build');
      expect(resolveRoundRobinAgent(0, ['grok-build'], ['grok-build'])).toBe('grok-build');
    });

    test('ignores a deprioritized agent that is not registered', () => {
      expect(resolveRoundRobinAgent(0, both, ['grok-build'])).toBe('claude-code');
      expect(resolveRoundRobinAgent(1, both, ['grok-build'])).toBe('codex-cli');
    });
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
    expect(options.map((o) => o.type)).toEqual(['claude-code', 'codex-cli', 'grok-build', 'round-robin']);
  });
});

describe('reasoning-effort levels (#681)', () => {
  test('claude-code allowed set mirrors the claude CLI exactly', () => {
    expect([...CLAUDE_CODE_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsForAgent('claude-code')).toEqual(CLAUDE_CODE_EFFORT_LEVELS);
  });

  test('codex-cli allowed set exposes fork-supported efforts including max and ultra', () => {
    expect([...CODEX_CLI_EFFORT_LEVELS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortLevelsForAgent('codex-cli')).toEqual(CODEX_CLI_EFFORT_LEVELS);
  });

  test('grok-build exposes NO validated effort levels (no Claude inheritance)', () => {
    // The whole point of the exhaustive switch: a new agent type must not
    // silently inherit Claude's levels. Grok's set is empty until validated.
    expect([...GROK_BUILD_EFFORT_LEVELS]).toEqual([]);
    expect(effortLevelsForAgent('grok-build')).toEqual(GROK_BUILD_EFFORT_LEVELS);
    // Every Claude level must be REJECTED for grok-build (proves no fallback).
    for (const level of CLAUDE_CODE_EFFORT_LEVELS) {
      expect(isValidEffortForAgent('grok-build', level)).toBe(false);
    }
    expect(isValidEffortForAgent('grok-build', 'high')).toBe(false);
  });

  test('isValidEffortForAgent accepts only that agent\'s levels', () => {
    // `max` is valid for Claude Code and for Kookr's fork-backed Codex models.
    expect(isValidEffortForAgent('claude-code', 'max')).toBe(true);
    expect(isValidEffortForAgent('codex-cli', 'max')).toBe(true);
    expect(isValidEffortForAgent('codex-cli', 'ultra')).toBe(true);
    // `minimal`/`none` are codex-only.
    expect(isValidEffortForAgent('codex-cli', 'minimal')).toBe(true);
    expect(isValidEffortForAgent('codex-cli', 'none')).toBe(true);
    expect(isValidEffortForAgent('claude-code', 'minimal')).toBe(false);
    expect(isValidEffortForAgent('claude-code', 'none')).toBe(false);
    // Shared levels are valid for both.
    for (const shared of ['low', 'medium', 'high', 'xhigh']) {
      expect(isValidEffortForAgent('claude-code', shared)).toBe(true);
      expect(isValidEffortForAgent('codex-cli', shared)).toBe(true);
    }
  });

  test('rejects nonsense and empty strings', () => {
    expect(isValidEffortForAgent('claude-code', 'ultra')).toBe(false);
    expect(isValidEffortForAgent('codex-cli', '')).toBe(false);
    expect(isValidEffortForAgent('claude-code', 'HIGH')).toBe(false);
  });

  test('ALL_EFFORT_LEVELS is the deduped union of both sets', () => {
    expect([...ALL_EFFORT_LEVELS].sort()).toEqual(
      ['high', 'low', 'max', 'medium', 'minimal', 'none', 'ultra', 'xhigh'],
    );
  });
});

describe('per-task model allowlist (#1518)', () => {
  test('claude-code allowlist includes Fable and issue-listed pins', () => {
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-fable-5');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-opus-4-8');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-sonnet-5');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-haiku-4-5');
    expect(modelsForAgent('claude-code')).toEqual(CLAUDE_CODE_MODEL_IDS);
  });

  test('codex-cli and grok-build expose no per-task model pins (no Claude inheritance)', () => {
    expect(modelsForAgent('codex-cli')).toEqual([]);
    expect(modelsForAgent('grok-build')).toEqual([]);
    for (const id of CLAUDE_CODE_MODEL_IDS) {
      expect(isValidModelForAgent('codex-cli', id)).toBe(false);
      expect(isValidModelForAgent('grok-build', id)).toBe(false);
    }
  });

  test('isValidModelForAgent accepts exact ids and dated suffixes', () => {
    expect(isValidModelForAgent('claude-code', 'claude-fable-5')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-opus-4-8-20260701')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'gpt-5.6-sol')).toBe(false);
    expect(isValidModelForAgent('claude-code', '')).toBe(false);
    expect(isValidModelForAgent('claude-code', 'claude')).toBe(false);
  });

  test('isKnownModelId is the cross-agent CLI fast-fail', () => {
    expect(isKnownModelId('claude-fable-5')).toBe(true);
    expect(isKnownModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(isKnownModelId('not-a-model')).toBe(false);
    expect(ALL_MODEL_IDS).toEqual(expect.arrayContaining([...CLAUDE_CODE_MODEL_IDS]));
  });
});
