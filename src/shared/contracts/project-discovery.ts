export type SkillDiscoveryScanStatus = 'scanned' | 'skipped' | 'stale';

export interface SkillDiscoveryProjectStatus {
  /** Normalized project ID (e.g. "github.com/owner/repo"). */
  project: string;
  /** Whether this project was freshly scanned, skipped by cache, or carried stale after failure. */
  status: SkillDiscoveryScanStatus;
  /** Human-readable reason for the status. */
  reason: string;
  /** Source recon directory that produced the project, when known. */
  source?: string;
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
  /** Whether the latest rescan scanned files, skipped by cache, or returned stale state after failure. */
  cacheStatus?: SkillDiscoveryScanStatus;
  /** Reasons the previous cache was stale, or why the current state is stale after failure. */
  staleReasons?: string[];
  /** Per-project scan/cache/stale status for diagnostics and UI surfaces. */
  projectStatuses?: SkillDiscoveryProjectStatus[];
}
