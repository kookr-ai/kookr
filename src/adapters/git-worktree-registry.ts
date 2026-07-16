import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  isDetached: boolean;
  isPrunable: boolean;
  isBare: boolean;
  isMain: boolean;
}

export interface WorktreeRegistrySnapshot {
  entries: WorktreeEntry[];
  refreshedAt: string | null;
  lastError: string | null;
}

export interface WorktreeRegistryRunner {
  (repoPath: string, args: string[]): Promise<string>;
}

const defaultRunner: WorktreeRegistryRunner = async (repoPath, args) => {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

function normalizePath(path: string): string {
  return resolve(path);
}

/** Parse `git worktree list --porcelain` output into structured entries. */
export function parseGitWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;

  const pushCurrent = (): void => {
    if (!current?.path) return;
    entries.push({
      path: normalizePath(current.path),
      branch: current.branch ?? null,
      head: current.head ?? '',
      isDetached: current.isDetached ?? false,
      isPrunable: current.isPrunable ?? false,
      isBare: current.isBare ?? false,
      isMain: false,
    });
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      pushCurrent();
      current = { path: line.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      current.isDetached = true;
    } else if (line === 'bare') {
      current.isBare = true;
    } else if (line.startsWith('prunable')) {
      current.isPrunable = true;
    } else if (line === '') {
      pushCurrent();
      current = null;
    }
  }
  pushCurrent();

  // A bare repository contributes registry metadata but has no primary
  // checkout. Once a bare entry is present, every non-bare entry is linked.
  const primaryIndex = entries.some((entry) => entry.isBare)
    ? -1
    : entries.findIndex((entry) => !entry.isBare);
  return entries.map((entry, index) => ({
    ...entry,
    isMain: index === primaryIndex,
  }));
}

export class WorktreeRegistry {
  private entriesByPath = new Map<string, WorktreeEntry>();
  private entriesByBranch = new Map<string, WorktreeEntry>();
  private refreshedAt: string | null = null;
  private lastError: string | null = null;

  constructor(private runGit: WorktreeRegistryRunner = defaultRunner) {}

  async refresh(repoPath: string): Promise<WorktreeRegistrySnapshot> {
    try {
      const output = await this.runGit(repoPath, ['worktree', 'list', '--porcelain']);
      const entries = parseGitWorktreeList(output);

      this.entriesByPath = new Map(entries.map((entry) => [normalizePath(entry.path), entry]));
      this.entriesByBranch = new Map(
        entries.flatMap((entry) => entry.branch ? [[entry.branch, entry] as const] : []),
      );
      this.refreshedAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    return this.snapshot();
  }

  byPath(path: string): WorktreeEntry | null {
    return this.entriesByPath.get(normalizePath(path)) ?? null;
  }

  byBranch(branch: string): WorktreeEntry | null {
    return this.entriesByBranch.get(branch) ?? null;
  }

  all(): WorktreeEntry[] {
    return [...this.entriesByPath.values()];
  }

  snapshot(): WorktreeRegistrySnapshot {
    return {
      entries: this.all(),
      refreshedAt: this.refreshedAt,
      lastError: this.lastError,
    };
  }
}
