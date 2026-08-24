import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';
import {
  sanitizeProjectConfig,
  type ProjectConfig,
} from '../shared/contracts/project-config.js';

// --- Rate Limit Config (from oss-contribution-gate hook) ---

export interface RateLimitConfig {
  defaults: { maxPrsPerDay: number };
  overrides: Record<string, { maxPrsPerDay?: number }>;
  blocked: string[];
}

// --- Project Config ---

export type { ProjectConfig };

export const PROJECT_ISSUE_EMISSION_LIMIT_ENV = 'KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT';

/** Read the optional deployment-wide ceiling for the per-project zero-drain setting. */
export function readMaxZeroDrainIssueLimitFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env.KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${PROJECT_ISSUE_EMISSION_LIMIT_ENV} must be a non-negative safe integer`);
  }
  return value;
}

export class ProjectConfigLimitError extends Error {
  constructor(
    public readonly field: 'zeroDrainIssueLimit',
    public readonly value: number,
    public readonly maximum: number,
  ) {
    super(`${field}=${value} exceeds deployment limit ${maximum}`);
    this.name = 'ProjectConfigLimitError';
  }
}

/**
 * Extract "owner/repo" from a project ID ("github.com/owner/repo").
 * Returns null for local projects.
 */
function projectIdToRepoName(projectId: string): string | null {
  const parts = projectId.split('/');
  if (parts.length >= 3 && parts[0] !== 'local') {
    return parts.slice(1).join('/');
  }
  return null;
}

// --- ProjectConfigStore ---

export class ProjectConfigStore {
  private configs = new Map<string, ProjectConfig>();
  private rateLimits: RateLimitConfig | null = null;
  private blockedRepos: Set<string> = new Set();
  private filePath: string;
  private rateLimitsPath: string;
  private readonly maxZeroDrainIssueLimit: number | undefined;

  constructor(kookrDir: string, options: { maxZeroDrainIssueLimit?: number } = {}) {
    this.filePath = join(kookrDir, 'project-configs.json');
    this.rateLimitsPath = join(kookrDir, 'rate-limits.json');
    this.maxZeroDrainIssueLimit = options.maxZeroDrainIssueLimit;
  }

  /** Get the path to the rate-limits config (for file watching). */
  getRateLimitsPath(): string {
    return this.rateLimitsPath;
  }

  async load(): Promise<void> {
    const arr = await readJsonFile<unknown[]>(this.filePath, [], {
      quarantineCorrupt: true,
      warningPrefix: 'project-config-store',
    });
    this.configs.clear();
    for (const rawConfig of arr) {
      const config = sanitizeProjectConfig(rawConfig);
      if (config) {
        if (
          this.maxZeroDrainIssueLimit !== undefined
          && config.zeroDrainIssueLimit !== undefined
          && config.zeroDrainIssueLimit > this.maxZeroDrainIssueLimit
        ) {
          // A deployment cap may be lowered between restarts. Preserve the
          // project row but fail closed for this setting until it is corrected.
          delete config.zeroDrainIssueLimit;
        }
        this.configs.set(config.project, config);
      }
    }
  }

  /**
   * Load rate limits from the hook's config file (~/.kookr/rate-limits.json).
   * Merges with any manually-set project configs (manual configs take precedence).
   */
  async loadRateLimits(): Promise<void> {
    this.rateLimits = await readJsonFile<RateLimitConfig | null>(this.rateLimitsPath, null, {
      quarantineCorrupt: true,
      warningPrefix: 'project-config-store',
    });
    if (!this.rateLimits) return;

    // Track blocked repos
    this.blockedRepos = new Set(
      (this.rateLimits.blocked ?? []).map((r) => r.toLowerCase()),
    );
  }

  /**
   * Get the effective daily PR limit for a project.
   * Priority: manual config > rate-limits.json override > rate-limits.json default.
   */
  getEffectiveDailyLimit(project: string): number | undefined {
    // Manual config takes precedence
    const manual = this.configs.get(project);
    if (manual?.dailyPrLimit !== undefined) return manual.dailyPrLimit;

    if (!this.rateLimits) return undefined;

    // Check rate-limits.json overrides (repo format: "owner/repo")
    const repoName = projectIdToRepoName(project);
    if (repoName) {
      const override = this.rateLimits.overrides[repoName];
      if (override?.maxPrsPerDay !== undefined) return override.maxPrsPerDay;
    }

    // Fall back to default
    return this.rateLimits.defaults?.maxPrsPerDay;
  }

  /** Check if a repo is blocked. */
  isBlocked(project: string): boolean {
    const repoName = projectIdToRepoName(project);
    return repoName ? this.blockedRepos.has(repoName.toLowerCase()) : false;
  }

  /** Get all blocked repos. */
  getBlockedRepos(): string[] {
    return [...this.blockedRepos];
  }

  async save(): Promise<void> {
    const arr = Array.from(this.configs.values());
    // Compact JSON (issue #2318): drop pretty-print to cut rewrite amplification
    // on a frequently updated operator config store. Load still accepts legacy
    // pretty-printed files via JSON.parse.
    await atomicWriteFile(this.filePath, JSON.stringify(arr));
  }

  getConfig(project: string): ProjectConfig | undefined {
    return this.configs.get(project);
  }

  getMaxZeroDrainIssueLimit(): number | undefined {
    return this.maxZeroDrainIssueLimit;
  }

  setConfig(project: string, patch: Partial<Omit<ProjectConfig, 'project'>>): ProjectConfig {
    const existing = this.configs.get(project) ?? { project };
    const updated = sanitizeProjectConfig({ ...existing, ...patch, project });
    if (!updated) throw new Error(`Invalid project config: ${project}`);
    if (
      this.maxZeroDrainIssueLimit !== undefined
      && updated.zeroDrainIssueLimit !== undefined
      && updated.zeroDrainIssueLimit > this.maxZeroDrainIssueLimit
    ) {
      throw new ProjectConfigLimitError(
        'zeroDrainIssueLimit',
        updated.zeroDrainIssueLimit,
        this.maxZeroDrainIssueLimit,
      );
    }
    this.configs.set(project, updated);
    return updated;
  }

  /**
   * Stamp the project's localPath if no value is currently set. First-write-
   * wins under serial calls: the second call is a no-op once the field is
   * populated. Concurrent first-calls within the same process race on the
   * read-then-write — last writer wins — but the race is benign because
   * both writers stamp from a real (just-launched) task.cwd.
   *
   * Awaits save() before returning so a process crash immediately after the
   * first stamp does not silently drop the value on restart.
   *
   * Returns true when a write happened, false when localPath was already
   * populated or when candidatePath is falsy.
   */
  async setLocalPathIfUnset(project: string, candidatePath: string): Promise<boolean> {
    if (!candidatePath) return false;
    const existing = this.configs.get(project);
    if (existing?.localPath) return false;
    this.setConfig(project, { localPath: candidatePath });
    await this.save();
    return true;
  }

  /** Remove a project config entirely. Returns true if a row was removed. */
  removeConfig(project: string): boolean {
    return this.configs.delete(project);
  }

  /** Test helper: clear persisted project membership and rate-limit state. */
  clearForTests(): void {
    this.configs.clear();
    this.rateLimits = null;
    this.blockedRepos.clear();
  }

  getAllConfigs(): ProjectConfig[] {
    return Array.from(this.configs.values());
  }
}
