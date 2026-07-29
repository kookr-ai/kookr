import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';

/**
 * Environment-blocker registry (issue #1690).
 *
 * A durable registry of *active external blockers* — conditions outside the
 * harness's control that stall delivery for many agents at once (the motivating
 * case: a GitHub Actions account-level billing limit that made every CI run die
 * in ~3s). Without a shared notion of "an external blocker is active", each
 * affected agent re-diagnoses the same blocker, either falsely completes
 * (issue #1667) or retry-spins, and the operator gets N notifications instead of
 * exactly one.
 *
 * The registry provides:
 *   - **register-once**: the first detector registers a blocker keyed by
 *     `${type}:${scope}`; subsequent {@link register} calls for the same key are
 *     idempotent and return the existing record instead of creating a duplicate.
 *   - **consult**: any agent can ask whether a matching blocker is active and, if
 *     so, receives a {@link BlockedExternalDisposition} telling it to park in the
 *     `blocked_external` state rather than re-diagnose, retry-spin, or falsely
 *     complete. This is the correct target state issue #1667's fix lands on.
 *   - **single-shot escalation**: the injected {@link EnvironmentBlockerNotifier}
 *     fires *exactly once* per active blocker (deduped via the persisted
 *     `notifiedAt` field, so a daemon restart never re-notifies). Delivery is
 *     retried on subsequent register calls until it succeeds.
 *   - **probe auto-clear**: {@link recordProbeResult} with `success: true` clears
 *     the blocker, after which {@link consult} no longer reports it — parked
 *     agents are released to resume.
 *
 * Durability follows the `idempotency-ledger.ts` pattern: an in-memory Map is the
 * authoritative state; the on-disk JSON projection is written best-effort with
 * atomic write-to-temp + fsync + rename, and reloaded on boot.
 */

export const ENVIRONMENT_BLOCKER_REGISTRY_FILE = 'environment-blockers.json';
const SCHEMA_VERSION = 'environment-blocker-registry.v1';

/**
 * A registered external blocker. `key` is the stable identity `${type}:${scope}`.
 * `type` classifies the blocker (e.g. `ci-billing`, `ci-signal-absent`,
 * `github-incident`); `scope` names the affected surface (e.g. `github-actions`).
 */
export interface EnvironmentBlocker {
  key: string;
  type: string;
  scope: string;
  /** ISO timestamp the blocker was first registered. */
  detectedAt: string;
  /** Optional id (task/agent) of the first detector, for audit. */
  detectedBy?: string;
  /** Optional human/machine description of how to re-check (the probe). */
  probe?: string;
  /** Optional free-text reason / signal that triggered registration. */
  reason?: string;
  /**
   * ISO timestamp the single human notification fired. Unset until the notifier
   * has delivered successfully; persisted so a restart never re-notifies.
   */
  notifiedAt?: string;
}

/** Input to {@link EnvironmentBlockerRegistry.register}. */
export interface RegisterBlockerInput {
  type: string;
  scope: string;
  detectedBy?: string;
  probe?: string;
  reason?: string;
}

/** Result of {@link EnvironmentBlockerRegistry.register}. */
export interface RegisterBlockerResult {
  blocker: EnvironmentBlocker;
  /** True only when this call created the blocker (first detector). */
  newlyRegistered: boolean;
}

/**
 * The disposition an agent receives from {@link EnvironmentBlockerRegistry.consult}.
 * When `blocked` is true the agent should enter the `blocked_external` state:
 * do not re-diagnose, do not retry-spin, do not complete.
 */
export type BlockedExternalDisposition =
  | { blocked: false }
  | { blocked: true; state: 'blocked_external'; blocker: EnvironmentBlocker };

/** Result of {@link EnvironmentBlockerRegistry.recordProbeResult}. */
export interface ProbeResult {
  /** True when a probe success cleared an active blocker. */
  cleared: boolean;
  /** The blocker that was cleared (present only when `cleared` is true). */
  blocker?: EnvironmentBlocker;
}

/**
 * Single-shot escalation sink. Invoked *exactly once* per active blocker (the
 * registry dedupes via `notifiedAt`). May be async; if it throws, `notifiedAt`
 * is left unset so the next register attempt retries delivery.
 */
export type EnvironmentBlockerNotifier = (blocker: EnvironmentBlocker) => void | Promise<void>;

