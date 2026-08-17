import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  PlaybookUsageTracker,
  matchesUsageKey,
  resolveRecentPlaybookLabel,
  snapshotKey,
  usageKeyPlaybookId,
} from './playbook-usage.js';

function fakeStorage(data?: Map<string, string>) {
  const storage = data ?? new Map<string, string>();
  return {
    map: storage,
    impl: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as Pick<Storage, 'getItem' | 'setItem'>,
  };
}

describe('snapshotKey / matchesUsageKey', () => {
  test('snapshotKey is sourceCwd::playbookId', () => {
    expect(snapshotKey('deploy.md', '/project-a')).toBe('/project-a::deploy.md');
  });

  test('matchesUsageKey accepts composite and bare legacy ids', () => {
    expect(matchesUsageKey('/project-a::deploy.md', 'deploy.md', '/project-a')).toBe(true);
    expect(matchesUsageKey('deploy.md', 'deploy.md', '/project-a')).toBe(true);
    expect(matchesUsageKey('/project-b::deploy.md', 'deploy.md', '/project-a')).toBe(false);
    expect(matchesUsageKey('other.md', 'deploy.md', '/project-a')).toBe(false);
  });

  test('usageKeyPlaybookId reads the id from composite and legacy keys', () => {
    expect(usageKeyPlaybookId('/project-a::deploy.md')).toBe('deploy.md');
    expect(usageKeyPlaybookId('deploy.md')).toBe('deploy.md');
  });

  test('resolveRecentPlaybookLabel prefers a catalog name, else the file stem', () => {
    const playbooks = [
      { id: 'deploy.md', sourceCwd: '/project-a', name: 'Deploy to prod' },
    ];
    expect(resolveRecentPlaybookLabel('/project-a::deploy.md', playbooks)).toBe('Deploy to prod');
    expect(resolveRecentPlaybookLabel('deploy.md', playbooks)).toBe('Deploy to prod');
    expect(resolveRecentPlaybookLabel('/other::review.md', playbooks)).toBe('review');
    expect(resolveRecentPlaybookLabel('review.md', [])).toBe('review');
  });
});

