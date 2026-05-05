import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOwnerRepoSlug } from '../shared/repo-slug.js';

export interface PrLessonsState {
  totalProcessed: number;
  distillationCount: number;
  rawLearningsLines: number;
}

export interface PrLessonsDiscoveryResult {
  /** Map from normalized project ID to PR lessons state. */
  states: Map<string, PrLessonsState>;
  warnings: string[];
  scannedAt: string;
}

/**
 * Discover PR lessons state from `~/.claude/*-pr-lessons/state.json`.
 *
 * Each directory contains a `state.json` with `repo`, `total_processed`,
 * `distillation_count`, and optionally a `learnings-raw.md` whose line count
 * indicates distillation proximity.
 *
 * Purely read-only: never writes to `~/.claude`.
 */
export class PrLessonsDiscovery {
  private claudeDir: string;

  constructor(claudeDir: string) {
    this.claudeDir = claudeDir;
  }

  async discover(): Promise<PrLessonsDiscoveryResult> {
    const scannedAt = new Date().toISOString();
    const states = new Map<string, PrLessonsState>();
    const warnings: string[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.claudeDir);
    } catch {
      return { states, warnings, scannedAt };
    }

    for (const entry of entries) {
      if (!entry.endsWith('-pr-lessons')) continue;

      const dirPath = join(this.claudeDir, entry);
      let dirStat;
      try {
        dirStat = await stat(dirPath);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      const statePath = join(dirPath, 'state.json');
      let raw: string;
      try {
        raw = await readFile(statePath, 'utf-8');
      } catch {
        warnings.push(`${entry}: state.json not readable`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        warnings.push(`${entry}: state.json is not valid JSON`);
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        warnings.push(`${entry}: state.json is not an object`);
        continue;
      }

      const obj = parsed as Record<string, unknown>;
      const repoSlug = parseOwnerRepoSlug(obj.repo);
      if (!repoSlug) {
        warnings.push(`${entry}: invalid or missing repo field`);
        continue;
      }

      const totalProcessed = typeof obj.total_processed === 'number' ? obj.total_processed : 0;
      const distillationCount = typeof obj.distillation_count === 'number' ? obj.distillation_count : 0;

      // Count lines in learnings-raw.md if it exists.
      let rawLearningsLines = 0;
      try {
        const rawMd = await readFile(join(dirPath, 'learnings-raw.md'), 'utf-8');
        rawLearningsLines = rawMd.split('\n').length;
      } catch {
        // Missing file is fine — no raw learnings yet.
      }

      const projectId = `github.com/${repoSlug}`;
      states.set(projectId, { totalProcessed, distillationCount, rawLearningsLines });
    }

    return { states, warnings, scannedAt };
  }
}

/**
 * Server-owned PR lessons state with last-known-good semantics.
 * Same pattern as SkillDiscoveryStateHolder.
 */
export class PrLessonsStateHolder {
  private states: Map<string, PrLessonsState> = new Map();
  private warnings: string[] = [];
  private scannedAt?: string;
  private lastError?: string;
  private discovery: PrLessonsDiscovery;
  private inFlight: Promise<void> | null = null;

  constructor(discovery: PrLessonsDiscovery) {
    this.discovery = discovery;
  }

  getSnapshot(): { states: Map<string, PrLessonsState>; warnings: string[]; scannedAt?: string; lastError?: string } {
    return {
      states: new Map(this.states),
      warnings: [...this.warnings],
      scannedAt: this.scannedAt,
      lastError: this.lastError,
    };
  }

  getForProject(projectId: string): PrLessonsState | undefined {
    return this.states.get(projectId);
  }

  async rescan(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRescan().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runRescan(): Promise<void> {
    let result: PrLessonsDiscoveryResult;
    try {
      result = await this.discovery.discover();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }

    this.states = result.states;
    this.warnings = result.warnings;
    this.scannedAt = result.scannedAt;
    this.lastError = undefined;
  }
}
