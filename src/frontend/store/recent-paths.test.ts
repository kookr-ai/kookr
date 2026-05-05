import { describe, test, expect, beforeEach } from 'vitest';
import { RecentPaths } from './recent-paths.js';

describe('RecentPaths', () => {
  let storage: Map<string, string>;
  let recentPaths: RecentPaths;

  beforeEach(() => {
    // Fake localStorage
    storage = new Map();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    };
    recentPaths = new RecentPaths(fakeStorage as Storage);
  });

  test('starts empty', () => {
    expect(recentPaths.getAll()).toEqual([]);
  });

  test('add stores a path', () => {
    recentPaths.add('/home/user/project');

    expect(recentPaths.getAll()).toEqual(['/home/user/project']);
  });

  test('most recently added path is first', () => {
    recentPaths.add('/path/a');
    recentPaths.add('/path/b');

    expect(recentPaths.getAll()).toEqual(['/path/b', '/path/a']);
  });

  test('re-adding existing path moves it to front', () => {
    recentPaths.add('/path/a');
    recentPaths.add('/path/b');
    recentPaths.add('/path/a');

    expect(recentPaths.getAll()).toEqual(['/path/a', '/path/b']);
  });

  test('limits to max entries (default 10)', () => {
    for (let i = 0; i < 12; i++) {
      recentPaths.add(`/path/${i}`);
    }

    const all = recentPaths.getAll();
    expect(all).toHaveLength(10);
    expect(all[0]).toBe('/path/11');
    expect(all[9]).toBe('/path/2');
  });

  test('persists to storage', () => {
    recentPaths.add('/path/a');

    const raw = storage.get('kookr:recentPaths');
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(['/path/a']);
  });

  test('loads from storage on construction', () => {
    storage.set('kookr:recentPaths', JSON.stringify(['/path/a', '/path/b']));

    const fresh = new RecentPaths({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as Storage);

    expect(fresh.getAll()).toEqual(['/path/a', '/path/b']);
  });

  test('handles corrupted storage gracefully', () => {
    storage.set('kookr:recentPaths', 'not-json');

    const fresh = new RecentPaths({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as Storage);

    expect(fresh.getAll()).toEqual([]);
  });

  test('filter returns matching paths (case-insensitive)', () => {
    recentPaths.add('/home/user/project-alpha');
    recentPaths.add('/home/user/project-beta');
    recentPaths.add('/var/log');

    expect(recentPaths.filter('project')).toEqual([
      '/home/user/project-beta',
      '/home/user/project-alpha',
    ]);
  });

  test('filter with empty string returns all', () => {
    recentPaths.add('/path/a');
    recentPaths.add('/path/b');

    expect(recentPaths.filter('')).toEqual(['/path/b', '/path/a']);
  });

  test('ignores empty or whitespace-only paths', () => {
    recentPaths.add('');
    recentPaths.add('   ');

    expect(recentPaths.getAll()).toEqual([]);
  });
});
