import { watch, type FSWatcher } from 'node:fs';
import { readFile, access, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import type {
  AttemptState,
  ContributionAttempt,
  IssueCheckError,
  LedgerEntry,
  LinkedIssueState,
  ObservationSource,
  StateObservation,
} from '../shared/contracts/oss-attempts.js';
import {
  extractRepoSpecifierFromGhCommand,
  extractShellCwd,
  getProjectId,
  projectIdFromPrUrl,
  projectIdFromRepoSpecifier,
} from './project-identity.js';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';
import { appendJsonlWithRotation } from './jsonl-rotation.js';

const OSS_ATTEMPTS_SCHEMA_VERSION = 1;

/** Rotate the contribution ledger before an append would exceed this size. */
export const DEFAULT_CONTRIBUTION_LEDGER_MAX_BYTES = 4 * 1024 * 1024;
/** Rotated generations retained by default (keeps `.1` and `.2`). */
export const DEFAULT_CONTRIBUTION_LEDGER_ROTATED_GENERATIONS = 2;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

/**
 * Default retention window (ms) for terminal (`merged` / `closed`) OSS attempt
 * records before {@link OssAttemptStore.pruneTerminalAttempts} may drop them.
 * 90 days keeps recent dashboard/dedup history without unbounded growth.
 * Override with `KOOKR_OSS_ATTEMPT_RETENTION_MS`. Rate-limit authority stays in
 * the append-only contribution ledger, which this retention never rewrites.
 */
export const DEFAULT_OSS_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Parse `KOOKR_OSS_ATTEMPT_RETENTION_MS` from process.env. Returns the default
 * when the var is unset, blank, or unparseable. A value of `0` is honoured
 * (prune every terminal attempt immediately); negative values fall back to the
 * default rather than a surprising future cutoff.
 */
export function readOssAttemptRetentionMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaultMs = DEFAULT_OSS_ATTEMPT_RETENTION_MS,
): number {
  const raw = env.KOOKR_OSS_ATTEMPT_RETENTION_MS;
  if (raw == null || raw.trim() === '') return defaultMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultMs;
  return parsed;
}

/**
 * Ms timestamp at which an attempt entered a terminal (`merged` / `closed`)
 * state, or `null` if it is still active (`scouted` / `pr_open`) or has no
 * parseable terminal stamp. Prefers `closing.closedAt`, then the last history
 * entry's `at`. Missing/unparseable stamps keep the record (conservative).
 */
function attemptTerminalAtMs(attempt: ContributionAttempt): number | null {
  if (attempt.state !== 'merged' && attempt.state !== 'closed') return null;

  if (attempt.closing?.closedAt) {
    const closedMs = Date.parse(attempt.closing.closedAt);
    if (!Number.isNaN(closedMs)) return closedMs;
  }

  const lastHistory = attempt.history[attempt.history.length - 1];
  if (lastHistory?.at) {
    const historyMs = Date.parse(lastHistory.at);
    if (!Number.isNaN(historyMs)) return historyMs;
  }

  return null;
}

export type {
  AttemptState,
  ClosingInfo,
  ContributionAttempt,
  IssueCheckError,
  LedgerAction,
  LedgerEntry,
  LinkedIssueState,
  ObservationSource,
  StateObservation,
} from '../shared/contracts/oss-attempts.js';

/**
 * On-disk shape of `oss-attempts.json`. Internal to the store — consumers
 * that need a read-model should use the `OssAttemptsSnapshot` wire type
 * (see `shared/contracts/messages.ts`) which is shaped for the dashboard.
 */
interface OssAttemptStoreFile {
  schemaVersion: number;
  attempts: ContributionAttempt[];
  lastRefreshAt: string | null;
  /**
   * PR-granular issue-state fetch failures from the most recent refresh run.
   * Flows through the snapshot so the dashboard can surface a warning banner
   * regardless of which refresh path produced the errors. Optional for
   * backward compatibility with files written before this feature shipped.
   */
  lastRefreshIssueCheckErrors?: IssueCheckError[];
}

/**
 * Default own-namespaces excluded from OSS tracking.
 * Keep as a module-level constant for now; promote to settings when a second namespace is needed.
 * `jeanibarz` is the legacy personal namespace; `kookr-ai` is the canonical project namespace.
 */
