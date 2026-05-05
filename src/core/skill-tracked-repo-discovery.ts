import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOwnerRepoSlug } from '../shared/repo-slug.js';

export interface SkillTrackedRepoDiscoveryResult {
  /** Normalized project IDs (e.g. "github.com/owner/repo"). */
  projects: string[];
  /** Human-readable warnings for directories that were skipped or malformed. */
  warnings: string[];
  /** ISO timestamp for when discovery completed. */
  scannedAt: string;
}

export interface SkillDiscoveryStateSnapshot {
  /** Project IDs from the last successful discovery (last-known-good). */
  projects: string[];
  /** Warnings from the most recent scan attempt. */
  warnings: string[];
  /** ISO timestamp of the last successful scan (if any). */
  scannedAt?: string;
  /** Non-null if the latest rescan attempt failed wholesale and state is stale. */
  lastError?: string;
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

  constructor(claudeDir: string) {
    this.claudeDir = claudeDir;
  }

  async discover(): Promise<SkillTrackedRepoDiscoveryResult> {
    const scannedAt = new Date().toISOString();
    const projects: string[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();

    let entries: string[];
    try {
      entries = await readdir(this.claudeDir);
    } catch {
      // Missing or unreadable ~/.claude is not an error; treat as empty.
      return { projects: [], warnings: [], scannedAt };
    }

    for (const entry of entries) {
      if (!entry.endsWith('-recon')) continue;

      const dirPath = join(this.claudeDir, entry);
      let dirStat;
      try {
        dirStat = await stat(dirPath);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const reportPath = join(dirPath, 'recon-report.md');
      let raw: string;
      try {
        raw = await readFile(reportPath, 'utf-8');
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
    }

    projects.sort();
    return { projects, warnings, scannedAt };
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
      };
      return this.getSnapshot();
    }

    this.snapshot = {
      projects: result.projects,
      warnings: result.warnings,
      scannedAt: result.scannedAt,
    };
    return this.getSnapshot();
  }
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
