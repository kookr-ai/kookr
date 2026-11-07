import { describe, test, expect } from 'vitest';
import {
  defaultAutoUpdate,
  effectiveAutoUpdate,
  effectiveAutoUpdateForPlugin,
  detectExternalChanges,
} from './defaults.js';

describe('autoUpdate defaults', () => {
  test('official / claude.ai marketplaces default ON', () => {
    expect(defaultAutoUpdate('claude')).toBe(true);
    expect(defaultAutoUpdate('claude.ai')).toBe(true);
    expect(defaultAutoUpdate('anthropic-plugin-directory')).toBe(true);
    expect(defaultAutoUpdate('claude-plugins-official')).toBe(true);
  });
  test('third-party marketplaces default OFF', () => {
    expect(defaultAutoUpdate('kookr')).toBe(false);
    expect(defaultAutoUpdate('claude-code-plugins')).toBe(false);
    expect(defaultAutoUpdate('some-random-mkt')).toBe(false);
  });
  test('explicit flag overrides the default', () => {
    expect(effectiveAutoUpdate('kookr', true)).toBe(true);
    expect(effectiveAutoUpdate('anthropic', false)).toBe(false);
    expect(effectiveAutoUpdate('kookr', undefined)).toBe(false);
  });
  test('per-plugin id resolves its marketplace (no marketplace ⇒ OFF default)', () => {
    expect(effectiveAutoUpdateForPlugin('x@anthropic', undefined)).toBe(true);
    expect(effectiveAutoUpdateForPlugin('x@kookr', undefined)).toBe(false);
    expect(effectiveAutoUpdateForPlugin('bare-id', undefined)).toBe(false);
    expect(effectiveAutoUpdateForPlugin('bare-id', true)).toBe(true);
  });
});

describe('detectExternalChanges', () => {
  const now = '2026-02-02T00:00:00.000Z';

  test('a version move with no Kookr action is an external change', () => {
    const changes = detectExternalChanges(
      { 'a@m': '1.0.0' },
      new Map([['a@m', '1.1.0']]),
      { now },
    );
    expect(changes).toEqual([{ pluginId: 'a@m', fromVersion: '1.0.0', toVersion: '1.1.0', detectedAt: now }]);
  });

  test('a first observation is a baseline, NOT a change', () => {
    expect(detectExternalChanges({}, new Map([['a@m', '1.0.0']]), { now })).toEqual([]);
  });

  test('an unchanged version is not reported', () => {
    expect(detectExternalChanges({ 'a@m': '1.0.0' }, new Map([['a@m', '1.0.0']]), { now })).toEqual([]);
  });

  test('a change Kookr itself made is excluded', () => {
    const changes = detectExternalChanges(
      { 'a@m': '1.0.0' },
      new Map([['a@m', '1.1.0']]),
      { now, kookrChanged: new Set(['a@m']) },
    );
    expect(changes).toEqual([]);
  });

  test('null transitions are detected and sorted by id', () => {
    const changes = detectExternalChanges(
      { 'b@m': '2.0.0', 'a@m': null },
      new Map([
        ['b@m', null],
        ['a@m', '3.0.0'],
      ]),
      { now },
    );
    expect(changes.map((c) => c.pluginId)).toEqual(['a@m', 'b@m']);
    expect(changes[0]).toEqual({ pluginId: 'a@m', fromVersion: null, toVersion: '3.0.0', detectedAt: now });
    expect(changes[1]).toEqual({ pluginId: 'b@m', fromVersion: '2.0.0', toVersion: null, detectedAt: now });
  });
});
