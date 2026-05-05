import { describe, test, expect, beforeEach, vi } from 'vitest';
import { PlaybookUsageTracker } from './playbook-usage.js';

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

  test('hardened save() does not throw on quota exceeded', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    } as Pick<Storage, 'getItem' | 'setItem'>;

    const failTracker = new PlaybookUsageTracker(failStorage);
    expect(() => failTracker.recordLaunch('test.md')).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
