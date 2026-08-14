import { describe, expect, test } from 'vitest';
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  CLAUDE_CODE_MODEL_IDS,
  CODEX_CLI_EFFORT_LEVELS,
} from '../../shared/contracts/agent-types.js';
import {
  effortOptionsForSelection,
  modelOptionsForSelection,
  optionalLaunchPins,
} from './launch-effort-model.js';

describe('optionalLaunchPins', () => {
  test('omits empty fields so the server default applies', () => {
    expect(optionalLaunchPins('', '')).toEqual({});
    expect(optionalLaunchPins('   ', '  ')).toEqual({});
  });

  test('includes only the pins the operator chose', () => {
    expect(optionalLaunchPins('max', '')).toEqual({ effort: 'max' });
    expect(optionalLaunchPins('', 'claude-fable-5')).toEqual({ model: 'claude-fable-5' });
    expect(optionalLaunchPins('high', 'claude-sonnet-5')).toEqual({
      effort: 'high',
      model: 'claude-sonnet-5',
    });
  });
});

describe('picker options follow the resolved agent allowlist', () => {
  test('claude-code exposes effort and model', () => {
    expect(effortOptionsForSelection('claude-code')).toEqual(CLAUDE_CODE_EFFORT_LEVELS);
    expect(modelOptionsForSelection('claude-code')).toEqual(CLAUDE_CODE_MODEL_IDS);
  });

  test('codex-cli exposes effort and hides model', () => {
    expect(effortOptionsForSelection('codex-cli')).toEqual(CODEX_CLI_EFFORT_LEVELS);
    expect(modelOptionsForSelection('codex-cli')).toEqual([]);
  });

  test('grok-build and round-robin hide both pickers', () => {
    expect(effortOptionsForSelection('grok-build')).toEqual([]);
    expect(modelOptionsForSelection('grok-build')).toEqual([]);
    expect(effortOptionsForSelection('round-robin')).toEqual([]);
    expect(modelOptionsForSelection('round-robin')).toEqual([]);
  });
});
