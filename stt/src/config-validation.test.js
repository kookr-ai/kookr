/**
 * Tests for the STT `config` control-message validation helper.
 */

import { describe, test, expect } from 'vitest';
import {
  normalizeConfigMessage,
  DEFAULT_SUPPORTED_LANGUAGES,
} from './config-validation.js';

describe('normalizeConfigMessage', () => {
  test('accepts a supported language different from the current one', () => {
    // current !== accepted so the test proves the override path, not a no-op.
    const out = normalizeConfigMessage(
      { language: 'es' },
      { currentLanguage: 'en', supportedLanguages: ['en', 'es'] },
    );
    expect(out.language).toBe('es');
  });

  test('clamps an unsupported language to the default, not the current value', () => {
    // current ('es') differs from default ('en'): fallback must target default.
    const out = normalizeConfigMessage(
      { language: 'zz' },
      { currentLanguage: 'es', defaultLanguage: 'en', supportedLanguages: ['en', 'es'] },
    );
    expect(out.language).toBe('en');
  });

  test('clamps a non-string language back to the default', () => {
    const out = normalizeConfigMessage(
      { language: 42 },
      { currentLanguage: 'en', defaultLanguage: 'en', supportedLanguages: ['en'] },
    );
    expect(out.language).toBe('en');
  });

  test('coerces a non-boolean progressive to the default, not the current value', () => {
    // The string "false" is truthy — the exact bug this guards against. current
    // (false) differs from default (true): fallback must target default.
    const out = normalizeConfigMessage(
      { progressive: 'false' },
      { currentProgressive: false, defaultProgressive: true },
    );
    expect(out.progressive).toBe(true);
  });

  test('accepts a real boolean progressive', () => {
    const out = normalizeConfigMessage(
      { progressive: false },
      { currentProgressive: true, defaultProgressive: true },
    );
    expect(out.progressive).toBe(false);
  });

  test('preserves current values when a field is absent', () => {
    const out = normalizeConfigMessage(
      {},
      { currentLanguage: 'es', currentProgressive: false, supportedLanguages: ['en', 'es'] },
    );
    expect(out).toEqual({ language: 'es', progressive: false });
  });

  test('falls back to defaults when no current value is supplied', () => {
    const out = normalizeConfigMessage({}, {});
    expect(out).toEqual({ language: 'en', progressive: true });
  });

  test('returns pure defaults for a non-object message', () => {
    for (const bad of [null, undefined, 'config', 42]) {
      const out = normalizeConfigMessage(bad, {
        defaultLanguage: 'en',
        defaultProgressive: true,
      });
      expect(out).toEqual({ language: 'en', progressive: true });
    }
  });

  test('DEFAULT_SUPPORTED_LANGUAGES contains en', () => {
    expect(DEFAULT_SUPPORTED_LANGUAGES).toContain('en');
  });
});