const DEFAULT_OWN_NAMESPACES = ['jeanibarz', 'kookr-ai'];

export function isExternalRepo(
  repo: string,
  ownNamespaces: readonly string[] = DEFAULT_OWN_NAMESPACES,
): boolean {
  const owner = repo.split('/')[0]?.toLowerCase();
  if (!owner) return false;
  return !ownNamespaces.some((ns) => ns.toLowerCase() === owner);
}

// --- Project-ID helpers for ledger ingestion ---

/**
 * Resolve the best available project ID for a contribution ledger entry.
 *
 * Prefers PR URLs and explicit `gh pr create -R/--repo` flags over the raw
 * repo recorded in the ledger. This lets the server recover the real target
 * project when the outer session CWD points at Kookr but the command shells
 * into another repository before opening the PR.
 *
 * Returns a `github.com/owner/repo` project ID.
 */
async function ledgerEntryToProjectId(
  entry: Pick<LedgerEntry, 'repo' | 'prUrl' | 'command'>,
): Promise<string> {
  const fromUrl = entry.prUrl ? projectIdFromPrUrl(entry.prUrl) : null;
  if (fromUrl) return fromUrl;

  const repoSpecifier = entry.command ? extractRepoSpecifierFromGhCommand(entry.command) : null;
  const fromCommandRepo = repoSpecifier ? projectIdFromRepoSpecifier(repoSpecifier) : null;
  if (fromCommandRepo) return fromCommandRepo;

  const commandCwd = entry.command ? extractShellCwd(entry.command) : null;
  if (commandCwd && isAbsolute(commandCwd)) {
    try {
      const projectId = await getProjectId(resolve(commandCwd));
      if (projectId && !projectId.startsWith('local/')) return projectId;
    } catch {
      // Fall through to the ledger repo value.
    }
  }

  const fallback = projectIdFromRepoSpecifier(entry.repo);
  return fallback ?? `github.com/${entry.repo.toLowerCase()}`;
}

/** Extract `owner/repo` variants from a project ID. Returns a single-entry list for remote project IDs (`github.com/owner/repo` → `owner/repo`) or the lowercased input for local project IDs. */
export function projectIdToRepoVariants(projectId: string): string[] {
  const parts = projectId.split('/');
  if (parts.length >= 3) {
    return [parts.slice(1).join('/').toLowerCase()];
  }
  return [projectId.toLowerCase()];
}

export function projectIdForRepo(repo: string): string {
  return `github.com/${repo.toLowerCase()}`;
}

// --- Store ---

export interface OssAttemptStoreOptions {
  ownNamespaces?: readonly string[];
  /**
   * Size cap for the active `contribution-ledger.jsonl` before rotation.
   * Defaults to `KOOKR_CONTRIBUTION_LEDGER_MAX_BYTES` or 4 MiB.
   */
  ledgerMaxBytes?: number;
  /**
   * Number of rotated ledger generations (`.1` … `.N`) to retain.
   * Defaults to `KOOKR_CONTRIBUTION_LEDGER_ROTATE_KEEP` or 2.
   */
  ledgerRotatedGenerations?: number;
}

export class OssAttemptStore {
  private attempts: ContributionAttempt[] = [];
  private lastRefreshAt: string | null = null;
  private lastRefreshIssueCheckErrors: IssueCheckError[] = [];
  private filePath: string;
  private ledgerPath: string;
  private ledgerEntries: LedgerEntry[] = [];
  private ownNamespaces: readonly string[];
  private readonly ledgerMaxBytes: number;
  private readonly ledgerRotatedGenerations: number;
  /** Async write mutex — serializes save() calls across concurrent async callers. */
  private writeLock: Promise<void> = Promise.resolve();
  /**
   * Serializes ledger append/rotate so concurrent writers cannot race the
   * stat/rotate/append sequence (same pattern as training-data / budget-burn).
   */
  private ledgerAppendQueue: Promise<void> = Promise.resolve();