interface EnvironmentBlockerFile {
  schemaVersion: string;
  blockers: Record<string, EnvironmentBlocker>;
}

export interface EnvironmentBlockerRegistryOptions {
  now?: () => number;
  /** Single human-notification sink; fired once per active blocker. */
  notify?: EnvironmentBlockerNotifier;
}

/** Build the stable `${type}:${scope}` identity for a blocker. */
export function environmentBlockerKey(type: string, scope: string): string {
  return `${type}:${scope}`;
}

function isValidBlocker(value: unknown): value is EnvironmentBlocker {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<EnvironmentBlocker>;
  return (
    typeof b.type === 'string' &&
    b.type.length > 0 &&
    typeof b.scope === 'string' &&
    b.scope.length > 0 &&
    typeof b.detectedAt === 'string' &&
    !Number.isNaN(Date.parse(b.detectedAt))
  );
}

export class EnvironmentBlockerRegistry {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly notify?: EnvironmentBlockerNotifier;
  private blockers = new Map<string, EnvironmentBlocker>();
  /** Async write mutex — serializes persist() across concurrent callers. */
  private writeLock: Promise<void> = Promise.resolve();
  /**
   * Keys with a notification delivery currently in flight. `notifiedAt` is only
   * stamped *after* the (possibly async) sink resolves, so this synchronous
   * guard is what actually enforces exactly-once under concurrent detection:
   * without it, a second `register()` for the same new key could enter the sink
   * before the first stamps `notifiedAt`, double-notifying the exact
   * many-detectors-at-once scenario the registry exists to dedupe.
   */
  private notifyInFlight = new Set<string>();

  constructor(kookrDir: string, options: EnvironmentBlockerRegistryOptions = {}) {
    this.filePath = join(kookrDir, ENVIRONMENT_BLOCKER_REGISTRY_FILE);
    this.now = options.now ?? Date.now;
    this.notify = options.notify;
  }

  /**
   * Load active blockers from disk. Missing/corrupt file ⇒ empty registry.
   * Unknown schemaVersion ⇒ start empty (warned). Invalid entries are skipped.
   */
  async load(): Promise<void> {
    const fallback: EnvironmentBlockerFile = { schemaVersion: SCHEMA_VERSION, blockers: {} };
    const loaded = await readJsonFile<EnvironmentBlockerFile>(this.filePath, fallback, {
      quarantineCorrupt: true,
      warningPrefix: 'environment-blocker-registry',
    });
    this.blockers.clear();
    if (!loaded || typeof loaded !== 'object' || loaded.schemaVersion !== SCHEMA_VERSION) {
      if (loaded && typeof loaded === 'object' && loaded.schemaVersion !== SCHEMA_VERSION) {
        console.warn(
          `[environment-blocker-registry] Unknown schemaVersion ${JSON.stringify(loaded.schemaVersion)}, starting empty`,
        );
      }
      return;
    }
    const entries = loaded.blockers && typeof loaded.blockers === 'object' ? loaded.blockers : {};
    for (const entry of Object.values(entries)) {
      if (!isValidBlocker(entry)) {
        console.warn('[environment-blocker-registry] Skipping invalid blocker entry');
        continue;
      }
      // Recompute the key from type/scope so a hand-edited or drifted file
      // cannot desynchronize the map key from the record's identity.
      const key = environmentBlockerKey(entry.type, entry.scope);
      this.blockers.set(key, { ...entry, key });
    }
  }

