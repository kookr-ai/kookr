import { describe, expect, test } from 'vitest';
import { DEFAULT_LUCY_OPERATOR_MODEL, resolveLucyOperatorConfig } from './config.js';

const KEY = { KOOKR_OPENROUTER_API_KEY: 'sk-or-key' };

describe('resolveLucyOperatorConfig', () => {
  test.each([[undefined], [''], ['false'], ['0'], ['maybe']])('is off when KOOKR_LUCY_OPERATOR is %j, even with a key', (value) => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: value })).toEqual({ enabled: false });
  });

  test('defaults to the model, providers and reasoning level chosen in the trial', () => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true' })).toEqual({
      enabled: true,
      ok: true,
      launch: false,
      warnings: [],
      model: {
        apiKey: 'sk-or-key',
        model: 'deepseek/deepseek-v4.1-flash-1017',
        baseUrl: 'https://openrouter.ai/api/v1',
        providers: ['cohere/fp8', 'deepinfra/fp8'],
        reasoning: 'medium',
        appTitle: 'Kookr',
      },
    });
    expect(DEFAULT_LUCY_OPERATOR_MODEL).toBe('deepseek/deepseek-v4.1-flash-1017');
  });

  test('launching is a second switch, off unless KOOKR_LUCY_LAUNCH is true', () => {
    const on = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_LAUNCH: 'true' });
    expect(on).toMatchObject({ enabled: true, ok: true, launch: true });
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_LAUNCH: 'no' })).toMatchObject({ launch: false });
    // Launching without the conversation is off: there is no loop to propose from.
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_LAUNCH: 'true' })).toEqual({ enabled: false });
  });

  test('each of the three is a setting', () => {
    const result = resolveLucyOperatorConfig({
      KOOKR_LUCY_OPERATOR: 'TRUE',
      OPENROUTER_API_KEY: 'fallback-key',
      KOOKR_LUCY_OPERATOR_MODEL: 'anthropic/claude-haiku-5.5',
      KOOKR_LUCY_OPERATOR_PROVIDERS: ' DeepInfra/fp8 , cohere/fp8 ,deepinfra/fp8',
      KOOKR_LUCY_OPERATOR_REASONING: 'Low',
    });
    expect(result).toMatchObject({
      ok: true,
      warnings: [],
      model: { apiKey: 'fallback-key', model: 'anthropic/claude-haiku-5.5', providers: ['deepinfra/fp8', 'cohere/fp8'], reasoning: 'low' },
    });
  });

  test.each([['any'], ['AUTO']])('KOOKR_LUCY_OPERATOR_PROVIDERS=%s lifts the provider restriction', (value) => {
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_PROVIDERS: value })).toMatchObject({ model: { providers: [] } });
  });

  test('an unknown reasoning level is ignored with a warning instead of failing every turn', () => {
    const result = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_REASONING: 'ultra' });
    expect(result).toMatchObject({ ok: true, model: { reasoning: 'medium' } });
    expect(result.enabled && result.warnings[0]).toMatch(/KOOKR_LUCY_OPERATOR_REASONING="ultra" is not one of none, low, medium, high; using medium/);
  });

  test.each([['cohere fp8'], ['https://evil.example'], [','], ['cohere/fp8,{"order":1}']])('a malformed provider list %j falls back to the default with a warning', (value) => {
    const result = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR: 'true', KOOKR_LUCY_OPERATOR_PROVIDERS: value });
    expect(result).toMatchObject({ ok: true, model: { providers: ['cohere/fp8', 'deepinfra/fp8'] } });
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
