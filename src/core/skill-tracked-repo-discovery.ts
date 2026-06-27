import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOwnerRepoSlug } from '../shared/repo-slug.js';
import type {
  SkillDiscoveryProjectStatus,
  SkillDiscoveryScanStatus,
  SkillDiscoveryStateSnapshot,
} from '../shared/contracts/project-discovery.js';

export interface SkillTrackedRepoDiscoveryResult {
  /** Normalized project IDs (e.g. "github.com/owner/repo"). */
  projects: string[];
  /** Human-readable warnings for directories that were skipped or malformed. */
  warnings: string[];
  /** ISO timestamp for when discovery completed. */
  scannedAt: string;
  /** Whether discovery scanned files or skipped because the recon manifest was unchanged. */
  cacheStatus: Exclude<SkillDiscoveryScanStatus, 'stale'>;
  /** Why the previous cache was considered stale enough to rescan. */
  staleReasons: string[];
  /** Per-project scan/cache status for diagnostics and UI surfaces. */
  projectStatuses: SkillDiscoveryProjectStatus[];
}

interface SkillTrackedRepoDiscoveryOptions {
  readReportFile?: (path: string) => Promise<string>;
}

interface ReconManifestEntry {
  entry: string;
  kind: 'directory' | 'file';
  report?: {
    mode: number;
    size: number;
    ctimeMs: number;
    mtimeMs: number;
  };
}

interface ReconManifest {
  rootReadable: boolean;
  entries: ReconManifestEntry[];
}

/**
 * Discover OSS repositories tracked by `oss-repo-recon`-style skills.
 *
 * Scans `~/.claude/*-recon/recon-report.md`. Parses canonical repo identity from:
 *   1) YAML frontmatter (`repo: owner/repo`) — preferred machine-readable contract
 *   2) `# Recon Report: owner/repo` heading — legacy compatibility fallback
 *
 * Directories that cannot be parsed are skipped with a warning. The discovery
 * is purely read-only: no writes are made to `~/.claude`.
 */
export class SkillTrackedRepoDiscovery {
  private claudeDir: string;
  private readReportFile: (path: string) => Promise<string>;
  private cachedManifestKey: string | null = null;
  private cachedResult: SkillTrackedRepoDiscoveryResult | null = null;

  constructor(claudeDir: string, options: SkillTrackedRepoDiscoveryOptions = {}) {
    this.claudeDir = claudeDir;
    this.readReportFile = options.readReportFile ?? ((path) => readFile(path, 'utf-8'));
  }

  async discover(): Promise<SkillTrackedRepoDiscoveryResult> {
    const scannedAt = new Date().toISOString();
    const manifest = await this.readManifest();
    const manifestKey = JSON.stringify(manifest);
    if (this.cachedManifestKey === manifestKey && this.cachedResult) {
      return copyDiscoveryResult({
        ...this.cachedResult,
        scannedAt,
        cacheStatus: 'skipped',
        staleReasons: [],
        projectStatuses: this.cachedResult.projectStatuses.map((status) => ({
          ...status,
          status: 'skipped',
          reason: 'recon manifest unchanged',
        })),
      });
    }

    const projects: string[] = [];
    const warnings: string[] = [];
    const projectStatuses: SkillDiscoveryProjectStatus[] = [];
    const seen = new Set<string>();

    const staleReasons = this.describeStaleReasons(manifest);
    if (!manifest.rootReadable) {
      const result = {
        projects: [],
        warnings: [],
        scannedAt,
        cacheStatus: 'scanned' as const,
        staleReasons,
        projectStatuses,
      };
      this.cacheResult(manifestKey, result);
      return copyDiscoveryResult(result);
    }

    for (const manifestEntry of manifest.entries) {
      const entry = manifestEntry.entry;

      const dirPath = join(this.claudeDir, entry);
      if (manifestEntry.kind !== 'directory') continue;

      const reportPath = join(dirPath, 'recon-report.md');
      let raw: string;
      try {
        raw = await this.readReportFile(reportPath);
      } catch {
        warnings.push(`${entry}: recon-report.md not readable`);
        continue;
      }

      const repoSlug = parseRepoFromReconReport(raw);
      if (!repoSlug) {
        warnings.push(`${entry}: could not parse repo identity from recon-report.md`);
        continue;
      }

      const projectId = `github.com/${repoSlug}`.toLowerCase();
      if (seen.has(projectId)) continue;
      seen.add(projectId);
      projects.push(projectId);
      projectStatuses.push({
        project: projectId,
        status: 'scanned',
        reason: staleReasons.length > 0 ? staleReasons.join('; ') : 'initial scan',
        source: entry,
      });
    }

    projects.sort();
    projectStatuses.sort((a, b) => a.project.localeCompare(b.project));
    const result = {
      projects,
      warnings,
      scannedAt,
      cacheStatus: 'scanned' as const,
      staleReasons,
      projectStatuses,
    };
    this.cacheResult(manifestKey, result);
    return copyDiscoveryResult(result);
  }

