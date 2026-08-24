// @vitest-environment jsdom

import { afterEach, describe, expect, test } from 'vitest';
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  CLAUDE_CODE_MODEL_IDS,
  CODEX_CLI_EFFORT_LEVELS,
} from '../../shared/contracts/agent-types.js';
import { LAST_EFFORT_KEY, LAST_MODEL_KEY } from '../store/last-launch-pins.js';
import {
  effortOptionsForSelection,
  modelOptionsForSelection,
  optionalLaunchPins,
  restoreLastLaunchPins,
  sanitizeLaunchPins,
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

  test('codex-cli exposes effort and model suggestions', () => {
    expect(effortOptionsForSelection('codex-cli')).toEqual(CODEX_CLI_EFFORT_LEVELS);
    expect(modelOptionsForSelection('codex-cli')).toContain('gpt-5.6-sol');
  });

  test('grok-build offers custom effort and model suggestions', () => {
    expect(effortOptionsForSelection('grok-build')).toEqual([]);
    expect(modelOptionsForSelection('grok-build')).toEqual(['grok-4.6', 'grok-4.5']);
    expect(effortOptionsForSelection('round-robin')).toEqual([]);
    expect(modelOptionsForSelection('round-robin')).toEqual([]);
  });
});

describe('sanitizeLaunchPins', () => {
  test('keeps pins the agent accepts and drops the rest', () => {
    expect(sanitizeLaunchPins('high', 'claude-fable-5')).toEqual({
      effort: 'high',
      model: 'claude-fable-5',
    });
    expect(sanitizeLaunchPins('high', 'claude-fable-5')).toEqual({
      effort: 'high',
      model: 'claude-fable-5',
    });
    expect(sanitizeLaunchPins('high', 'claude-fable-5')).toEqual({
      effort: 'high',
      model: 'claude-fable-5',
    });
  });

  test('shape-invalid values become Agent default', () => {
    expect(sanitizeLaunchPins('turbo', 'not-a-model')).toEqual({
      effort: 'turbo',
      model: 'not-a-model',
    });
  });

  test('custom pins survive agent changes', () => {
    expect(sanitizeLaunchPins('ultra', 'claude-fable-5')).toEqual({
      effort: 'ultra',
      model: 'claude-fable-5',
    });
  });
});

describe('restoreLastLaunchPins', () => {
  afterEach(() => {
    localStorage.clear();
  });

  test('restores stored pins the agent accepts', () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'max');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-sonnet-5');
    expect(restoreLastLaunchPins()).toEqual({
      effort: 'max',
      model: 'claude-sonnet-5',
    });
  });

  test('keeps stored pins available for custom harness values', () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'high');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');
    expect(restoreLastLaunchPins()).toEqual({ effort: 'high', model: 'claude-fable-5' });
  });

  test('drops a stored Codex-only effort when restoring for Claude', () => {
    localStorage.setItem(LAST_EFFORT_KEY, 'ultra');
    localStorage.setItem(LAST_MODEL_KEY, 'claude-fable-5');
    expect(restoreLastLaunchPins()).toEqual({ effort: 'ultra', model: 'claude-fable-5' });
  });

  test('returns Agent default when nothing is stored', () => {
    expect(restoreLastLaunchPins()).toEqual({
      effort: '',
      model: '',
    });
  });
});
