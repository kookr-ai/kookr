import { describe, expect, test } from 'vitest';
import { DEFAULT_LUCY_OPERATOR_MODEL, DEFAULT_LUCY_OPERATOR_PROVIDERS, resolveLucyOperatorConfig } from './config.js';

const KEY = { KOOKR_OPENROUTER_API_KEY: 'sk-or-key' };

describe('resolveLucyOperatorConfig', () => {
  test.each([['false'], ['0'], ['off'], ['no'], [' OFF ']])('is off when KOOKR_LUCY_OPERATOR is the kill switch %j, even with a key', (value) => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: value })).toEqual({ enabled: false });
  });

  // Issue #3937: on by default, turning itself on where the OpenRouter key is present.
  test.each([[undefined], ['']])('is on when KOOKR_LUCY_OPERATOR is %j and a key is present', (value) => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: value })).toMatchObject({ enabled: true, ok: true, launch: true });
  });

  test.each([[undefined], ['']])('stays quietly off when KOOKR_LUCY_OPERATOR is %j and there is no key', (value) => {
    expect(resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR: value })).toEqual({ enabled: false });
  });

  test('asked for explicitly without a key, it is on but unavailable (the route answers 503)', () => {
    expect(resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR: 'true' })).toMatchObject({ enabled: true, ok: false });
  });

  test('defaults to the trial\'s model and reasoning level, with no provider pinned', () => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true' })).toEqual({
      enabled: true,
      ok: true,
      launch: true,
      warnings: [],
      model: {
        apiKey: 'sk-or-key',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        baseUrl: 'https://openrouter.ai/api/v1',
        providers: [],
        reasoning: 'medium',
        appTitle: 'Kookr',
      },
    });
    expect(DEFAULT_LUCY_OPERATOR_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017');
    expect(DEFAULT_LUCY_OPERATOR_PROVIDERS).toEqual([]);
  });

  test('launching is a second switch, on by default and off when KOOKR_LUCY_LAUNCH is the kill switch', () => {
    expect(resolveLucyOperatorConfig({ ...KEY })).toMatchObject({ enabled: true, ok: true, launch: true });
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_LAUNCH: 'true' })).toMatchObject({ launch: true });
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_LAUNCH: off })).toMatchObject({ launch: false });
    }
    // Launching without the conversation is off: there is no loop to propose from.
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: '0', KOOKR_LUCY_LAUNCH: 'true' })).toEqual({ enabled: false });
  });

  test('each of the three is a setting', () => {
    const result = resolveLucyOperatorConfig({
      KOOKR_LUCY_OPERATOR: 'TRUE',
      OPENROUTER_API_KEY: 'fallback-key',
      KOOKR_LUCY_OPERATOR_MODEL: 'anthropic/claude-haiku-5.5',
      KOOKR_LUCY_OPERATOR_PROVIDERS: ' DeepInfra/fp8 , novita ,deepinfra/fp8',
      KOOKR_LUCY_OPERATOR_REASONING: 'Low',
    });
    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      model: { apiKey: 'fallback-key', model: 'anthropic/claude-haiku-5.5', providers: ['deepinfra/fp8', 'novita'], reasoning: 'low' },
    });
  });

  test.each([['any'], ['AUTO'], ['  ']])('KOOKR_LUCY_OPERATOR_PROVIDERS=%j pins no provider', (value) => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_PROVIDERS: value })).toMatchObject({ model: { providers: [] } });
  });

  test('an unknown reasoning level is ignored with a warning instead of failing every turn', () => {
    const result = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_REASONING: 'ultra' });
    expect(result).toMatchObject({ ok: true, model: { reasoning: 'medium' } });
    expect(result.enabled && result.warnings[0]).toMatch(/KOOKR_LUCY_OPERATOR_REASONING="ultra" is not one of none, low, medium, high; using medium/);
  });

  test.each([['deepinfra fp8'], ['https://evil.example'], [','], ['deepinfra/fp8,{"order":1}']])('a malformed provider list %j falls back to no pinned provider with a warning', (value) => {
    const result = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_PROVIDERS: value });
    expect(result).toMatchObject({ ok: true, model: { providers: [] } });
    expect(result.enabled && result.warnings).toHaveLength(1);
  });

  test('switched on without a key: unavailable, with a reason that names the setting', () => {
    expect(resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR: 'true', KOOKR_OPENROUTER_API_KEY: '   ' })).toEqual({
      enabled: true,
      ok: false,
      reason: 'Lucy\'s conversation needs an OpenRouter key (set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).',
      warnings: [],
    });
  });
});