  constructor(
    kookrDir: string,
    options: OssAttemptStoreOptions = {},
  ) {
    this.filePath = join(kookrDir, 'oss-attempts.json');
    this.ledgerPath = join(kookrDir, 'contribution-ledger.jsonl');
    this.ownNamespaces = options.ownNamespaces ?? DEFAULT_OWN_NAMESPACES;
    this.ledgerMaxBytes =
      options.ledgerMaxBytes ??
      readPositiveIntEnv(
        'KOOKR_CONTRIBUTION_LEDGER_MAX_BYTES',
        DEFAULT_CONTRIBUTION_LEDGER_MAX_BYTES,
      );
    this.ledgerRotatedGenerations =
      options.ledgerRotatedGenerations ??
      readPositiveIntEnv(
        'KOOKR_CONTRIBUTION_LEDGER_ROTATE_KEEP',
        DEFAULT_CONTRIBUTION_LEDGER_ROTATED_GENERATIONS,
      );
  }

  getOwnNamespaces(): readonly string[] {
    return this.ownNamespaces;
  }

  /** Watch the append-only contribution ledger without exposing its path. */
  watchLedger(onChange: () => void): FSWatcher {
    return watch(this.ledgerPath, onChange);
  }

  /** Append one contribution-ledger entry without exposing the ledger path. */
  async appendLedgerEntry(entry: LedgerEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    const run = this.ledgerAppendQueue
      .catch(() => {
        /* keep the queue alive after an earlier write failure */
      })
      .then(() =>
        appendJsonlWithRotation(this.ledgerPath, line, {
          maxBytes: this.ledgerMaxBytes,
          rotatedGenerations: this.ledgerRotatedGenerations,
        }),
      );
    this.ledgerAppendQueue = run;
    await run;
  }

  async load(): Promise<void> {
    const fallback: OssAttemptStoreFile = {
      schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
      attempts: [],
      lastRefreshAt: null,
    };
    const loaded = await readJsonFile<OssAttemptStoreFile>(this.filePath, fallback, {
      quarantineCorrupt: true,
      warningPrefix: 'oss-attempt-store',
    });
    if (loaded.schemaVersion !== OSS_ATTEMPTS_SCHEMA_VERSION) {
      console.warn(
        `[oss-attempt-store] Unknown schemaVersion ${loaded.schemaVersion}, falling back to empty store`,
      );
      this.attempts = [];
      this.lastRefreshAt = null;
      return;
    }
    // Validate records; skip invalid ones with a warning
    const valid: ContributionAttempt[] = [];
    for (const a of Array.isArray(loaded.attempts) ? loaded.attempts : []) {
      if (this.isValidAttempt(a)) {
        valid.push(a);
      } else {
        console.warn(`[oss-attempt-store] Skipping invalid record: ${JSON.stringify(a).slice(0, 120)}`);
      }
    }
    this.attempts = valid;
    this.lastRefreshAt = loaded.lastRefreshAt ?? null;
    this.lastRefreshIssueCheckErrors = Array.isArray(loaded.lastRefreshIssueCheckErrors)
      ? loaded.lastRefreshIssueCheckErrors
      : [];

    // Compact aged terminal attempts so neither memory nor the next durable
    // write grows without bound. Best-effort: a persist failure must not block
    // startup — in-memory compaction already took effect for this process.
    try {
      const removed = this.pruneTerminalAttempts();
      if (removed > 0) {
        await this.save();
      }
    } catch (err) {
      console.warn(
        `[oss-attempt-store] Prune-on-load failed to persist compaction: ${String(err)}`,
      );
    }
  }

  /**
   * Drop attempts whose latest state is terminal (`merged` or `closed`) and
   * whose terminal timestamp is older than `retentionMs`. Active states
   * (`scouted`, `pr_open`) are never removed. Does not read or rewrite
   * `contribution-ledger.jsonl` — rate-limit accounting stays intact.
   *
   * Compacts the in-memory array only; callers that need durability should
   * `save()` (or rely on load-time auto-persist when removals occur). Returns
   * the number of attempts pruned.
   *
   * A negative `retentionMs` is clamped to `0` (prune every already-terminal
   * attempt) rather than treated as a future cutoff.
   */
  pruneTerminalAttempts(
    retentionMs: number = readOssAttemptRetentionMsFromEnv(),
  ): number {
    const cutoffMs = Date.now() - Math.max(0, retentionMs);
    const before = this.attempts.length;
    this.attempts = this.attempts.filter((attempt) => {
      const terminalMs = attemptTerminalAtMs(attempt);
      // Keep active records and terminal records still inside the window (or
      // with no parseable stamp — conservative retention).
      if (terminalMs === null) return true;
      return terminalMs >= cutoffMs;
    });
    return before - this.attempts.length;
  }

