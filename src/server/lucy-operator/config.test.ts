import { describe, expect, test } from 'vitest';
import { DEFAULT_BASETEN_MODEL } from '../../adapters/llm/baseten-chat-stream.js';
import { DEFAULT_LUCY_OPERATOR_MODEL, DEFAULT_LUCY_OPERATOR_PROVIDERS, resolveLucyOperatorConfig } from './config.js';

const KEY = { KOOKR_OPENROUTER_API_KEY: 'sk-or-key' };
const BT = { KOOKR_BASETEN_API_KEY: 'bt-key' };

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
      provider: 'openrouter',
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

  test('switched on without any key: unavailable, with a reason that names both keys', () => {
    expect(resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR: 'true', KOOKR_OPENROUTER_API_KEY: '   ' })).toEqual({
      enabled: true,
      ok: false,
      reason: 'Lucy\'s conversation needs a Baseten key (KOOKR_BASETEN_API_KEY or BASETEN_API_KEY) or an OpenRouter key (KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).',
      warnings: [],
    });
  });

  test('with an OpenRouter key alone the provider is OpenRouter', () => {
    expect(resolveLucyOperatorConfig({ ...KEY })).toMatchObject({ ok: true, provider: 'openrouter', model: { apiKey: 'sk-or-key', model: DEFAULT_LUCY_OPERATOR_MODEL } });
  });
});