  private async readManifest(): Promise<ReconManifest> {
    let entries: string[];
    try {
      entries = await readdir(this.claudeDir);
    } catch {
      // Missing or unreadable ~/.claude is not an error; treat as empty.
      return { rootReadable: false, entries: [] };
    }

    const manifestEntries: ReconManifestEntry[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('-recon')) continue;

      const dirPath = join(this.claudeDir, entry);
      let dirStat;
      try {
        dirStat = await stat(dirPath);
      } catch {
        // Directory listing can race with user edits; skip vanished entries.
        continue;
      }
      if (!dirStat.isDirectory()) {
        manifestEntries.push({ entry, kind: 'file' });
        continue;
      }

      const reportPath = join(dirPath, 'recon-report.md');
      try {
        const reportStat = await stat(reportPath);
        manifestEntries.push({
          entry,
          kind: 'directory',
          report: {
            mode: reportStat.mode,
            size: reportStat.size,
            ctimeMs: reportStat.ctimeMs,
            mtimeMs: reportStat.mtimeMs,
          },
        });
      } catch {
        manifestEntries.push({ entry, kind: 'directory' });
      }
    }

    return { rootReadable: true, entries: manifestEntries };
  }

  private describeStaleReasons(manifest: ReconManifest): string[] {
    if (!this.cachedManifestKey) return [];
    if (this.cachedManifestKey === JSON.stringify(manifest)) return [];
    return ['recon manifest changed'];
  }

  private cacheResult(manifestKey: string, result: SkillTrackedRepoDiscoveryResult): void {
    this.cachedManifestKey = manifestKey;
    this.cachedResult = copyDiscoveryResult(result);
  }
}

/**
 * One authoritative server-owned discovery state with last-known-good semantics.
 *
 * - On initial load or manual rescan, the scanner runs off to the side.
 * - If the scanner throws (wholesale IO failure), the previous snapshot is
 *   preserved and `lastError` is set on the returned snapshot.
 * - If the scanner completes but individual directories are malformed, the new
 *   snapshot is swapped in atomically; malformed entries contribute warnings.
 */
export class SkillDiscoveryStateHolder {
  private snapshot: SkillDiscoveryStateSnapshot = { projects: [], warnings: [] };
  private discovery: SkillTrackedRepoDiscovery;
  /** In-flight rescan; concurrent callers share the same promise. */
  private inFlight: Promise<SkillDiscoveryStateSnapshot> | null = null;

  constructor(discovery: SkillTrackedRepoDiscovery) {
    this.discovery = discovery;
  }

