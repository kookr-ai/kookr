import { describe, test, expect } from 'vitest';
import type { PlaybookParameter } from '../../core/playbook.js';
import { mergeParamDefaults } from './playbook-params.js';

describe('mergeParamDefaults', () => {
  const textParam = (name: string, defaultVal?: string): PlaybookParameter => ({
    name,
    description: `${name} description`,
    required: true,
    default: defaultVal,
  });

  const selectParam = (
    name: string,
    options: Array<{ label: string; value: string }>,
    defaultVal?: string,
  ): PlaybookParameter => ({
    name,
    description: `${name} description`,
    required: true,
    type: 'select',
    options,
    default: defaultVal,
  });

  test('null snapshot returns all defaults', () => {
    const params = [textParam('repo', 'https://example.com'), textParam('branch', 'main')];
    expect(mergeParamDefaults(params, null)).toEqual({
      repo: 'https://example.com',
      branch: 'main',
    });
  });

  test('snapshot value wins over default for text params', () => {
    const params = [textParam('repo', 'https://default.com')];
    const snapshot = { repo: 'https://custom.com' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'https://custom.com',
    });
  });

  test('new parameter not in snapshot gets its default', () => {
    const params = [textParam('repo', 'https://default.com'), textParam('branch', 'main')];
    const snapshot = { repo: 'https://custom.com' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'https://custom.com',
      branch: 'main',
    });
  });

  test('removed parameter in snapshot but not in schema is ignored', () => {
    const params = [textParam('repo', 'https://default.com')];
    const snapshot = { repo: 'https://custom.com', oldParam: 'stale-value' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'https://custom.com',
    });
  });

  test('select param with valid stored value is used', () => {
    const options = [
      { label: 'High', value: 'high' },
      { label: 'Low', value: 'low' },
    ];
    const params = [selectParam('priority', options, 'low')];
    const snapshot = { priority: 'high' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      priority: 'high',
    });
  });

  test('select param with invalid stored value falls back to default', () => {
    const options = [
      { label: 'High', value: 'high' },
      { label: 'Low', value: 'low' },
    ];
    const params = [selectParam('priority', options, 'low')];
    const snapshot = { priority: 'removed-option' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      priority: 'low',
    });
  });

  test('select param with invalid stored value and no default returns empty string', () => {
    const options = [{ label: 'A', value: 'a' }];
    const params = [selectParam('choice', options)];
    const snapshot = { choice: 'gone' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      choice: '',
    });
  });

  test('stored empty string is preserved (user intentionally cleared)', () => {
    const params = [textParam('repo', 'https://default.com')];
    const snapshot = { repo: '' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: '',
    });
  });

  test('parameter with no default and no snapshot returns empty string', () => {
    const params = [textParam('notes')];
    expect(mergeParamDefaults(params, null)).toEqual({
      notes: '',
    });
  });

  test('falsy default "0" is correctly used (not dropped by truthiness check)', () => {
    const params = [textParam('count', '0')];
    expect(mergeParamDefaults(params, null)).toEqual({
      count: '0',
    });
  });

  test('falsy default "" is correctly used', () => {
    const params = [textParam('notes', '')];
    expect(mergeParamDefaults(params, null)).toEqual({
      notes: '',
    });
  });

  test('handles mix of text and select params with partial snapshot', () => {
    const options = [
      { label: 'Dev', value: 'dev' },
      { label: 'Prod', value: 'prod' },
    ];
    const params = [
      textParam('repo', 'https://github.com/org/repo'),
      selectParam('env', options, 'dev'),
      textParam('branch', 'main'),
    ];
    const snapshot = { repo: 'https://github.com/org/other', env: 'prod' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'https://github.com/org/other',
      env: 'prod',
      branch: 'main',
    });
  });

  test('select with source skips static options validation for stored value', () => {
    // When a param has `source`, options are resolved dynamically at render time.
    // Stored values from dynamic sources should not be rejected by static validation.
    const staticOptions = [{ label: 'Fallback', value: 'fallback/repo' }];
    const params: PlaybookParameter[] = [{
      name: 'repo',
      description: 'Repo',
      required: true,
      type: 'select',
      options: staticOptions,
      source: 'tracked-projects',
    }];
    const snapshot = { repo: 'grafana/grafana' }; // not in static options
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'grafana/grafana', // preserved, not rejected
    });
  });

  test('select with source and no static options preserves stored value', () => {
    const params: PlaybookParameter[] = [{
      name: 'repo',
      description: 'Repo',
      required: true,
      type: 'select',
      source: 'tracked-projects',
    }];
    const snapshot = { repo: 'microsoft/vscode' };
    expect(mergeParamDefaults(params, snapshot)).toEqual({
      repo: 'microsoft/vscode',
    });
  });
});