  /**
   * Load `pr_created` entries from the append-only `contribution-ledger.jsonl`
   * (and retained rotated generations `.1` … `.N`) and fold them into the
   * attempts list. Ledger is the authoritative source for PR *creation*
   * counts (incl. slot_reset accounting); the attempts list is the
   * authoritative source for PR *lifecycle* (state, closing details, linked
   * issue).
   *
   * Safe to call repeatedly — `upsertPr` is idempotent keyed on
   * `${repo}#${prNumber}`, and we only emit a history entry when the state
   * actually changes. Ledger entries missing a PR number (malformed or
   * pre-refactor) are still recorded as ledger history for blocked-banner
   * surfacing but do not create a synthetic attempt.
   *
   * Rotated generations are included so rate-limit / weekly counts remain
   * correct for the size-based retention window after rotation.
   */
  async loadFromLedger(): Promise<void> {
    this.ledgerEntries = [];

    // Oldest generation first, then active — keeps in-memory order roughly
    // chronological (`.N` is oldest rotated, active is newest).
    const paths: string[] = [];
    for (let gen = this.ledgerRotatedGenerations; gen >= 1; gen -= 1) {
      paths.push(`${this.ledgerPath}.${gen}`);
    }
    paths.push(this.ledgerPath);

    let anyLoaded = false;
    for (const path of paths) {
      let raw: string;
      try {
        await access(path);
        raw = await readFile(path, 'utf-8');
      } catch {
        continue;
      }
      anyLoaded = true;
      const lines = raw.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LedgerEntry;
          if (entry.timestamp && entry.repo && entry.action) {
            this.ledgerEntries.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
    if (!anyLoaded) return;

    // Ingest pr_created entries into the attempts list. Only external repos
    // get persisted attempts; internal-namespace entries still live in
    // `ledgerEntries` for rate-limit accounting but are not tracked as PRs.
    //
    // Aged entries (older than the terminal-attempt retention window) do not
    // create *new* attempt rows: otherwise prune-on-load would be undone on
    // every restart by re-upserting long-closed PRs as `pr_open`. Ledger
    // entries themselves stay in `ledgerEntries` for rate-limit math.
    const retentionMs = readOssAttemptRetentionMsFromEnv();
    const ledgerCutoffMs = Date.now() - Math.max(0, retentionMs);

    for (const entry of this.ledgerEntries) {
      if (entry.action !== 'pr_created') continue;
      if (!isExternalRepo(entry.repo, this.ownNamespaces)) continue;
      const prUrl = entry.prUrl;
      if (!prUrl) continue;
      const prNumber = parsePrNumberFromUrl(prUrl);
      if (prNumber == null) continue;

      const projectId = await ledgerEntryToProjectId(entry);
      const repo = projectIdToRepoVariants(projectId)[0] ?? entry.repo.toLowerCase();

      const attemptId = `${repo}#${prNumber}`;
      const alreadyTracked = this.attempts.some((a) => a.id === attemptId);
      if (!alreadyTracked) {
        const entryMs = Date.parse(entry.timestamp);
        if (!Number.isNaN(entryMs) && entryMs < ledgerCutoffMs) {
          continue;
        }
      }

      const upserted = this.upsertPr({
        repo,
        prNumber,
        prUrl,
        prTitle: '',
        state: 'pr_open',
        at: entry.timestamp,
        source: 'ledger',
        note: null,
      });
      // Attach originating task on first observation; never overwrite.
      if (upserted && entry.taskId && !upserted.taskId) {
        upserted.taskId = entry.taskId;
      }
    }
  }

  private isValidAttempt(a: unknown): a is ContributionAttempt {
    if (!a || typeof a !== 'object') return false;
    const o = a as Record<string, unknown>;
    return (
      typeof o.id === 'string' &&
      typeof o.repo === 'string' &&
      typeof o.state === 'string' &&
      ['scouted', 'pr_open', 'merged', 'closed'].includes(o.state as string) &&
      Array.isArray(o.history)
    );
  }

  async save(): Promise<void> {
    // Serialize writes through the mutex so concurrent async callers don't interleave.
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      // Compact aged terminal attempts before every durable write so the on-disk
      // file stays bounded even without a process restart (store-local GC).
      this.pruneTerminalAttempts();
      const file: OssAttemptStoreFile = {
        schemaVersion: OSS_ATTEMPTS_SCHEMA_VERSION,
        attempts: this.attempts,
        lastRefreshAt: this.lastRefreshAt,
        lastRefreshIssueCheckErrors: this.lastRefreshIssueCheckErrors,
      };
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2));
    } finally {
      release();
    }
  }

  /** Test helper: reset all attempts and ledger-derived counters. */
  async clearForTests(): Promise<void> {
    this.attempts = [];
    this.ledgerEntries = [];
    this.lastRefreshAt = null;
    this.lastRefreshIssueCheckErrors = [];
    await this.save();
    await writeFile(this.ledgerPath, '');
  }

  /** Set the last-refresh timestamp (called at the end of a successful refresh). */
  setLastRefreshAt(iso: string): void {
    this.lastRefreshAt = iso;
  }

  getLastRefreshAt(): string | null {
    return this.lastRefreshAt;
  }

  /**
   * Record the issue-state fetch failures from the most recent refresh run.
   * Written at end-of-run by the refresher. Consumers read via the wire
   * snapshot. An empty array clears the dashboard's warning banner on the
   * next successful refresh.
   */
  setLastRefreshIssueCheckErrors(errors: IssueCheckError[]): void {
    this.lastRefreshIssueCheckErrors = [...errors];
  }

  getLastRefreshIssueCheckErrors(): IssueCheckError[] {
    return [...this.lastRefreshIssueCheckErrors];
  }

  /**
   * Get every stored attempt as a deep clone. Deep-cloning matters because
   * the refresher may mutate `linkedIssue` in-place on stored records while
   * a snapshot consumer is iterating — without a deep clone, the consumer
   * would observe a torn mid-mutation state on per-repo save. `structuredClone`
   * is available in Node ≥17.
   */
  getAllAttempts(): ContributionAttempt[] {
    return structuredClone(this.attempts);
  }

  /**
   * Read-only view of the internal attempts array with no cloning. Intended
   * for `LedgerAnalytics` aggregations that only inspect records and never
   * mutate them — skipping `structuredClone` keeps `broadcastProjectSummaries`
   * from paying an N-per-project deep-clone tax. Matches the previous behavior
   * of the analytics methods when they lived on this class. Do NOT use from
   * snapshot/broadcast paths that could race with the refresher's in-place
   * `linkedIssue` mutations — use `getAllAttempts()` there instead.
   */
  getAttemptsReadonly(): readonly ContributionAttempt[] {
    return this.attempts;
  }

  /** Get attempts for one repo (defensive copy). */
  getByRepo(repo: string): ContributionAttempt[] {
    return this.attempts.filter((a) => a.repo.toLowerCase() === repo.toLowerCase());
  }

  /**
   * Secondary-index lookup: return all attempts (scouted or PR-keyed) that cover the
   * given (repo, issueNumber) tuple. Used by oss-issue-scout for dedup — NFM-1 from round 2.
   */
  findByRepoIssue(repo: string, issueNumber: number): ContributionAttempt[] {
    return this.attempts.filter(
      (a) =>
        a.repo.toLowerCase() === repo.toLowerCase() &&
        a.issueNumber === issueNumber,
    );
  }

  /**
   * Scout dedup decision for one (repo, issue) tuple.
   *
   * Rules:
   *   - If ANY record for (repo, issue) is in state pr_open or merged → { decision: 'exclude' }
   *   - Else if the MOST RECENT record is closed → { decision: 'demote', closingComment }
   *   - Else (scouted-only, or no records) → { decision: 'allow' }
   */
  dedupeScout(repo: string, issueNumber: number): ScoutDedupResult {
    const records = this.findByRepoIssue(repo, issueNumber);
    if (records.length === 0) return { decision: 'allow' };

    for (const r of records) {
      if (r.state === 'pr_open' || r.state === 'merged') {
        return { decision: 'exclude', prNumber: r.prNumber, reason: r.state };
      }
    }

    // Most recent by updatedAt
    const mostRecent = records.slice().sort((a, b) =>
      (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    )[0];
    if (mostRecent.state === 'closed') {
      return {
        decision: 'demote',
        prNumber: mostRecent.prNumber,
        closingComment: mostRecent.closing?.closingComment?.slice(0, 80) ?? null,
      };
    }
    return { decision: 'allow' };
  }

  /**
   * Emit a scouted observation. Creates an issue-keyed record if none exists, or
   * appends a scouted observation to an existing issue-keyed record. Never upgrades
   * a scouted record to a PR-keyed one — a subsequent PR gets its own record.
   *
   * External-only: refuses to track own-namespace repos.
   */
  upsertScouted(input: ScoutEmitInput): ContributionAttempt | null {
    if (!isExternalRepo(input.repo, this.ownNamespaces)) return null;
    const now = input.at ?? new Date().toISOString();
    const id = `${input.repo}#issue-${input.issueNumber}`;
    const existing = this.attempts.find((a) => a.id === id);
    const observation: StateObservation = {
      state: 'scouted',
      at: now,
      source: 'scout_emit',
      note: input.note ?? null,
      url: input.issueUrl ?? null,
    };
    if (existing) {
      existing.history.push(observation);
      existing.updatedAt = now;
      // state stays as-is; scouted does not override later states
      return existing;
    }
    const attempt: ContributionAttempt = {
      id,
      repo: input.repo,
      issueNumber: input.issueNumber,
      issueUrl: input.issueUrl ?? null,
      prNumber: null,
      prUrl: null,
      prTitle: null,
      state: 'scouted',
      history: [observation],
      closing: null,
      createdAt: now,
      updatedAt: now,
    };
    this.attempts.push(attempt);
    return attempt;
  }

  /**
   * Upsert a PR-keyed record from a hook capture or backfill.
   * - Creates a new record if none exists for (repo, prNumber)
   * - If an existing record is found, appends an observation
   * - Clears the closing field when a closed record transitions back to pr_open
   */
  upsertPr(input: PrCreatedInput): ContributionAttempt | null {
    if (!isExternalRepo(input.repo, this.ownNamespaces)) return null;
    const now = input.at ?? new Date().toISOString();
    const id = `${input.repo}#${input.prNumber}`;
    const newState: AttemptState = input.state ?? 'pr_open';
    const observation: StateObservation = {
      state: newState,
      at: now,
      source: input.source,
      note: input.note ?? null,
      url: input.prUrl,
    };

    let existing = this.attempts.find((a) => a.id === id);
    if (!existing) {
      existing = {
        id,
        repo: input.repo,
        issueNumber: input.issueNumber ?? null,
        issueUrl: null,
        prNumber: input.prNumber,
        prUrl: input.prUrl,
        prTitle: input.prTitle,
        state: newState,
        history: [observation],
        closing: null,
        createdAt: now,
        updatedAt: now,
      };
      this.attempts.push(existing);
      return existing;
    }

    // Update fields that can genuinely change
    existing.prUrl = input.prUrl;
    existing.prTitle = input.prTitle || existing.prTitle;
    if (input.issueNumber != null && existing.issueNumber == null) {
      existing.issueNumber = input.issueNumber;
    }

    // Clear closing data if we're transitioning back to pr_open (reopen)
    if (existing.state === 'closed' && newState === 'pr_open') {
      existing.closing = null;
    }

    // Only append a history entry if the state actually changed, OR if this is
    // a fresh observation from a different source (hook captures may repeat).
    const lastObservation = existing.history[existing.history.length - 1];
    const sameAsLast =
      lastObservation?.state === newState && lastObservation?.source === input.source;
    if (!sameAsLast) {
      existing.history.push(observation);
    }

    existing.state = newState;
    existing.updatedAt = now;
    return existing;
  }

  /**
   * Apply a refresh update from gh pr list. Similar to upsertPr but sourced from
   * refresh_poll or backfill. Forwards `issueNumber` so the secondary-index dedup
   * in `findByRepoIssue` actually works on records captured by the refresh path.
   */
  upsertFromRefresh(input: PrRefreshInput): ContributionAttempt | null {
    return this.upsertPr({
      repo: input.repo,
      prNumber: input.prNumber,
      prUrl: input.prUrl,
      prTitle: input.prTitle,
      issueNumber: input.issueNumber ?? null,
      state: input.state,
      at: input.at,
      source: input.source,
      note: null,
    });
  }

  /**
   * Attach the verified linked-issue state to a PR-keyed record. Mirrors
   * `attachClosing` in shape — the refresher is the sole caller. A missing
   * record is a silent no-op (the record may have been removed between
   * upsert and this call in a concurrent mutation; acceptable).
   *
   * Bumps `updatedAt` because the linked-issue verification *is* a
   * meaningful state change for the record, even though it's not a
   * PR-state change.
   */
  attachLinkedIssue(repo: string, prNumber: number, value: LinkedIssueState | null): void {
    const id = `${repo}#${prNumber}`;
    const existing = this.attempts.find((a) => a.id === id);
    if (!existing) return;
    existing.linkedIssue = value;
    existing.updatedAt = new Date().toISOString();
  }

  /**
   * Attach closing details (closer login + comment) and, when available, the
   * linked `issueNumber` to a closed PR record. The latter makes the scout's
   * `(repo, issueNumber)` secondary-index dedup functional for closed PRs
   * captured via the refresh detail-fetch path.
   */
  attachClosing(input: ClosingDetailInput): void {
    const id = `${input.repo}#${input.prNumber}`;
    const existing = this.attempts.find((a) => a.id === id);
    if (!existing) return;
    existing.closing = {
      closedAt: input.closedAt,
      closerLogin: input.closerLogin,
      closingComment: input.closingComment.slice(0, MAX_CLOSING_COMMENT_CHARS),
    };
    if (input.issueNumber != null && existing.issueNumber == null) {
      existing.issueNumber = input.issueNumber;
    }
    existing.updatedAt = new Date().toISOString();
  }

  /**
   * Raw accessor for the ingested ledger entries. I/O boundary of the store:
   * callers that need read-model queries should construct a `LedgerAnalytics`
   * (see `src/core/ledger-analytics.ts`) rather than poking at entries
   * directly. Returned array is a defensive copy.
   */
  getAllLedgerEntries(): LedgerEntry[] {
    return [...this.ledgerEntries];
  }
}