describe('PlaybookUsageTracker — pin and recent (composite keys)', () => {
  let storage: ReturnType<typeof fakeStorage>;
  let tracker: PlaybookUsageTracker;

  beforeEach(() => {
    storage = fakeStorage();
    tracker = new PlaybookUsageTracker(storage.impl);
  });

  test('recordLaunch stores composite key and isolates by sourceCwd', () => {
    tracker.recordLaunch('deploy.md', '/project-a');
    tracker.recordLaunch('deploy.md', '/project-b');

    expect(tracker.getRecent()).toEqual([
      '/project-b::deploy.md',
      '/project-a::deploy.md',
    ]);
    expect(tracker.recentIndex('deploy.md', '/project-a')).toBe(1);
    expect(tracker.recentIndex('deploy.md', '/project-b')).toBe(0);
  });

  test('recordLaunch re-launch moves entry to front without duplicates', () => {
    tracker.recordLaunch('a.md', '/p');
    tracker.recordLaunch('b.md', '/p');
    tracker.recordLaunch('a.md', '/p');

    expect(tracker.getRecent()).toEqual(['/p::a.md', '/p::b.md']);
  });

  test('togglePin / isPinned isolate by sourceCwd', () => {
    expect(tracker.togglePin('deploy.md', '/project-a')).toBe(true);
    expect(tracker.isPinned('deploy.md', '/project-a')).toBe(true);
    expect(tracker.isPinned('deploy.md', '/project-b')).toBe(false);

    expect(tracker.togglePin('deploy.md', '/project-b')).toBe(true);
    expect(tracker.isPinned('deploy.md', '/project-a')).toBe(true);
    expect(tracker.isPinned('deploy.md', '/project-b')).toBe(true);

    expect(tracker.togglePin('deploy.md', '/project-a')).toBe(false);
    expect(tracker.isPinned('deploy.md', '/project-a')).toBe(false);
    expect(tracker.isPinned('deploy.md', '/project-b')).toBe(true);

    expect(tracker.getPinned()).toEqual(new Set(['/project-b::deploy.md']));
  });

  test('legacy bare-id pin still matches until rewritten on toggle', () => {
    storage.map.set('kookr:pinnedPlaybooks', JSON.stringify(['deploy.md']));
    const legacy = new PlaybookUsageTracker(storage.impl);

    expect(legacy.isPinned('deploy.md', '/project-a')).toBe(true);
    expect(legacy.isPinned('deploy.md', '/project-b')).toBe(true);

    // Toggle on project-a consumes the bare id (unpin)
    expect(legacy.togglePin('deploy.md', '/project-a')).toBe(false);
    expect(legacy.isPinned('deploy.md', '/project-a')).toBe(false);
    expect(legacy.isPinned('deploy.md', '/project-b')).toBe(false);
    expect(JSON.parse(storage.map.get('kookr:pinnedPlaybooks')!)).toEqual([]);
  });

  test('legacy bare-id recent still ranks until rewritten on launch', () => {
    storage.map.set('kookr:recentPlaybooks', JSON.stringify(['deploy.md', 'other.md']));
    const legacy = new PlaybookUsageTracker(storage.impl);

    expect(legacy.recentIndex('deploy.md', '/any/cwd')).toBe(0);

    legacy.recordLaunch('deploy.md', '/project-a');
    expect(legacy.getRecent()).toEqual(['/project-a::deploy.md', 'other.md']);
    expect(legacy.recentIndex('deploy.md', '/project-a')).toBe(0);
    // Bare entry removed — other cwd no longer matches deploy via legacy
    expect(legacy.recentIndex('deploy.md', '/project-b')).toBe(-1);
  });

  test('pinning after legacy bare-id already consumed uses composite only', () => {
    storage.map.set('kookr:pinnedPlaybooks', JSON.stringify(['deploy.md']));
    const legacy = new PlaybookUsageTracker(storage.impl);

    legacy.togglePin('deploy.md', '/project-a'); // unpins bare
    expect(legacy.togglePin('deploy.md', '/project-a')).toBe(true); // re-pin composite
    expect(JSON.parse(storage.map.get('kookr:pinnedPlaybooks')!)).toEqual([
      '/project-a::deploy.md',
    ]);
    expect(legacy.isPinned('deploy.md', '/project-b')).toBe(false);
  });

  test('persistence across instances for pin and recent', () => {
    tracker.recordLaunch('deploy.md', '/project');
    tracker.togglePin('deploy.md', '/project');

    const tracker2 = new PlaybookUsageTracker(storage.impl);
    expect(tracker2.getRecent()).toEqual(['/project::deploy.md']);
    expect(tracker2.isPinned('deploy.md', '/project')).toBe(true);
  });

  test('hardened save() does not throw on quota exceeded for recordLaunch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    } as Pick<Storage, 'getItem' | 'setItem'>;

    const failTracker = new PlaybookUsageTracker(failStorage);
    expect(() => failTracker.recordLaunch('test.md', '/project')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('PlaybookUsageTracker — param history', () => {
  let storage: ReturnType<typeof fakeStorage>;
  let tracker: PlaybookUsageTracker;

  beforeEach(() => {
    storage = fakeStorage();
    tracker = new PlaybookUsageTracker(storage.impl);
  });

  test('recordParams + getParamSnapshot round-trip', () => {
    tracker.recordParams('deploy.md', '/home/user/project', { env: 'prod', tag: 'v1.0' });

    const snapshot = tracker.getParamSnapshot('deploy.md', '/home/user/project');
    expect(snapshot).toEqual({ env: 'prod', tag: 'v1.0' });
  });

  test('returns null when no snapshot exists', () => {
    expect(tracker.getParamSnapshot('deploy.md', '/home/user/project')).toBeNull();
  });

  test('cross-project isolation: same playbook ID, different sourceCwd', () => {
    tracker.recordParams('deploy.md', '/project-a', { env: 'staging' });
    tracker.recordParams('deploy.md', '/project-b', { env: 'prod' });

    expect(tracker.getParamSnapshot('deploy.md', '/project-a')).toEqual({ env: 'staging' });
    expect(tracker.getParamSnapshot('deploy.md', '/project-b')).toEqual({ env: 'prod' });
  });

  test('subsequent recordParams overwrites previous snapshot', () => {
    tracker.recordParams('deploy.md', '/project', { env: 'dev' });
    tracker.recordParams('deploy.md', '/project', { env: 'prod', tag: 'v2' });

    expect(tracker.getParamSnapshot('deploy.md', '/project')).toEqual({ env: 'prod', tag: 'v2' });
  });

  test('persistence across instances', () => {
    tracker.recordParams('deploy.md', '/project', { env: 'prod' });

    const tracker2 = new PlaybookUsageTracker(storage.impl);
    expect(tracker2.getParamSnapshot('deploy.md', '/project')).toEqual({ env: 'prod' });
  });

  test('corrupted localStorage returns null', () => {
    storage.map.set('kookr:playbookParamHistory', 'not-json{{{');
    const tracker2 = new PlaybookUsageTracker(storage.impl);

    expect(tracker2.getParamSnapshot('deploy.md', '/project')).toBeNull();
  });

  test('invalid structure in localStorage returns null for that entry', () => {
    // Value contains non-string values — should be discarded
    storage.map.set(
      'kookr:playbookParamHistory',
      JSON.stringify({
        '/project::deploy.md': { env: 123, tag: true },
        '/project::good.md': { repo: 'https://example.com' },
      }),
    );
    const tracker2 = new PlaybookUsageTracker(storage.impl);

    expect(tracker2.getParamSnapshot('deploy.md', '/project')).toBeNull();
    expect(tracker2.getParamSnapshot('good.md', '/project')).toEqual({
      repo: 'https://example.com',
    });
  });

  test('array in localStorage is rejected', () => {
    storage.map.set('kookr:playbookParamHistory', JSON.stringify([]));
    const tracker2 = new PlaybookUsageTracker(storage.impl);

    expect(tracker2.getParamSnapshot('deploy.md', '/project')).toBeNull();
  });

  test('setItem failure does not throw', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    } as Pick<Storage, 'getItem' | 'setItem'>;

    const failTracker = new PlaybookUsageTracker(failStorage);
    expect(() => failTracker.recordParams('deploy.md', '/project', { env: 'prod' })).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      'PlaybookUsageTracker: failed to save param history',
      expect.any(DOMException),
    );

    warnSpy.mockRestore();
  });

  test('getItem failure returns null gracefully', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    } as Pick<Storage, 'getItem' | 'setItem'>;

    const failTracker = new PlaybookUsageTracker(failStorage);
    expect(failTracker.getParamSnapshot('deploy.md', '/project')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'PlaybookUsageTracker: failed to read param history',
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
