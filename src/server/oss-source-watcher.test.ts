import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { dirname, join } from 'node:path';
import type { FSWatcher } from 'node:fs';
import { OssRegistryWatcher, ReconReportWatcher, type OssSourceWatcherFs } from './oss-source-watcher.js';

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

class FakeFs {
  readonly files = new Set<string>();
  readonly dirs = new Set<string>();
  readonly watchers = new Map<string, Set<WatchListener>>();

  watch: OssSourceWatcherFs['watch'] = (path, _options, listener) => {
    const listeners = this.watchers.get(path) ?? new Set<WatchListener>();
    listeners.add(listener);
    this.watchers.set(path, listeners);
    return {
      close: () => listeners.delete(listener),
    } as FSWatcher;
  };

  stat: OssSourceWatcherFs['stat'] = async (path) => {
    if (this.files.has(path)) {
      return {
        isFile: () => true,
        isDirectory: () => false,
      } as Awaited<ReturnType<OssSourceWatcherFs['stat']>>;
    }
    if (this.dirs.has(path)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
      } as Awaited<ReturnType<OssSourceWatcherFs['stat']>>;
    }
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };

  readdir: OssSourceWatcherFs['readdir'] = async (path) => {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const entries = new Set<string>();
    for (const dir of this.dirs) {
      if (dir === path || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes('/')) entries.add(rest);
    }
    for (const file of this.files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes('/')) entries.add(rest);
    }
    return [...entries].sort();
  };

  emit(path: string, filename: string): void {
    for (const listener of this.watchers.get(path) ?? []) {
      listener('rename', filename);
    }
  }

  runFs(): Partial<OssSourceWatcherFs> {
    return {
      watch: this.watch,
      stat: this.stat,
      readdir: this.readdir,
    };
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(251);
  await flush();
}

describe('OssRegistryWatcher', () => {
  let fakeFs: FakeFs;
  let registryPath: string;
  let watcher: OssRegistryWatcher | null;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeFs = new FakeFs();
    registryPath = '/tmp/kookr/oss-repos.json';
    fakeFs.dirs.add(dirname(registryPath));
    watcher = null;
  });

  afterEach(() => {
    watcher?.close();
    vi.useRealTimers();
  });

  test('change event triggers the callback', async () => {
    fakeFs.files.add(registryPath);
    const onChange = vi.fn();
    watcher = new OssRegistryWatcher({
      registryPath,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();

    fakeFs.emit(dirname(registryPath), 'oss-repos.json');
    await advanceDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('debounce coalesces rapid registry events', async () => {
    fakeFs.files.add(registryPath);
    const onChange = vi.fn();
    watcher = new OssRegistryWatcher({
      registryPath,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();

    for (let i = 0; i < 5; i++) fakeFs.emit(dirname(registryPath), 'oss-repos.json');
    await advanceDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('opt-out setting disables registry watching', async () => {
    fakeFs.files.add(registryPath);
    const onChange = vi.fn();
    watcher = new OssRegistryWatcher({
      registryPath,
      enabled: () => false,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();

    expect(watcher.isWatching()).toBe(false);
    fakeFs.emit(dirname(registryPath), 'oss-repos.json');
    await advanceDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });

  test('missing registry file is a no-op', async () => {
    const onChange = vi.fn();
    watcher = new OssRegistryWatcher({
      registryPath,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();

    fakeFs.emit(dirname(registryPath), 'oss-repos.json');
    await advanceDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ReconReportWatcher', () => {
  let fakeFs: FakeFs;
  let claudeDir: string;
  let reconDir: string;
  let reportPath: string;
  let watcher: ReconReportWatcher | null;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeFs = new FakeFs();
    claudeDir = '/tmp/claude';
    reconDir = join(claudeDir, 'grafana-grafana-recon');
    reportPath = join(reconDir, 'recon-report.md');
    fakeFs.dirs.add(claudeDir);
    watcher = null;
  });

  afterEach(() => {
    watcher?.close();
    vi.useRealTimers();
  });

  test('change event in a known recon dir triggers the callback', async () => {
    fakeFs.dirs.add(reconDir);
    fakeFs.files.add(reportPath);
    const onChange = vi.fn();
    watcher = new ReconReportWatcher({
      claudeDir,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();
    await flush();

    fakeFs.emit(reconDir, 'recon-report.md');
    await advanceDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('create event for a new recon dir triggers the callback when report exists', async () => {
    const onChange = vi.fn();
    watcher = new ReconReportWatcher({
      claudeDir,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();
    await flush();

    fakeFs.dirs.add(reconDir);
    fakeFs.files.add(reportPath);
    fakeFs.emit(claudeDir, 'grafana-grafana-recon');
    await flush();
    await advanceDebounce();

    expect(watcher.isWatchingReconDir(reconDir)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('debounce coalesces rapid recon-report events', async () => {
    fakeFs.dirs.add(reconDir);
    fakeFs.files.add(reportPath);
    const onChange = vi.fn();
    watcher = new ReconReportWatcher({
      claudeDir,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();
    await flush();

    for (let i = 0; i < 5; i++) fakeFs.emit(reconDir, 'recon-report.md');
    await advanceDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test('opt-out setting disables recon watching', async () => {
    fakeFs.dirs.add(reconDir);
    fakeFs.files.add(reportPath);
    const onChange = vi.fn();
    watcher = new ReconReportWatcher({
      claudeDir,
      enabled: () => false,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();

    expect(watcher.isWatchingClaudeDir()).toBe(false);
    fakeFs.emit(reconDir, 'recon-report.md');
    await advanceDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });

  test('missing recon-report.md is a no-op', async () => {
    fakeFs.dirs.add(reconDir);
    const onChange = vi.fn();
    watcher = new ReconReportWatcher({
      claudeDir,
      onChange,
      runFs: fakeFs.runFs(),
    });
    watcher.start();
    await flush();

    fakeFs.emit(reconDir, 'recon-report.md');
    await advanceDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });
});