// --- Upsert input shapes (internal — declared after the class because
// their names are referenced from method signatures above) ---

const MAX_CLOSING_COMMENT_CHARS = 500;

interface ScoutEmitInput {
  repo: string;
  issueNumber: number;
  issueUrl?: string | null;
  at?: string;
  note?: string | null;
}

interface PrCreatedInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  issueNumber?: number | null;
  state?: 'pr_open' | 'merged' | 'closed';
  at?: string;
  source: ObservationSource;
  note?: string | null;
}

interface PrRefreshInput {
  repo: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  state: 'pr_open' | 'merged' | 'closed';
  /**
   * Linked issue number when the PR declares one via `closingIssuesReferences`
   * (Fixes/Closes/Resolves #N). Populating this is what makes the (repo, issueNumber)
   * secondary index in `dedupeScout` functional in production — without it, a
   * historical closed PR keyed by `${repo}#${prNumber}` cannot be matched against
   * a fresh scout candidate that only knows the issue number.
   */
  issueNumber?: number | null;
  at?: string;
  source: ObservationSource;
}

interface ClosingDetailInput {
  repo: string;
  prNumber: number;
  closedAt: string;
  closerLogin: string | null;
  closingComment: string;
  /**
   * Issue number linked via `closingIssuesReferences`, available only on the
   * per-PR `gh pr view` path. Setting this on a closed record lets the scout's
   * `(repo, issueNumber)` secondary-index find the record during dedup.
   */
  issueNumber?: number | null;
}

interface ScoutDedupResult {
  decision: 'allow' | 'exclude' | 'demote';
  prNumber?: number | null;
  reason?: 'pr_open' | 'merged' | 'closed';
  closingComment?: string | null;
}

// --- Helpers ---

function parsePrNumberFromUrl(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}
