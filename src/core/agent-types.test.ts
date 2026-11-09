import { describe, test, expect } from 'vitest';
import {
  normalizeAgentType,
  normalizeAgentSelection,
  resolveRoundRobinAgent,
  AUTO_ROTATION_EXCLUDED_AGENT_TYPES,
  isAutoRotationEligible,
  resolvePinnedAgentFallback,
  excludeBlacklistedAgents,
  advertisedAgentTypes,
  buildAgentSelectionOptions,
  previewRoundRobinNextLabel,
  agentSelectionHint,
  DEFAULT_AGENT_TYPE,
  AVAILABLE_AGENT_TYPES,
  AGENT_SELECTION_HINTS,
  AGENT_SELECTIONS,
  ROUND_ROBIN_AGENT_TYPE,
  ROUND_ROBIN_OPTION,
  CLAUDE_CODE_EFFORT_LEVELS,
  CODEX_CLI_EFFORT_LEVELS,
  CODEX_GPT_6_ASTRA_EFFORT_LEVELS,
  GROK_BUILD_EFFORT_LEVELS,
  ALL_EFFORT_LEVELS,
  effortLevelsForAgent,
  modelsForAgent,
  isValidModelForAgent,
  isKnownModelId,
  CLAUDE_CODE_MODEL_IDS,
  CODEX_CLI_MODEL_IDS,
  ALL_MODEL_IDS,
  isValidEffortForAgent,
  isAgentType,
  isIdentityOnlyAgentType,
  AGENT_TYPES,
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
  test('contains claude-code, codex-cli, grok-build, and opencode in canonical order', () => {
    expect(AVAILABLE_AGENT_TYPES.map((a) => a.type)).toEqual(['claude-code', 'codex-cli', 'grok-build', 'opencode']);
  });

  test('each entry has a label', () => {
    for (const entry of AVAILABLE_AGENT_TYPES) {
      expect(entry.label).toBeTruthy();
    }
  });
});

