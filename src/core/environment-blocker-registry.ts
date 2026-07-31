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
 *   - **escalation**: the injected {@link EnvironmentBlockerNotifier} fires with
 *     an {@link EnvironmentBlockerEscalation} carrying the blocker plus the
 *     *quantified running cost* of the blocker (CI-blind merge count,
 *     retro-verify queue depth, blocked-capability list). Ordinary blockers
 *     escalate *once* (deduped via the persisted `lastEscalatedAt`, so a daemon
 *     restart never re-notifies); delivery is retried on subsequent register
 *     calls until it succeeds.
 *   - **re-escalation heartbeat** (issue #1702): blockers tagged
 *     `requiresHuman` — those only a human can clear (e.g. a GitHub Actions
 *     billing limit) — re-escalate on a staleness TTL ({@link staleTtlMs},
 *     default 24h) instead of firing once, so a human-authority blocker that
 *     sits open keeps surfacing (with its compounding cost) rather than being
 *     escalated once and forgotten. {@link heartbeat} sweeps due blockers.
 *   - **tolerance-regime tracking** (issue #1702): each blocker records the
 *     tolerance-machinery already built for it ({@link recordRegimeEntry}); once
 *     a regime exists ({@link hasRegime}) the emission budget refuses *new*
 *     tolerance machinery for the same blocker (see `emission-budget.ts`), so
 *     the harness stops paying to tolerate what it should escalate.
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
 * Default staleness TTL for `requiresHuman` re-escalation (issue #1702). A
 * human-authority blocker re-escalates once this long has elapsed since its
 * previous escalation, so a blocker only a human can clear keeps surfacing
 * instead of firing a single buried notification. 24h by design: long enough
 * not to nag within a working session, short enough that a multi-day stall
 * (the motivating lucy #1748 case sat 2+ days) re-fires daily.
 */
export const DEFAULT_STALE_ESCALATION_TTL_MS = 24 * 60 * 60 * 1000;

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
   * True when only a human can clear this blocker (issue #1702) — e.g. a
   * GitHub Actions account-level billing limit. `requiresHuman` blockers
   * re-escalate on the staleness TTL rather than firing a single notification.
   */
  requiresHuman?: boolean;
  /**
   * The capability this blocker takes offline (issue #1702), e.g. `ci` or
   * `web-search`. Surfaced in the escalation's blocked-capability list so the
   * human sees *what* is unavailable, not just that something is blocked.
   * Defaults to `scope` when unset.
   */
  blockedCapability?: string;
  /**
   * ISO timestamp the *first* escalation fired. Unset until the notifier has
   * delivered successfully; persisted so a restart never re-fires the initial
   * escalation. Kept distinct from {@link lastEscalatedAt} for audit.
   */
  notifiedAt?: string;
  /**
   * ISO timestamp of the *most recent* escalation (issue #1702). Drives the
   * `requiresHuman` staleness TTL: a re-escalation fires when
   * `now - lastEscalatedAt ≥ staleTtlMs`. Persisted so the heartbeat survives
   * a restart.
   */
  lastEscalatedAt?: string;
  /** How many escalations have fired for this blocker (issue #1702). */
  escalationCount?: number;
  /**
   * Refs (PR/issue numbers or slugs) of the tolerance machinery already built
   * for this blocker (issue #1702). A non-empty regime marks the blocker as
   * "already tolerated"; the emission budget then refuses new tolerance
   * machinery for it. Append-only via {@link recordRegimeEntry}.
   */
  regime?: string[];
}

/** Input to {@link EnvironmentBlockerRegistry.register}. */
export interface RegisterBlockerInput {
  type: string;
  scope: string;
  detectedBy?: string;
  probe?: string;
  reason?: string;
  /** Tag this blocker as human-authority (re-escalates on the TTL). */
  requiresHuman?: boolean;
  /** Capability taken offline; defaults to `scope`. */
  blockedCapability?: string;
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
 * Quantified running cost of an active blocker (issue #1702). Carried on every
 * escalation so the human sees the *compounding price* of the stall — not just
 * "still blocked". The three fields are the acceptance-criterion metrics:
 * CI-blind merge count, retro-verify queue depth, and the blocked-capability
 * list.
 */
export interface EscalationCost {
  /** Merges landed without CI verification while blockers are active. */
  ciBlindMergeCount: number;
  /** Depth of the durable retro-verify queue (same population as the count). */
  retroVerifyQueueDepth: number;
  /** Capabilities currently offline across all active blockers (sorted, deduped). */
  blockedCapabilities: string[];
}

/**
 * Supplies the dynamic half of {@link EscalationCost} — the CI-blind merge
 * count and retro-verify queue depth — from wherever the daemon reads them
 * (the retro-verify spool / ci_blind_debt metric). Injected so the pure
 * registry never reaches into the queue directly. The registry fills in
 * `blockedCapabilities` from its own active-blocker list. May be async; a throw
 * is treated as zero cost (logged) so escalation delivery is never blocked on a
 * cost read.
 */
export type RunningCostProvider = () =>
  | { ciBlindMergeCount: number; retroVerifyQueueDepth: number }
  | Promise<{ ciBlindMergeCount: number; retroVerifyQueueDepth: number }>;

/**
 * A single (re-)escalation event delivered to the {@link EnvironmentBlockerNotifier}.
 */
export interface EnvironmentBlockerEscalation {
  blocker: EnvironmentBlocker;
  /** `initial` on the first escalation; `re-escalation` on a staleness re-fire. */
  kind: 'initial' | 're-escalation';
  /** 1-based count of escalations fired for this blocker (this one included). */
  escalationCount: number;
  /** Quantified running cost at the moment of escalation. */
  cost: EscalationCost;
  /** ISO timestamp this escalation fired. */
  at: string;
}

/**
 * Escalation sink. For ordinary blockers it is invoked *once* per active
 * blocker (deduped via the persisted `lastEscalatedAt`); for `requiresHuman`
 * blockers it is invoked again each time the staleness TTL elapses. May be
 * async; if it throws, escalation state is left unstamped so the next register
 * or heartbeat retries delivery.
 */
export type EnvironmentBlockerNotifier = (
  escalation: EnvironmentBlockerEscalation,
) => void | Promise<void>;

interface EnvironmentBlockerFile {
  schemaVersion: string;
  blockers: Record<string, EnvironmentBlocker>;
}

export interface EnvironmentBlockerRegistryOptions {
  now?: () => number;
  /** Escalation sink; see {@link EnvironmentBlockerNotifier}. */
  notify?: EnvironmentBlockerNotifier;
  /**
   * Staleness TTL (ms) after which a `requiresHuman` blocker re-escalates.
   * Default {@link DEFAULT_STALE_ESCALATION_TTL_MS} (24h).
   */
  staleTtlMs?: number;
  /**
   * Supplies the dynamic running-cost fields carried on each escalation. When
   * omitted, escalations carry zero for the CI-blind / retro-verify metrics
   * (the blocked-capability list is always computed from the registry itself).
   */
  costProvider?: RunningCostProvider;
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
  private readonly staleTtlMs: number;
  private readonly costProvider?: RunningCostProvider;
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
    this.staleTtlMs =
      options.staleTtlMs !== undefined && Number.isFinite(options.staleTtlMs) && options.staleTtlMs >= 0
        ? options.staleTtlMs
        : DEFAULT_STALE_ESCALATION_TTL_MS;
    this.costProvider = options.costProvider;
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
      // Register-once: do not overwrite detectedAt/detectedBy. maybeEscalate
      // both retries a not-yet-delivered initial escalation and re-fires a stale
      // `requiresHuman` blocker (its own guards decide which, if either).
      await this.maybeEscalate(existing);
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
      ...(input.requiresHuman !== undefined ? { requiresHuman: input.requiresHuman } : {}),
      ...(input.blockedCapability !== undefined ? { blockedCapability: input.blockedCapability } : {}),
    };
    this.blockers.set(key, blocker);
    await this.persistBestEffort('register', key);
    await this.maybeEscalate(blocker);
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
   * Sweep all active blockers and (re-)escalate any that are due (issue #1702):
   * a never-escalated blocker fires its initial escalation; a `requiresHuman`
   * blocker whose last escalation is older than {@link staleTtlMs} re-escalates.
   * Intended to be called on a timer by the daemon. Returns the escalations
   * fired this sweep (empty when nothing is due), so callers can log/observe.
   */
  async heartbeat(): Promise<EnvironmentBlockerEscalation[]> {
    const fired: EnvironmentBlockerEscalation[] = [];
    for (const blocker of this.list()) {
      const escalation = await this.maybeEscalate(blocker);
      if (escalation) fired.push(escalation);
    }
    return fired;
  }

  /**
   * Record a piece of tolerance machinery built for this blocker (issue #1702)
   * — e.g. the PR number of a merge-gate or retro-verify feature. Append-only
   * and deduped; a non-empty regime is what the emission budget consults to
   * refuse *new* tolerance machinery for the same blocker. Returns
   * `{ recorded:false }` when no matching blocker is active or the ref is
   * already present.
   */
  async recordRegimeEntry(
    type: string,
    scope: string,
    ref: string,
  ): Promise<{ recorded: boolean; regime: string[] }> {
    const blocker = this.blockers.get(environmentBlockerKey(type, scope));
    if (!blocker) return { recorded: false, regime: [] };
    const regime = blocker.regime ?? [];
    if (regime.includes(ref)) {
      blocker.regime = regime;
      return { recorded: false, regime: [...regime] };
    }
    regime.push(ref);
    blocker.regime = regime;
    await this.persistBestEffort('regime', blocker.key);
    return { recorded: true, regime: [...regime] };
  }

  /** The tolerance-machinery refs recorded for a blocker (empty when none / unknown). */
  getRegime(type: string, scope: string): string[] {
    return [...(this.blockers.get(environmentBlockerKey(type, scope))?.regime ?? [])];
  }

  /** True when a tolerance regime already exists for this blocker (issue #1702). */
  hasRegime(type: string, scope: string): boolean {
    return (this.blockers.get(environmentBlockerKey(type, scope))?.regime?.length ?? 0) > 0;
  }

  /**
   * Decide whether `blocker` is due for escalation right now, and what kind:
   *   - `initial` when it has never been escalated (covers a fresh blocker and a
   *     retry of a previously-failed initial delivery, since a failed delivery
   *     leaves `lastEscalatedAt` unset);
   *   - `re-escalation` when it is `requiresHuman` and the staleness TTL has
   *     elapsed since the last escalation;
   *   - `null` (no-op) otherwise — ordinary blockers are single-shot, and a
   *     `requiresHuman` blocker escalated within the TTL is not yet due.
   */
  private escalationDue(
    blocker: EnvironmentBlocker,
    nowMs: number,
  ): 'initial' | 're-escalation' | null {
    if (!blocker.lastEscalatedAt) return 'initial';
    if (!blocker.requiresHuman) return null;
    const lastMs = Date.parse(blocker.lastEscalatedAt);
    if (!Number.isFinite(lastMs)) return 're-escalation';
    return nowMs - lastMs >= this.staleTtlMs ? 're-escalation' : null;
  }

  /**
   * Build the {@link EscalationCost} for an escalation: the dynamic CI-blind /
   * retro-verify figures from the injected cost provider (zero when absent or
   * on error), plus the blocked-capability list computed from every active
   * blocker's capability label.
   */
  private async buildCost(): Promise<EscalationCost> {
    const toCount = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    let ciBlindMergeCount = 0;
    let retroVerifyQueueDepth = 0;
    if (this.costProvider) {
      try {
        const dynamic = await this.costProvider();
        // Coerce defensively: a provider returning NaN/undefined must not leak
        // a NaN into the escalation payload/message (Math.floor(NaN) is NaN).
        ciBlindMergeCount = toCount(dynamic.ciBlindMergeCount);
        retroVerifyQueueDepth = toCount(dynamic.retroVerifyQueueDepth);
      } catch (err) {
        console.error(
          '[environment-blocker-registry] cost provider failed; escalating with zero ' +
            'CI-blind / retro-verify cost:',
          err,
        );
      }
    }
    const blockedCapabilities = [
      ...new Set(this.list().map((b) => b.blockedCapability ?? b.scope)),
    ].sort();
    return { ciBlindMergeCount, retroVerifyQueueDepth, blockedCapabilities };
  }

  /**
   * Escalate `blocker` if it is due, delivering the cost-bearing payload to the
   * notifier and stamping `lastEscalatedAt` / `notifiedAt` / `escalationCount`
   * on success. A no-op (returns null) when no notifier is configured, the
   * blocker is not due, or a delivery for this key is already in flight. On
   * notifier failure the stamps are left as-is (logged loudly) so a later
   * register or heartbeat retries delivery. The in-flight guard is synchronous
   * (added/removed with no await between the check and the add) so at most one
   * delivery is ever in flight per key, even when N detectors register the same
   * blocker concurrently.
   */
  private async maybeEscalate(
    blocker: EnvironmentBlocker,
  ): Promise<EnvironmentBlockerEscalation | null> {
    if (!this.notify) return null;
    const nowMs = this.now();
    const kind = this.escalationDue(blocker, nowMs);
    if (!kind) return null;
    if (this.notifyInFlight.has(blocker.key)) return null;
    this.notifyInFlight.add(blocker.key);
    // A heartbeat sweep iterates a snapshot; the blocker may have been cleared
    // (probe success / operator clear) between snapshot and here. Don't deliver
    // a "still blocked" escalation for a blocker that is no longer active.
    if (!this.blockers.has(blocker.key)) {
      this.notifyInFlight.delete(blocker.key);
      return null;
    }
    const at = new Date(nowMs).toISOString();
    const escalationCount = (blocker.escalationCount ?? 0) + 1;
    let escalation: EnvironmentBlockerEscalation;
    try {
      const cost = await this.buildCost();
      escalation = { blocker, kind, escalationCount, cost, at };
      await this.notify(escalation);
    } catch (err) {
      console.error(
        `[environment-blocker-registry] notify(${JSON.stringify(blocker.key)}) failed; ` +
          'will retry on the next register attempt or heartbeat:',
        err,
      );
      return null;
    } finally {
      this.notifyInFlight.delete(blocker.key);
    }
    blocker.escalationCount = escalationCount;
    blocker.lastEscalatedAt = at;
    if (!blocker.notifiedAt) blocker.notifiedAt = at;
    await this.persistBestEffort('escalate', blocker.key);
    return escalation;
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