describe('resolveLucyOperatorConfig: the service (Baseten or OpenRouter)', () => {
  test('a Baseten key alone turns it on, on Baseten, with the shared default model and level', () => {
    expect(resolveLucyOperatorConfig({ ...BT })).toEqual({
      enabled: true,
      ok: true,
      provider: 'baseten',
      launch: true,
      warnings: [],
      model: { apiKey: 'bt-key', model: 'deepseek-ai/DeepSeek-V4.1-Flash-Fast', baseUrl: 'https://inference.baseten.co/v1', reasoningEffort: 'medium' },
    });
    expect(DEFAULT_BASETEN_MODEL).toBe('deepseek-ai/DeepSeek-V4.1-Flash-Fast');
  });

  test('both keys, nothing chosen: Baseten wins', () => {
    expect(resolveLucyOperatorConfig({ ...BT, ...KEY })).toMatchObject({ provider: 'baseten', model: { apiKey: 'bt-key' } });
  });

  test('BASETEN_API_KEY is read when the Kookr-scoped one is absent, and the Kookr one wins when both are set', () => {
    expect(resolveLucyOperatorConfig({ BASETEN_API_KEY: 'plain' })).toMatchObject({ provider: 'baseten', model: { apiKey: 'plain' } });
    expect(resolveLucyOperatorConfig({ BASETEN_API_KEY: 'plain', KOOKR_BASETEN_API_KEY: 'scoped' })).toMatchObject({ model: { apiKey: 'scoped' } });
  });

  test('both keys with openrouter chosen: OpenRouter, and the provider list applies', () => {
    expect(resolveLucyOperatorConfig({ ...BT, ...KEY, KOOKR_LUCY_OPERATOR_PROVIDER: ' OpenRouter ', KOOKR_LUCY_OPERATOR_PROVIDERS: 'novita' }))
      .toMatchObject({ provider: 'openrouter', warnings: [], model: { apiKey: 'sk-or-key', providers: ['novita'] } });
  });

  test('both keys with baseten chosen: Baseten', () => {
    expect(resolveLucyOperatorConfig({ ...BT, ...KEY, KOOKR_LUCY_OPERATOR_PROVIDER: 'baseten' })).toMatchObject({ provider: 'baseten' });
  });

  test('openrouter chosen with only a Baseten key: unavailable, naming the missing key (even with the switch unset)', () => {
    const result = resolveLucyOperatorConfig({ ...BT, KOOKR_LUCY_OPERATOR_PROVIDER: 'openrouter' });
    expect(result).toMatchObject({ enabled: true, ok: false });
    expect(result.enabled && !result.ok && result.reason).toBe('Lucy\'s conversation is set to use OpenRouter and needs an OpenRouter key (set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).');
  });

  test('baseten chosen with only an OpenRouter key: unavailable, naming the missing key', () => {
    const result = resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR_PROVIDER: 'baseten' });
    expect(result.enabled && !result.ok && result.reason).toBe('Lucy\'s conversation is set to use Baseten and needs a Baseten key (set KOOKR_BASETEN_API_KEY or BASETEN_API_KEY).');
  });

  test('neither key: quietly off when unset, unavailable naming both keys when asked for', () => {
    expect(resolveLucyOperatorConfig({})).toEqual({ enabled: false });
    const result = resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR: 'true' });
    expect(result.enabled && !result.ok && result.reason).toMatch(/Baseten key \(KOOKR_BASETEN_API_KEY or BASETEN_API_KEY\) or an OpenRouter key/);
  });

  test('an unknown service value warns once and falls back to the key rule', () => {
    const both = resolveLucyOperatorConfig({ ...BT, ...KEY, KOOKR_LUCY_OPERATOR_PROVIDER: 'together' });
    expect(both).toMatchObject({ provider: 'baseten' });
    expect(both.enabled && both.warnings).toEqual([expect.stringMatching(/KOOKR_LUCY_OPERATOR_PROVIDER="together" is not one of baseten, openrouter/)]);
    expect(resolveLucyOperatorConfig({ ...KEY, KOOKR_LUCY_OPERATOR_PROVIDER: 'together' })).toMatchObject({ provider: 'openrouter' });
    expect(resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR_PROVIDER: 'together' })).toEqual({ enabled: false });
  });

  test('on Baseten the model setting wins, then Lucy live\'s Baseten model and address, then the default', () => {
    expect(resolveLucyOperatorConfig({ ...BT, KOOKR_BASETEN_MODEL: 'live/model', KOOKR_BASETEN_BASE_URL: 'https://bt.example/v1' }))
      .toMatchObject({ model: { model: 'live/model', baseUrl: 'https://bt.example/v1' } });
    expect(resolveLucyOperatorConfig({ ...BT, KOOKR_BASETEN_MODEL: 'live/model', KOOKR_LUCY_OPERATOR_MODEL: 'op/model' })).toMatchObject({ model: { model: 'op/model' } });
  });

  test('on Baseten the reasoning setting becomes the named level, and none is Baseten\'s own off level', () => {
    expect(resolveLucyOperatorConfig({ ...BT, KOOKR_LUCY_OPERATOR_REASONING: 'High' })).toMatchObject({ model: { reasoningEffort: 'high' } });
    expect(resolveLucyOperatorConfig({ ...BT, KOOKR_LUCY_OPERATOR_REASONING: 'none' })).toMatchObject({ model: { reasoningEffort: 'none' } });
  });

  test('on Baseten the OpenRouter provider list is ignored with a note', () => {
    const result = resolveLucyOperatorConfig({ ...BT, KOOKR_LUCY_OPERATOR_PROVIDERS: 'deepinfra/fp8' });
    expect(result).toMatchObject({ provider: 'baseten' });
    expect(result.enabled && result.warnings).toEqual(['KOOKR_LUCY_OPERATOR_PROVIDERS only applies to OpenRouter and is ignored on Baseten.']);
    expect(result.enabled && result.ok && result.model).not.toHaveProperty('providers');
  });

  test('the kill switch still wins over both keys', () => {
    expect(resolveLucyOperatorConfig({ ...BT, ...KEY, KOOKR_LUCY_OPERATOR: 'off' })).toEqual({ enabled: false });
  });

  test.each([
    ['baseten', /Baseten key \(set KOOKR_BASETEN_API_KEY or BASETEN_API_KEY\)/],
    ['openrouter', /OpenRouter key \(set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY\)/],
  ])('a service named with no key at all (switch unset) is unavailable and names that service\'s key: %s', (name, reason) => {
    const result = resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR_PROVIDER: name });
    expect(result).toMatchObject({ enabled: true, ok: false });
    expect(result.enabled && !result.ok && result.reason).toMatch(reason);
    const asked = resolveLucyOperatorConfig({ KOOKR_LUCY_OPERATOR_PROVIDER: name, KOOKR_LUCY_OPERATOR: 'true' });
    expect(asked.enabled && !asked.ok && asked.reason).toMatch(reason);
  });

  describe('an install that already runs on OpenRouter stays there (upgrade trap)', () => {
    const BOTH = { ...BT, ...KEY };
    test.each([
      ['the OpenRouter default model is set', { KOOKR_LUCY_OPERATOR_MODEL: 'deepseek/deepseek-v4.1-flash-1017' }],
      ['an OpenRouter provider list is set', { KOOKR_LUCY_OPERATOR_PROVIDERS: 'deepinfra/fp8' }],
    ])('both keys, service not chosen, %s: OpenRouter, with one note', (_name, extra) => {
      const result = resolveLucyOperatorConfig({ ...BOTH, ...extra });
      expect(result).toMatchObject({ ok: true, provider: 'openrouter', model: { apiKey: 'sk-or-key' } });
      expect(result.enabled && result.warnings).toEqual([expect.stringMatching(/^Keeping Lucy's conversation on OpenRouter because .*KOOKR_LUCY_OPERATOR_PROVIDER=baseten/)]);
    });

    test('naming Baseten overrides it', () => {
      expect(resolveLucyOperatorConfig({ ...BOTH, KOOKR_LUCY_OPERATOR_MODEL: 'deepseek/deepseek-v4.1-flash-1017', KOOKR_LUCY_OPERATOR_PROVIDER: 'baseten' })).toMatchObject({ provider: 'baseten' });
    });

    test('a Baseten key alone, or another model id, still means Baseten', () => {
      expect(resolveLucyOperatorConfig({ ...BT, KOOKR_LUCY_OPERATOR_MODEL: 'deepseek/deepseek-v4.1-flash-1017' })).toMatchObject({ provider: 'baseten' });
      expect(resolveLucyOperatorConfig({ ...BOTH, KOOKR_LUCY_OPERATOR_MODEL: 'deepseek-ai/DeepSeek-V4.1-Flash-Fast' })).toMatchObject({ provider: 'baseten', warnings: [] });
    });
  });
});
