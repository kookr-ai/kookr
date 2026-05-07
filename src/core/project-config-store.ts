import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';

// --- Rate Limit Config (from oss-contribution-gate hook) ---

export interface RateLimitConfig {
  defaults: { maxPrsPerDay: number };
  overrides: Record<string, { maxPrsPerDay?: number }>;
  blocked: string[];
}

// --- Project Config ---

export interface ProjectConfig {
  project: string;       // "github.com/grafana/grafana"
  /** Explicit user-opted tracking (e.g. added from the GUI) — seeds sidebar membership. */
  tracked?: boolean;
  dailyPrLimit?: number; // Default: 2
  weeklyPrLimit?: number;
  notes?: string;        // Developer notes about contribution strategy
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

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'project-configs.json');
    this.rateLimitsPath = join(kookrDir, 'rate-limits.json');
  }

  /** Get the path to the rate-limits config (for file watching). */
  getRateLimitsPath(): string {
    return this.rateLimitsPath;
  }

  async load(): Promise<void> {
    const arr = await readJsonFile<ProjectConfig[]>(this.filePath, []);
    this.configs.clear();
    for (const config of arr) {
      this.configs.set(config.project, config);
    }
  }

  /**
   * Load rate limits from the hook's config file (~/.kookr/rate-limits.json).
   * Merges with any manually-set project configs (manual configs take precedence).
   */
  async loadRateLimits(): Promise<void> {
    this.rateLimits = await readJsonFile<RateLimitConfig | null>(this.rateLimitsPath, null);
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
    await atomicWriteFile(this.filePath, JSON.stringify(arr, null, 2));
  }

  getConfig(project: string): ProjectConfig | undefined {
    return this.configs.get(project);
  }

  setConfig(project: string, patch: Partial<Omit<ProjectConfig, 'project'>>): ProjectConfig {
    const existing = this.configs.get(project) ?? { project };
    const updated = { ...existing, ...patch, project };
    this.configs.set(project, updated);
    return updated;
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