  /** Return a shallow copy of the current snapshot. */
  getSnapshot(): SkillDiscoveryStateSnapshot {
    return {
      projects: [...this.snapshot.projects],
      warnings: [...this.snapshot.warnings],
      scannedAt: this.snapshot.scannedAt,
      lastError: this.snapshot.lastError,
      cacheStatus: this.snapshot.cacheStatus,
      staleReasons: this.snapshot.staleReasons ? [...this.snapshot.staleReasons] : undefined,
      projectStatuses: this.snapshot.projectStatuses?.map((status) => ({ ...status })),
    };
  }

  /** Return only the project IDs (used by summary membership). */
  getProjects(): string[] {
    return [...this.snapshot.projects];
  }

  /**
   * Run discovery and atomically swap in the new snapshot on success.
   * On wholesale failure, the previous snapshot is preserved; the returned
   * snapshot reflects the current (possibly stale) state with `lastError` set.
   *
   * Concurrent callers share a single in-flight scan so two parallel rescans
   * cannot write their results out of order.
   */
  async rescan(): Promise<SkillDiscoveryStateSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRescan().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRescan(): Promise<SkillDiscoveryStateSnapshot> {
    let result: SkillTrackedRepoDiscoveryResult;
    try {
      result = await this.discovery.discover();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.snapshot = {
        projects: this.snapshot.projects,
        warnings: this.snapshot.warnings,
        scannedAt: this.snapshot.scannedAt,
        lastError: message,
        cacheStatus: 'stale',
        staleReasons: [message],
        projectStatuses: this.snapshot.projects.map((project) => ({
          project,
          status: 'stale',
          reason: message,
          source: this.snapshot.projectStatuses?.find((status) => status.project === project)?.source,
        })),
      };
      return this.getSnapshot();
    }

    this.snapshot = {
      projects: result.projects,
      warnings: result.warnings,
      scannedAt: result.scannedAt,
      cacheStatus: result.cacheStatus,
      staleReasons: result.staleReasons,
      projectStatuses: result.projectStatuses,
    };
    return this.getSnapshot();
  }
}

function copyDiscoveryResult(result: SkillTrackedRepoDiscoveryResult): SkillTrackedRepoDiscoveryResult {
  return {
    projects: [...result.projects],
    warnings: [...result.warnings],
    scannedAt: result.scannedAt,
    cacheStatus: result.cacheStatus,
    staleReasons: [...result.staleReasons],
    projectStatuses: result.projectStatuses.map((status) => ({ ...status })),
  };
}

/**
 * Parse `owner/repo` from a recon report's contents.
 * Preferred: YAML frontmatter `repo:` field.
 * Fallback: `# Recon Report: owner/repo` heading.
 * Returns null if neither form yields a valid slug.
 */
export function parseRepoFromReconReport(contents: string): string | null {
  const fromFrontmatter = parseFrontmatterRepo(contents);
  if (fromFrontmatter) return fromFrontmatter;

  const fromHeading = parseHeadingRepo(contents);
  if (fromHeading) return fromHeading;

  return null;
}

function parseFrontmatterRepo(contents: string): string | null {
  // Frontmatter must be at the very top of the file: --- block.
  // Allow the closing --- to sit at EOF without a trailing newline.
  const match = contents.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return null;
  const block = match[1];
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*repo\s*:\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) {
      return validateRepoSlug(m[1]);
    }
  }
  return null;
}

function parseHeadingRepo(contents: string): string | null {
  // Scan the first few non-empty lines for the heading.
  const lines = contents.split('\n');
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = line.match(/^#\s*Recon Report\s*:\s*(.+?)\s*$/i);
    if (m) {
      return validateRepoSlug(m[1]);
    }
  }
  return null;
}

/**
 * Validate `owner/repo` form from a recon-report file. Strips a leading
 * `https://github.com/` URL prefix (recon files sometimes quote URLs) and
 * then delegates to the shared strict validator so every caller across the
 * system ends up with the same canonical slug format.
 */
function validateRepoSlug(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const stripped = trimmed.replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '');
  return parseOwnerRepoSlug(stripped);
}