  /**
   * Register a blocker once. The first detector creates it and triggers the
   * single notification; subsequent calls for the same `${type}:${scope}` key
   * are idempotent and return the existing record. Idempotent calls still retry
   * a not-yet-delivered notification, so escalation is exactly-once-delivered.
   */
  async register(input: RegisterBlockerInput): Promise<RegisterBlockerResult> {
    const key = environmentBlockerKey(input.type, input.scope);
    const existing = this.blockers.get(key);
    if (existing) {
      // Register-once: do not overwrite detectedAt/detectedBy. Retry the single
      // notification only if a prior attempt has not yet delivered.
      if (!existing.notifiedAt) await this.tryNotify(existing);
      return { blocker: existing, newlyRegistered: false };
    }

    const blocker: EnvironmentBlocker = {
      key,
      type: input.type,
      scope: input.scope,
      detectedAt: new Date(this.now()).toISOString(),
      ...(input.detectedBy !== undefined ? { detectedBy: input.detectedBy } : {}),
      ...(input.probe !== undefined ? { probe: input.probe } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    this.blockers.set(key, blocker);
    await this.persistBestEffort('register', key);
    await this.tryNotify(blocker);
    return { blocker, newlyRegistered: true };
  }

  /**
   * Consult the registry for a blocker matching `type`/`scope`. Returns a
   * `blocked_external` disposition when one is active, else `{ blocked: false }`.
   */
  consult(type: string, scope: string): BlockedExternalDisposition {
    const blocker = this.blockers.get(environmentBlockerKey(type, scope));
    if (!blocker) return { blocked: false };
    return { blocked: true, state: 'blocked_external', blocker };
  }

  /** Fetch a single active blocker by type/scope, or undefined. */
  get(type: string, scope: string): EnvironmentBlocker | undefined {
    return this.blockers.get(environmentBlockerKey(type, scope));
  }

  /** List all active blockers. */
  list(): EnvironmentBlocker[] {
    return [...this.blockers.values()];
  }

  /** Number of active blockers (diagnostic use). */
  size(): number {
    return this.blockers.size;
  }

  /**
   * Record the outcome of a probe against a registered blocker. A success
   * clears the blocker (auto-clear) so subsequent {@link consult} calls report
   * not-blocked and parked agents are released; a failure is a no-op that keeps
   * the blocker active. Returns the cleared blocker so the caller can wake
   * parked agents / emit a recovery notice.
   */
  async recordProbeResult(type: string, scope: string, success: boolean): Promise<ProbeResult> {
    if (!success) return { cleared: false };
    return this.clear(type, scope);
  }

  /**
   * Manually clear a blocker (e.g. operator override). Returns `{ cleared:false }`
   * when no matching blocker was active.
   */
  async clear(type: string, scope: string): Promise<ProbeResult> {
    const key = environmentBlockerKey(type, scope);
    const blocker = this.blockers.get(key);
    if (!blocker) return { cleared: false };
    this.blockers.delete(key);
    await this.persistBestEffort('clear', key);
    return { cleared: true, blocker };
  }

  /**
   * Deliver the single human notification for `blocker`, then record and persist
   * `notifiedAt` so it never fires again. A no-op when no notifier is configured
   * or the blocker was already notified. On notifier failure, `notifiedAt` is
   * left unset (logged loudly) so a later register attempt retries delivery.
   */
  private async tryNotify(blocker: EnvironmentBlocker): Promise<void> {
    if (blocker.notifiedAt || !this.notify) return;
    // Synchronous in-flight guard (added/removed with no await between the
    // check and the add) so at most one delivery is ever in flight per key,
    // even when N detectors register the same blocker concurrently.
    if (this.notifyInFlight.has(blocker.key)) return;
    this.notifyInFlight.add(blocker.key);
    try {
      await this.notify(blocker);
    } catch (err) {
      console.error(
        `[environment-blocker-registry] notify(${JSON.stringify(blocker.key)}) failed; ` +
          'will retry on the next register attempt:',
        err,
      );
      return;
    } finally {
      this.notifyInFlight.delete(blocker.key);
    }
    blocker.notifiedAt = new Date(this.now()).toISOString();
    await this.persistBestEffort('notify', blocker.key);
  }

  /**
   * `persist()` wrapped so a disk failure never propagates to callers. Durability
   * is best-effort by design: the in-memory Map (already updated before this runs)
   * stays authoritative, so a failed write only risks cross-restart durability.
   * Logged loudly so a persistently-failing disk is visible in server logs.
   */
  private async persistBestEffort(op: string, key: string): Promise<void> {
    try {
      await this.persist();
    } catch (err) {
      console.error(
        `[environment-blocker-registry] ${op}(${JSON.stringify(key)}): failed to persist registry to disk. ` +
          'In-memory state is unaffected, but this change will NOT survive a restart until the next successful write:',
        err,
      );
    }
  }

  private async persist(): Promise<void> {
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      const blockers: Record<string, EnvironmentBlocker> = {};
      for (const [key, blocker] of this.blockers) {
        blockers[key] = blocker;
      }
      const file: EnvironmentBlockerFile = { schemaVersion: SCHEMA_VERSION, blockers };
      await atomicWriteFile(this.filePath, JSON.stringify(file, null, 2));
    } finally {
      release();
    }
  }
}
