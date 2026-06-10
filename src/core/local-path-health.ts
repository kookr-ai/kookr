import { access } from 'node:fs/promises';

/**
 * Sync-read / async-refresh existence cache for `local/*` project checkout
 * paths.
 *
 * Project summaries are computed synchronously and on a hot path (every
 * snapshot broadcast and WS connect), so we never stat inline. Instead,
 * `isMissing()` answers from a TTL cache and — when the entry is absent or
 * stale — schedules a background `access()` check whose result lands in the
 * cache for the next computation. Unknown paths are optimistically treated
 * as present (`false`), so a project is only hidden after a real stat has
 * confirmed the path is gone.
 */
export class LocalPathHealthChecker {
  private cache = new Map<string, { missing: boolean; checkedAt: number }>();
  private inflight = new Set<string>();

  constructor(
    private readonly ttlMs: number = 60_000,
    private readonly pathExists: (path: string) => Promise<boolean> = defaultPathExists,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether `path` is known to be missing. Returns `false` (present) for
   * paths that have never been checked; kicks an async refresh when the
   * cached answer is absent or older than the TTL.
   */
  isMissing(path: string): boolean {
    const entry = this.cache.get(path);
    if (!entry || this.now() - entry.checkedAt > this.ttlMs) {
      this.scheduleCheck(path);
    }
    return entry?.missing ?? false;
  }

  private scheduleCheck(path: string): void {
    if (this.inflight.has(path)) return;
    this.inflight.add(path);
    void this.pathExists(path)
      .then((exists) => {
        this.cache.set(path, { missing: !exists, checkedAt: this.now() });
      })
      .catch(() => {
        // A throwing checker is treated as "unknown" — keep the previous
        // answer rather than hiding projects on transient fs errors.
      })
      .finally(() => {
        this.inflight.delete(path);
      });
  }

  /** Test helper: resolves once no checks are in flight. */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Process-wide default instance used by `computeProjectSummaries` when no
 * checker is injected. Shared deliberately: the stat cache should be
 * amortized across the route handler, WS bursts, and broadcast paths.
 */
export const defaultLocalPathChecker = new LocalPathHealthChecker();
