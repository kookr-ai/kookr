import { describe, expect, test } from 'vitest';
import {
  dashboardTaskUrl,
  parseDashboardTaskId,
  stripDashboardTaskQuery,
} from './dashboard-task-url.js';

describe('dashboardTaskUrl', () => {
  test('appends ?task= to a bare origin', () => {
    expect(dashboardTaskUrl('http://127.0.0.1:4801', 'task-99')).toBe(
      'http://127.0.0.1:4801/?task=task-99',
    );
  });

  test('strips a trailing slash on the base and encodes the id', () => {
    expect(dashboardTaskUrl('https://kookr.example.com/kookr/', 'a b')).toBe(
      'https://kookr.example.com/kookr/?task=a%20b',
    );
  });

  test('parseDashboardTaskId decodes the value that dashboardTaskUrl encoded', () => {
    const href = dashboardTaskUrl('http://127.0.0.1:4801', 'a b');
    expect(parseDashboardTaskId(new URL(href).search)).toBe('a b');
  });
});

describe('parseDashboardTaskId', () => {
  test('reads task from a leading-? search string', () => {
    expect(parseDashboardTaskId('?task=task-99&debug=1')).toBe('task-99');
  });

  test('reads task without a leading ?', () => {
    expect(parseDashboardTaskId('task=task-99')).toBe('task-99');
  });

  test('returns null when task is missing, empty, or whitespace', () => {
    expect(parseDashboardTaskId('')).toBeNull();
    expect(parseDashboardTaskId('?debug=1')).toBeNull();
    expect(parseDashboardTaskId('?task=')).toBeNull();
    expect(parseDashboardTaskId('?task=%20%20')).toBeNull();
  });
});

describe('stripDashboardTaskQuery', () => {
  test('removes only the task param and keeps siblings plus the hash', () => {
    expect(stripDashboardTaskQuery('/?task=task-99&debug=1#pane')).toBe('/?debug=1#pane');
  });

  test('drops the ? when task was the only param', () => {
    expect(stripDashboardTaskQuery('/?task=task-99')).toBe('/');
  });

  test('leaves a URL without task unchanged', () => {
    expect(stripDashboardTaskQuery('/?debug=1')).toBe('/?debug=1');
  });
});