describe('agentSelectionHint', () => {
  test('covers every picker selection with a non-empty identity line', () => {
    expect(Object.keys(AGENT_SELECTION_HINTS).sort()).toEqual([...AGENT_SELECTIONS].sort());
    for (const selection of AGENT_SELECTIONS) {
      expect(AGENT_SELECTION_HINTS[selection].length).toBeGreaterThan(0);
      expect(agentSelectionHint(selection)).toBe(AGENT_SELECTION_HINTS[selection]);
    }
  });

  test('returns undefined for empty or unknown picker values', () => {
    expect(agentSelectionHint('')).toBeUndefined();
    expect(agentSelectionHint(undefined)).toBeUndefined();
    expect(agentSelectionHint(null)).toBeUndefined();
    expect(agentSelectionHint('not-an-agent')).toBeUndefined();
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

describe('resolvePinnedAgentFallback (issue #1895 / #1699 WS1.3)', () => {
  const both: ReadonlyArray<'claude-code' | 'codex-cli'> = ['claude-code', 'codex-cli'];
  const all: ReadonlyArray<'claude-code' | 'codex-cli' | 'grok-build'> = [
    'claude-code',
    'codex-cli',
    'grok-build',
  ];

  test('pass-through when the pin is registered and healthy', () => {
    expect(resolvePinnedAgentFallback('codex-cli', both)).toEqual({
      kind: 'available',
      agentType: 'codex-cli',
      substituted: false,
    });
  });

  test('substitutes when the pin is not registered', () => {
    expect(resolvePinnedAgentFallback('codex-cli', ['claude-code'])).toEqual({
      kind: 'substituted',
      agentType: 'claude-code',
      substituted: true,
      from: 'codex-cli',
    });
  });

  test('substitutes a deprioritized pin when a healthy alternative remains', () => {
    expect(resolvePinnedAgentFallback('grok-build', all, ['grok-build'])).toEqual({
      kind: 'substituted',
      agentType: 'claude-code',
      substituted: true,
      from: 'grok-build',
    });
  });

  test('keeps a deprioritized pin when every agent is deprioritized', () => {
    // Same rule as resolveRoundRobinAgent: something must launch.
    expect(resolvePinnedAgentFallback('grok-build', all, all)).toEqual({
      kind: 'available',
      agentType: 'grok-build',
      substituted: false,
    });
  });

  test('reports unavailable when no agents are registered', () => {
    expect(resolvePinnedAgentFallback('codex-cli', [])).toEqual({
      kind: 'unavailable',
      from: 'codex-cli',
    });
  });

  test('picks the first healthy agent in canonical order as substitute', () => {
    // Pin grok; only codex + grok registered; grok deprioritized → codex.
    expect(resolvePinnedAgentFallback('grok-build', ['codex-cli', 'grok-build'], ['grok-build'])).toEqual({
      kind: 'substituted',
      agentType: 'codex-cli',
      substituted: true,
      from: 'grok-build',
    });
  });

  test('disallow policy parks instead of cascading onto codex-cli (issue #2001)', () => {
    // Grok deprioritized; claude + codex healthy; codex disallowed → claude.
    expect(
      resolvePinnedAgentFallback('grok-build', all, ['grok-build'], {
        disallow: ['codex-cli'],
      }),
    ).toEqual({
      kind: 'substituted',
      agentType: 'claude-code',
      substituted: true,
      from: 'grok-build',
    });
    // Only codex remains as substitute but disallowed → unavailable (park).
    expect(
      resolvePinnedAgentFallback('grok-build', ['codex-cli', 'grok-build'], ['grok-build'], {
        disallow: ['codex-cli'],
      }),
    ).toEqual({
      kind: 'unavailable',
      from: 'grok-build',
    });
  });

  test('allowlist restricts substitutes without blocking an explicit healthy pin (issue #2001)', () => {
    // Explicit pin to codex stays available even when allowlist is claude-only.
    expect(
      resolvePinnedAgentFallback('codex-cli', all, [], {
        allowlist: ['claude-code'],
      }),
    ).toEqual({
      kind: 'available',
      agentType: 'codex-cli',
      substituted: false,
    });
    // Grok deprioritized; allowlist claude-only → claude (not codex).
    expect(
      resolvePinnedAgentFallback('grok-build', all, ['grok-build'], {
        allowlist: ['claude-code'],
      }),
    ).toEqual({
      kind: 'substituted',
      agentType: 'claude-code',
      substituted: true,
      from: 'grok-build',
    });
    // Allowlist empty of remaining candidates → park.
    expect(
      resolvePinnedAgentFallback('grok-build', all, ['grok-build', 'claude-code'], {
        allowlist: ['claude-code'],
      }),
    ).toEqual({
      kind: 'unavailable',
      from: 'grok-build',
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
    expect(options.map((o) => o.type)).toEqual(['claude-code', 'codex-cli', 'grok-build', 'opencode', 'round-robin']);
  });
});

describe('previewRoundRobinNextLabel', () => {
  const options = buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES);

  test('resolves the next label from the cursor the launch service uses', () => {
    expect(previewRoundRobinNextLabel(options, { cursor: 0 })).toBe('Claude Code');
    expect(previewRoundRobinNextLabel(options, { cursor: 1 })).toBe('Codex CLI');
    expect(previewRoundRobinNextLabel(options, { cursor: 2 })).toBe('Grok Build');
    // opencode is explicit-only: the rotation wraps after Grok Build.
    expect(previewRoundRobinNextLabel(options, { cursor: 3 })).toBe('Claude Code');
  });

  test('prefers a still-available advertised next agent over the cursor', () => {
    expect(previewRoundRobinNextLabel(options, {
      cursor: 0,
      advertisedNext: 'codex-cli',
    })).toBe('Codex CLI');
  });

  test('ignores an advertised agent that is no longer in the rotation', () => {
    const withoutGrok = buildAgentSelectionOptions(
      AVAILABLE_AGENT_TYPES.filter((entry) => entry.type !== 'grok-build'),
    );
    expect(previewRoundRobinNextLabel(withoutGrok, {
      cursor: 0,
      advertisedNext: 'grok-build',
    })).toBe('Claude Code');
  });

  test('returns undefined when no concrete agent remains', () => {
    expect(previewRoundRobinNextLabel([{ type: 'round-robin', label: 'Round robin' }])).toBeUndefined();
  });

  test('skips Grok when session auth is known unusable', () => {
    expect(previewRoundRobinNextLabel(options, {
      cursor: 3,
      grokAuthUsable: false,
    })).toBe('Codex CLI');
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

  test('gpt-6-astra exposes only the efforts advertised by that model', () => {
    expect([...CODEX_GPT_6_ASTRA_EFFORT_LEVELS]).toEqual([
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ]);
    expect(effortLevelsForAgent('codex-cli', 'gpt-6-astra')).toEqual(
      CODEX_GPT_6_ASTRA_EFFORT_LEVELS,
    );
    expect(isValidEffortForAgent('codex-cli', 'ultra', 'gpt-6-astra')).toBe(true);
    expect(isValidEffortForAgent('codex-cli', 'minimal', 'gpt-6-astra')).toBe(false);
    expect(isValidEffortForAgent('codex-cli', 'none', 'gpt-6-astra')).toBe(false);
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
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-opus-5');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-fable-5');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-opus-4-8');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-sonnet-5');
    expect(CLAUDE_CODE_MODEL_IDS).toContain('claude-haiku-4-5');
    expect(modelsForAgent('claude-code')).toEqual(CLAUDE_CODE_MODEL_IDS);
  });

  test('codex-cli exposes gpt-6-astra without inheriting Claude models', () => {
    expect(CODEX_CLI_MODEL_IDS).toEqual(['gpt-6-astra']);
    expect(modelsForAgent('codex-cli')).toEqual(CODEX_CLI_MODEL_IDS);
    expect(isValidModelForAgent('codex-cli', 'gpt-6-astra')).toBe(true);
    expect(isValidModelForAgent('codex-cli', 'gpt-6-astra-not-real')).toBe(false);
    expect(isValidModelForAgent('codex-cli', 'claude-fable-5')).toBe(false);
  });

  test('grok-build exposes no per-task model pins (no Claude inheritance)', () => {
    expect(modelsForAgent('grok-build')).toEqual([]);
    for (const id of CLAUDE_CODE_MODEL_IDS) {
      expect(isValidModelForAgent('grok-build', id)).toBe(false);
    }
  });

  test('isValidModelForAgent accepts exact ids and dated suffixes', () => {
    expect(isValidModelForAgent('claude-code', 'claude-fable-5')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-opus-5')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-opus-5-20260828')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'claude-opus-4-8-20260701')).toBe(true);
    expect(isValidModelForAgent('claude-code', 'gpt-5.6-sol')).toBe(false);
    expect(isValidModelForAgent('claude-code', '')).toBe(false);
    expect(isValidModelForAgent('claude-code', 'claude')).toBe(false);
  });

  test('isKnownModelId is the cross-agent CLI fast-fail', () => {
    expect(isKnownModelId('claude-fable-5')).toBe(true);
    expect(isKnownModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(isKnownModelId('gpt-6-astra')).toBe(true);
    expect(isKnownModelId('gpt-6-astra-not-real')).toBe(false);
    expect(isKnownModelId('not-a-model')).toBe(false);
    expect(ALL_MODEL_IDS).toEqual(expect.arrayContaining([...CLAUDE_CODE_MODEL_IDS]));
    expect(ALL_MODEL_IDS).toEqual(expect.arrayContaining([...CODEX_CLI_MODEL_IDS]));
  });
});

describe('excludeBlacklistedAgents (issue #3025)', () => {
  test('returns a copy when the blacklist is empty', () => {
    const agents: Array<'claude-code' | 'codex-cli'> = ['claude-code', 'codex-cli'];
    expect(excludeBlacklistedAgents(agents, [])).toEqual(['claude-code', 'codex-cli']);
    expect(excludeBlacklistedAgents(agents, [])).not.toBe(agents);
  });

  test('drops every listed type and preserves canonical order of the rest', () => {
    expect(
      excludeBlacklistedAgents(
        ['claude-code', 'codex-cli', 'grok-build'],
        ['claude-code'],
      ),
    ).toEqual(['codex-cli', 'grok-build']);
  });

  test('can drop every agent', () => {
    expect(
      excludeBlacklistedAgents(['claude-code', 'codex-cli'], ['claude-code', 'codex-cli']),
    ).toEqual([]);
  });
});

describe('advertisedAgentTypes (issue #3025)', () => {
  test('intersects registered adapters with AVAILABLE_AGENT_TYPES', () => {
    expect(advertisedAgentTypes(['codex-cli', 'claude-code']).map((item) => item.type))
      .toEqual(['claude-code', 'codex-cli']);
  });

  test('hides blacklisted agents from the picker list', () => {
    expect(
      advertisedAgentTypes(
        ['claude-code', 'codex-cli', 'grok-build'],
        ['claude-code'],
      ).map((item) => item.type),
    ).toEqual(['codex-cli', 'grok-build']);
  });
});

describe('hermes-fleet AgentType identity (jeanibarz/hermes-fleet#15)', () => {
  test('is a recognized concrete agent type', () => {
    expect(AGENT_TYPES).toContain('hermes-fleet');
    expect(isAgentType('hermes-fleet')).toBe(true);
  });

  test('normalizes itself and the "hermes" alias', () => {
    expect(normalizeAgentType('hermes-fleet')).toBe('hermes-fleet');
    expect(normalizeAgentType('hermes')).toBe('hermes-fleet');
  });

  test('has a non-empty selection hint', () => {
    expect(AGENT_SELECTION_HINTS['hermes-fleet'].length).toBeGreaterThan(0);
    expect(agentSelectionHint('hermes-fleet')).toBe(AGENT_SELECTION_HINTS['hermes-fleet']);
  });

  test('exposes NO Kookr-side effort or model levels (locked by its own harness)', () => {
    expect(effortLevelsForAgent('hermes-fleet')).toEqual([]);
    expect(modelsForAgent('hermes-fleet')).toEqual([]);
    expect(isValidEffortForAgent('hermes-fleet', 'high')).toBe(false);
    expect(isValidModelForAgent('hermes-fleet', 'anything')).toBe(false);
  });

  test('is identity-only: NOT advertised as a launchable agent', () => {
    // Deliberately absent from AVAILABLE_AGENT_TYPES so it never appears in the
    // picker, round-robin, or remote allowlist until a launch adapter exists.
    expect(AVAILABLE_AGENT_TYPES.map((a) => a.type)).not.toContain('hermes-fleet');
    // Even if an adapter were somehow registered, advertisement derives from
    // AVAILABLE ∩ registry, so it stays hidden.
    expect(advertisedAgentTypes(['hermes-fleet']).map((a) => a.type)).not.toContain('hermes-fleet');
    // Round-robin only rotates over AVAILABLE, so it can never select it.
    expect(resolveRoundRobinAgent(0, ['hermes-fleet'])).toBe(DEFAULT_AGENT_TYPE);
  });

  test('isIdentityOnlyAgentType flags hermes-fleet but not the launchable catalog', () => {
    expect(isIdentityOnlyAgentType('hermes-fleet')).toBe(true);
    for (const launchable of ['claude-code', 'codex-cli', 'grok-build'] as const) {
      expect(isIdentityOnlyAgentType(launchable)).toBe(false);
    }
    // The predicate's set is exactly AGENT_TYPES minus AVAILABLE_AGENT_TYPES.
    const advertised = new Set(AVAILABLE_AGENT_TYPES.map((a) => a.type));
    for (const t of AGENT_TYPES) {
      expect(isIdentityOnlyAgentType(t)).toBe(!advertised.has(t));
    }
  });
});

describe('opencode agent type', () => {
  test('normalizes and is a launchable (non identity-only) type', () => {
    expect(normalizeAgentType('opencode')).toBe('opencode');
    expect(isAgentType('opencode')).toBe(true);
    expect(isIdentityOnlyAgentType('opencode')).toBe(false);
  });

  test('has no effort levels and no fixed model allowlist', () => {
    expect(effortLevelsForAgent('opencode')).toEqual([]);
    expect(isValidEffortForAgent('opencode', 'high')).toBe(false);
    expect(modelsForAgent('opencode')).toEqual([]);
  });

  test.each([
    'deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'openrouter/anthropic/claude-sonnet-4.5',
    'provider/model:free',
  ])('accepts provider/model id %s', (model) => {
    expect(isValidModelForAgent('opencode', model)).toBe(true);
  });

  test.each(['', 'bare-model', '/model', 'a/', 'a//b', 'a/../b', 'a/b c', 'a/b;rm -rf', 'a/$(x)', `a/${'x'.repeat(250)}`])(
    'rejects unsafe or malformed model id %j',
    (model) => {
      expect(isValidModelForAgent('opencode', model)).toBe(false);
    },
  );
});

describe('auto-rotation exclusion (opencode is explicit-only)', () => {
  const all = AVAILABLE_AGENT_TYPES.map((entry) => entry.type);

  test('excludes only opencode', () => {
    expect([...AUTO_ROTATION_EXCLUDED_AGENT_TYPES]).toEqual(['opencode']);
    expect(isAutoRotationEligible('opencode')).toBe(false);
    expect(isAutoRotationEligible('claude-code')).toBe(true);
  });

  test('round-robin never yields opencode across many cursors', () => {
    for (let cursor = 0; cursor < 20; cursor += 1) {
      expect(resolveRoundRobinAgent(cursor, all)).not.toBe('opencode');
    }
  });

  test('rotation over the existing agents is unchanged by opencode being registered', () => {
    const without = all.filter((t) => t !== 'opencode');
    for (let cursor = 0; cursor < 8; cursor += 1) {
      expect(resolveRoundRobinAgent(cursor, all)).toBe(resolveRoundRobinAgent(cursor, without));
    }
  });

  test('opencode as the only registered agent falls back to the default, not opencode', () => {
    expect(resolveRoundRobinAgent(0, ['opencode'])).toBe(DEFAULT_AGENT_TYPE);
  });

  test('an explicit opencode pin is honored but opencode is never an automatic substitute', () => {
    expect(resolvePinnedAgentFallback('opencode', all)).toEqual({
      kind: 'available', agentType: 'opencode', substituted: false,
    });
    expect(resolvePinnedAgentFallback('codex-cli', ['opencode'])).toEqual({ kind: 'unavailable', from: 'codex-cli' });
    const res = resolvePinnedAgentFallback('codex-cli', ['opencode', 'claude-code']);
    expect(res).toMatchObject({ kind: 'substituted', agentType: 'claude-code' });
  });

  test('round-robin picker option needs two rotatable agents', () => {
    const opts = (types: Array<(typeof all)[number]>) =>
      buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES.filter((e) => types.includes(e.type)));
    expect(opts(['claude-code', 'opencode']).some((o) => o.type === ROUND_ROBIN_AGENT_TYPE)).toBe(false);
    expect(opts(['claude-code', 'codex-cli', 'opencode']).some((o) => o.type === ROUND_ROBIN_AGENT_TYPE)).toBe(true);
  });

  test('round-robin preview label skips opencode', () => {
    const options = buildAgentSelectionOptions(AVAILABLE_AGENT_TYPES);
    for (let cursor = 0; cursor < 8; cursor += 1) {
      expect(previewRoundRobinNextLabel(options, { cursor })).not.toBe('opencode');
    }
  });
});
