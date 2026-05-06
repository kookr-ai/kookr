import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

export interface OssSourceWatcherFs {
  watch: (path: string, options: { persistent: false }, listener: WatchListener) => FSWatcher;
  stat: typeof stat;
  readdir: typeof readdir;
}

const DEFAULT_FS: OssSourceWatcherFs = { watch, stat, readdir };
const DEFAULT_DEBOUNCE_MS = 250;

interface BaseWatcherDeps {
  enabled?: () => boolean;
  debounceMs?: number;
  runFs?: Partial<OssSourceWatcherFs>;
}

export interface OssRegistryWatcherDeps extends BaseWatcherDeps {
  registryPath: string;
  onChange: () => void | Promise<void>;
}

export interface ReconReportWatcherDeps extends BaseWatcherDeps {
  claudeDir: string;
  onChange: () => void | Promise<void>;
}

export class OssRegistryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly fs: OssSourceWatcherFs;
  private readonly debounceMs: number;
  private readonly enabled: () => boolean;

  constructor(private readonly deps: OssRegistryWatcherDeps) {
    this.fs = { ...DEFAULT_FS, ...deps.runFs };
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.enabled = deps.enabled ?? (() => true);
  }

  start(): void {
    if (!this.enabled() || this.watcher) return;
    const targetName = basename(this.deps.registryPath);
    try {
      this.watcher = this.fs.watch(dirname(this.deps.registryPath), { persistent: false }, (_eventType, filename) => {
        if (!this.enabled()) return;
        if (!filename || filename.toString() !== targetName) return;
        this.scheduleIfFileExists(this.deps.registryPath);
      });
    } catch {
      // Missing ~/.kookr is not fatal; startup should remain fail-open.
    }
  }

  close(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  private scheduleIfFileExists(filePath: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.enabled()) return;
      try {
        const fileStat = await this.fs.stat(filePath);
        if (!fileStat.isFile()) return;
      } catch {
        return;
      }
      try {
        await this.deps.onChange();
      } catch (err) {
        console.warn('[oss-source-watcher] Registry reload failed:', err instanceof Error ? err.message : err);
      }
    }, this.debounceMs);
  }
}

export class ReconReportWatcher {
  private claudeWatcher: FSWatcher | null = null;
  private reconWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly fs: OssSourceWatcherFs;
  private readonly debounceMs: number;
  private readonly enabled: () => boolean;

  constructor(private readonly deps: ReconReportWatcherDeps) {
    this.fs = { ...DEFAULT_FS, ...deps.runFs };
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.enabled = deps.enabled ?? (() => true);
  }

  start(): void {
    if (!this.enabled() || this.claudeWatcher) return;
    void this.refreshReconDirWatchers();
    try {
      this.claudeWatcher = this.fs.watch(this.deps.claudeDir, { persistent: false }, (_eventType, filename) => {
        if (!this.enabled()) return;
        if (!filename || !filename.toString().endsWith('-recon')) return;
        void this.refreshReconDirWatchers();
        void this.scheduleIfReportExists(join(this.deps.claudeDir, filename.toString(), 'recon-report.md'));
      });
    } catch {
      // Missing ~/.claude is a no-op; no polling is started.
    }
  }

  close(): void {
    if (this.claudeWatcher) {
      this.claudeWatcher.close();
      this.claudeWatcher = null;
    }
    for (const watcher of this.reconWatchers.values()) {
      watcher.close();
    }
    this.reconWatchers.clear();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isWatchingClaudeDir(): boolean {
    return this.claudeWatcher !== null;
  }

  isWatchingReconDir(dirPath: string): boolean {
    return this.reconWatchers.has(dirPath);
  }

  private async refreshReconDirWatchers(): Promise<void> {
    if (!this.enabled()) return;
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.deps.claudeDir);
    } catch {
      return;
    }

    const current = new Set<string>();
    for (const entry of entries) {
      if (!entry.endsWith('-recon')) continue;
      const dirPath = join(this.deps.claudeDir, entry);
      try {
        const dirStat = await this.fs.stat(dirPath);
        if (!dirStat.isDirectory()) continue;
      } catch {
        continue;
      }
      current.add(dirPath);
      if (!this.reconWatchers.has(dirPath)) {
        this.watchReconDir(dirPath);
      }
    }

    for (const [dirPath, watcher] of this.reconWatchers) {
      if (current.has(dirPath)) continue;
      watcher.close();
      this.reconWatchers.delete(dirPath);
    }
  }

  private watchReconDir(dirPath: string): void {
    try {
      const watcher = this.fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (!this.enabled()) return;
        if (!filename || filename.toString() !== 'recon-report.md') return;
        void this.scheduleIfReportExists(join(dirPath, 'recon-report.md'));
      });
      this.reconWatchers.set(dirPath, watcher);
    } catch {
      // Directory may have disappeared between readdir/stat/watch.
    }
  }

  private async scheduleIfReportExists(reportPath: string): Promise<void> {
    if (!this.enabled()) return;
    try {
      const reportStat = await this.fs.stat(reportPath);
      if (!reportStat.isFile()) return;
    } catch {
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (!this.enabled()) return;
      try {
        await this.deps.onChange();
      } catch (err) {
        console.warn('[oss-source-watcher] Recon rescan failed:', err instanceof Error ? err.message : err);
      }
    }, this.debounceMs);
  }
}
