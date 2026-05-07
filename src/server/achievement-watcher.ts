/**
 * AchievementWatcher — detects achievement unlocks from events.
 *
 * Receives events from three channels (adapter events, client messages, telemetry).
 * All methods are synchronous and must not throw into the caller — callers wrap
 * in try/catch as a structural error boundary.
 *
 * Persistence is inlined (atomic write pattern from task-persistence.ts).
 * On-disk shape is validated by zod; corrupt/incompatible files are quarantined
 * (renamed with a timestamp suffix) rather than silently overwritten — the user
 * can recover state by hand if the validation guard is wrong.
 */

import { readFile, rename, access, open, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, Anomaly } from '../core/types.js';
import type { TaskStore } from '../core/tasks.js';
import type { TelemetryEvent } from '../core/telemetry.js';

// --- Types ---

export interface AchievementUnlock {
  id: string;
  unlockedAt: string; // ISO timestamp
}

/**
 * Snapshot-derived signals: cheap booleans the watcher checks on every
 * snapshot broadcast. The caller (snapshot generator) computes the predicates
 * once and passes them in, so the watcher does not depend on store types.
 */
export interface SnapshotAchievementState {
  scheduleCount: number;
  projectCount: number;
  hasCodexTask: boolean;
  hasFeedbackTask: boolean;
  hasSnoozedFinding: boolean;
  hasKookrSubject: boolean;
  unsnoozedFindingCount: number;
}

export type AchievementEvent =
  | { type: 'agent'; event: AgentEvent; taskStore: TaskStore; serverCwd: string }
  | { type: 'client'; action: 'respond' | 'directReply' | 'launchTask' | 'snooze' | 'feedback'; hadAnomaly?: boolean }
  | { type: 'telemetry'; event: TelemetryEvent }
  | { type: 'snapshot'; state: SnapshotAchievementState };

type OnUnlockFn = (unlock: AchievementUnlock) => void;

// --- Persistence schema ---

const AchievementCountersSchema = z.object({
  // Resolution counters keyed by AnomalyType. Tier achievements reference these
  // via tier.counterKey in the catalog. Future tier achievements can use the
  // dormant fields without a migration.
  repeated_error_resolutions: z.number().int().nonnegative().default(0),
  permission_blocked_resolutions: z.number().int().nonnegative().default(0),
  merge_conflict_resolutions: z.number().int().nonnegative().default(0),
  api_error_resolutions: z.number().int().nonnegative().default(0),
  needs_input_resolutions: z.number().int().nonnegative().default(0),
  session_start_total: z.number().int().nonnegative().default(0),
  // key: `${agentId}:${type}`, value: ISO timestamps in last 1h (1h TTL prune on write, 200-key cap)
  stuck_together_runs: z.record(z.string(), z.array(z.string())).default({}),
});

const AchievementStreakSchema = z.object({
  lastActiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  currentStreak: z.number().int().nonnegative().default(0),
});

const AchievementFileSchema = z.object({
  unlocked: z.record(z.string(), z.string()).default({}),
  counters: AchievementCountersSchema.default({
    repeated_error_resolutions: 0,
    permission_blocked_resolutions: 0,
    merge_conflict_resolutions: 0,
    api_error_resolutions: 0,
    needs_input_resolutions: 0,
    session_start_total: 0,
    stuck_together_runs: {},
  }),
  streak: AchievementStreakSchema.default({ lastActiveDate: null, currentStreak: 0 }),
  backfillCompleted: z.boolean().default(false),
  schemaVersion: z.literal(2).default(2),
});

type AchievementCounters = z.infer<typeof AchievementCountersSchema>;
export type AchievementStreak = z.infer<typeof AchievementStreakSchema>;
type AchievementFile = z.infer<typeof AchievementFileSchema>;

/**
 * Broadcast-safe view of counters: numeric fields only. The internal
 * `stuck_together_runs` rolling window is server-state and is intentionally
 * absent from this shape so callers can't accidentally ship it over the wire.
 */
export type BroadcastCounters = Omit<AchievementCounters, 'stuck_together_runs'>;

/**
 * Looser shape accepted by the constructor — only `unlocked` is required.
 * Tests and v1 callers pass `{ unlocked: {} }`; the constructor fills in
 * defaults. Internal type — not exported.
 */
type AchievementFileInput = {
  unlocked: Record<string, string>;
  counters?: Partial<AchievementCounters>;
  streak?: Partial<AchievementStreak>;
  backfillCompleted?: boolean;
};

function defaultCounters(): AchievementCounters {
  return {
    repeated_error_resolutions: 0,
    permission_blocked_resolutions: 0,
    merge_conflict_resolutions: 0,
    api_error_resolutions: 0,
    needs_input_resolutions: 0,
    session_start_total: 0,
    stuck_together_runs: {},
  };
}

function defaultStreak(): AchievementStreak {
  return { lastActiveDate: null, currentStreak: 0 };
}

function defaultAchievementFile(): AchievementFile {
  return {
    unlocked: {},
    counters: defaultCounters(),
    streak: defaultStreak(),
    backfillCompleted: false,
    schemaVersion: 2,
  };
}

async function quarantineFile(filePath: string, reason: string): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinePath = `${filePath}.quarantined-${ts}.json`;
  try {
    await rename(filePath, quarantinePath);
    console.warn(
      `[achievements] Quarantined corrupt achievements file (${reason}): ${quarantinePath}`,
    );
    return quarantinePath;
  } catch (err) {
    console.warn(
      `[achievements] Could not quarantine corrupt file ${filePath} (${reason}); proceeding with fresh state`,
      err,
    );
    return null;
  }
}

export async function loadAchievements(filePath: string): Promise<AchievementFile> {
  try {
    await access(filePath);
  } catch {
    return defaultAchievementFile();
  }
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[achievements] Could not read ${filePath}, starting fresh`, err);
    return defaultAchievementFile();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineFile(filePath, 'invalid JSON');
    return defaultAchievementFile();
  }
  const result = AchievementFileSchema.safeParse(parsed);
  if (!result.success) {
    await quarantineFile(filePath, `schema validation failed: ${result.error.message}`);
    return defaultAchievementFile();
  }
  return result.data;
}

async function saveAchievements(data: AchievementFile, filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  const tempPath = join(dirname(filePath), `.achievements-${randomUUID()}.tmp`);
  const fh = await open(tempPath, 'w');
  try {
    await fh.writeFile(json, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tempPath, filePath);
}

// --- Watcher ---

export class AchievementWatcher {
  private unlockedMap: Record<string, string>;
  private counters: AchievementCounters;
  private streak: AchievementStreak;
  private backfillCompleted: boolean;
  private enabled: boolean = true;
  private resetting: boolean = false;
  private pendingPersist: Promise<void> = Promise.resolve();
  private filePath: string;
  private onUnlock: OnUnlockFn;

  constructor(
    filePath: string,
    initialState: AchievementFileInput,
    onUnlock: OnUnlockFn,
  ) {
    this.filePath = filePath;
    this.unlockedMap = { ...initialState.unlocked };
    this.counters = { ...defaultCounters(), ...(initialState.counters ?? {}) };
    this.streak = { ...defaultStreak(), ...(initialState.streak ?? {}) };
    this.backfillCompleted = initialState.backfillCompleted ?? false;
    this.onUnlock = onUnlock;
  }

  /** Get the full unlocked map for snapshot inclusion. */
  getUnlocked(): Record<string, string> {
    return { ...this.unlockedMap };
  }

  /**
   * Broadcast-safe counter snapshot. Excludes the server-only
   * `stuck_together_runs` rolling map so callers can't leak it over the wire.
   */
  getCounters(): BroadcastCounters {
    return {
      repeated_error_resolutions: this.counters.repeated_error_resolutions,
      permission_blocked_resolutions: this.counters.permission_blocked_resolutions,
      merge_conflict_resolutions: this.counters.merge_conflict_resolutions,
      api_error_resolutions: this.counters.api_error_resolutions,
      needs_input_resolutions: this.counters.needs_input_resolutions,
      session_start_total: this.counters.session_start_total,
    };
  }

  /** Get streak snapshot — used by snapshot broadcast (Phase 1c). */
  getStreak(): AchievementStreak {
    return { ...this.streak };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Check a single event for achievement triggers.
   * This is the main entry point — called from three sites with try/catch.
   */
  check(event: AchievementEvent): void {
    if (!this.enabled) return;

    const newUnlocks: string[] = [];

    switch (event.type) {
      case 'agent':
        this.checkAgentEvent(event.event, event.taskStore, event.serverCwd, newUnlocks);
        break;
      case 'client':
        this.checkClientMessage(event.action, event.hadAnomaly, newUnlocks);
        break;
      case 'telemetry':
        this.checkTelemetryEvent(event.event, newUnlocks);
        break;
      case 'snapshot':
        this.checkSnapshotState(event.state, newUnlocks);
        break;
    }

    // Fire unlocks
    for (const id of newUnlocks) {
      const ts = new Date().toISOString();
      this.unlockedMap[id] = ts;
      this.onUnlock({ id, unlockedAt: ts });

      // Persist asynchronously — fire-and-forget, errors logged
      const p = this.persistFullState();
      this.pendingPersist = p;
      void p;
    }
  }

  private tryUnlock(id: string, unlocks: string[]): void {
    if (!(id in this.unlockedMap)) {
      unlocks.push(id);
    }
  }

  private checkAgentEvent(
    event: AgentEvent,
    taskStore: TaskStore,
    serverCwd: string,
    unlocks: string[],
  ): void {
    // first-agent: any session_start event means an agent was discovered
    if (event.type === 'session_start') {
      this.tryUnlock('first-agent', unlocks);

      // the-loop: agent CWD starts with serverCwd
      if (event.cwd && serverCwd && event.cwd.startsWith(serverCwd)) {
        this.tryUnlock('the-loop', unlocks);
      }

      // forty-two: lifetime session count crossing the threshold.
      // ≥ 42 (not == 42) so a server crash near the boundary doesn't make the
      // easter egg unreachable on restart.
      this.counters.session_start_total += 1;
      if (this.counters.session_start_total >= 42) {
        this.tryUnlock('forty-two', unlocks);
      }
    }

    // five-agents / ten-agents: check concurrent running agent count
    const runningCount = taskStore.listTasks({ status: 'inProgress' }).length;
    if (runningCount >= 5) this.tryUnlock('five-agents', unlocks);
    if (runningCount >= 10) this.tryUnlock('ten-agents', unlocks);
  }

  private checkClientMessage(
    action: 'respond' | 'directReply' | 'launchTask' | 'snooze' | 'feedback',
    hadAnomaly: boolean | undefined,
    unlocks: string[],
  ): void {
    // first-response: user sent a message
    if (action === 'respond' || action === 'directReply') {
      this.tryUnlock('first-response', unlocks);
    }

    // first-direct-reply: user used direct reply specifically
    if (action === 'directReply') {
      this.tryUnlock('first-direct-reply', unlocks);
    }

    // first-anomaly-resolved: user responded to an agent that had an anomaly
    if (action === 'respond' && hadAnomaly) {
      this.tryUnlock('first-anomaly-resolved', unlocks);
    }

    // task-launched: user launched a task from the UI
    if (action === 'launchTask') {
      this.tryUnlock('task-launched', unlocks);
    }

    // first-snooze: user snoozed any finding
    if (action === 'snooze') {
      this.tryUnlock('first-snooze', unlocks);
    }

    // first-feedback: user submitted thumbs-up/down on a task
    if (action === 'feedback') {
      this.tryUnlock('first-feedback', unlocks);
    }
  }

  private checkTelemetryEvent(event: TelemetryEvent, unlocks: string[]): void {
    // first-shortcut: user used a keyboard shortcut
    if (event.type === 'shortcut_used') {
      this.tryUnlock('first-shortcut', unlocks);
    }

    // smart-response-used: user accepted an AI suggestion (not quick-action)
    if (event.type === 'suggestion_accepted') {
      this.tryUnlock('smart-response-used', unlocks);
    }
  }

  /**
   * Check snapshot-derived predicates. Called once per snapshot broadcast with
   * cheaply-computed booleans. tryUnlock prevents double-firing, so calling
   * this on every snapshot is safe — re-checking a true predicate is a no-op
   * after the first unlock.
   *
   * This double-duties as the "retroactive back-fill" path: existing users see
   * boolean discovery achievements unlock on their first post-upgrade snapshot
   * if their state already meets the predicate.
   */
  private checkSnapshotState(state: SnapshotAchievementState, unlocks: string[]): void {
    if (state.scheduleCount > 0) this.tryUnlock('first-cron', unlocks);
    if (state.projectCount >= 2) this.tryUnlock('first-multi-project', unlocks);
    if (state.hasCodexTask) this.tryUnlock('first-codex', unlocks);
    if (state.hasFeedbackTask) this.tryUnlock('first-feedback', unlocks);
    if (state.hasSnoozedFinding) this.tryUnlock('first-snooze', unlocks);
    if (state.hasKookrSubject) this.tryUnlock('self-aware', unlocks);
    if (state.unsnoozedFindingCount >= 10) this.tryUnlock('tab-hoarder', unlocks);
  }

  /**
   * Record a user-resolved anomaly. Called from the WebSocket handler's
   * respond/directReply path. Honors enabled flag and a 3-char body gate so
   * empty/"ok" responses cannot inflate tier counters.
   *
   * Walks the watcher state forward: increments the type-keyed counter,
   * updates the streak, prunes + appends to the stuck-together rolling
   * window, and runs tier/streak/window/afk checks. Persists the full state
   * once at the end (single fire-and-forget write).
   */
  recordResolution(params: {
    agentId: string;
    body: string;
    /**
     * The anomaly that was active for this agent at the moment the user's
     * message was about to be processed. The caller MUST capture this BEFORE
     * routing the message, since routing may clear the queue entry. Pass
     * AttentionQueue.getActiveAnomaly(agentId) at that capture point. Pass
     * null when no anomaly was active — the resolution is then a no-op.
     */
    activeAnomaly: Anomaly | null;
    nowMs?: number;  // override for tests
  }): void {
    if (!this.enabled) return;
    if (params.body.replace(/\s+/g, '').length < 3) return;
    if (!params.activeAnomaly) return;
    const active = params.activeAnomaly;

    const newUnlocks: string[] = [];
    const nowMs = params.nowMs ?? Date.now();
    const nowISO = new Date(nowMs).toISOString();

    // 1. Increment the type-keyed resolution counter (best-effort).
    const counterKey = `${active.type}_resolutions` as keyof AchievementCounters;
    if (counterKey in this.counters && typeof this.counters[counterKey] === 'number') {
      (this.counters[counterKey] as number) += 1;
    }

    // 2. Tier checks.
    if (active.type === 'repeated_error') {
      if (this.counters.repeated_error_resolutions >= 10) {
        this.tryUnlock('loop-buster-i', newUnlocks);
      }
      if (this.counters.repeated_error_resolutions >= 50) {
        this.tryUnlock('loop-buster-ii', newUnlocks);
      }
    }
    if (active.type === 'permission_blocked') {
      if (this.counters.permission_blocked_resolutions >= 25) {
        this.tryUnlock('permission-whisperer', newUnlocks);
      }
    }

    // 3. Streak.
    this.updateStreak(nowMs);
    if (this.streak.currentStreak >= 7) {
      this.tryUnlock('iron-streak', newUnlocks);
    }

    // 4. Stuck-together rolling window: same (agentId, type) tuple resolved
    //    3 times within 1 hour.
    const tupleKey = `${params.agentId}:${active.type}`;
    const oneHourAgo = nowMs - 60 * 60 * 1000;
    const existing = (this.counters.stuck_together_runs[tupleKey] ?? [])
      .filter((iso) => Date.parse(iso) >= oneHourAgo);
    existing.push(nowISO);
    this.counters.stuck_together_runs[tupleKey] = existing;
    this.pruneStuckTogetherRuns(oneHourAgo);
    if (existing.length >= 3) {
      this.tryUnlock('stuck-together', newUnlocks);
    }

    // 5. AFK: resolution arrived more than 30 minutes after the anomaly fired.
    const detectedMs = active.detectedAt instanceof Date
      ? active.detectedAt.getTime()
      : Date.parse(String(active.detectedAt));
    if (Number.isFinite(detectedMs) && nowMs - detectedMs > 30 * 60 * 1000) {
      this.tryUnlock('afk', newUnlocks);
    }

    // Fire unlocks + persist full state once.
    for (const id of newUnlocks) {
      this.unlockedMap[id] = nowISO;
      this.onUnlock({ id, unlockedAt: nowISO });
    }
    const p = this.persistFullState();
    this.pendingPersist = p;
    void p;
  }

  /**
   * Update the streak based on local-date comparison between today and
   * lastActiveDate. +1 if today is exactly one day after lastActiveDate;
   * 1 if more than one day apart; no-op if same day.
   */
  private updateStreak(nowMs: number): void {
    const todayISO = new Date(nowMs).toISOString().slice(0, 10);
    if (this.streak.lastActiveDate === todayISO) return;
    if (this.streak.lastActiveDate === null) {
      this.streak.lastActiveDate = todayISO;
      this.streak.currentStreak = 1;
      return;
    }
    const lastMs = Date.parse(`${this.streak.lastActiveDate}T00:00:00Z`);
    const todayMs = Date.parse(`${todayISO}T00:00:00Z`);
    const dayDelta = Math.round((todayMs - lastMs) / (24 * 60 * 60 * 1000));
    this.streak.lastActiveDate = todayISO;
    this.streak.currentStreak = dayDelta === 1 ? this.streak.currentStreak + 1 : 1;
  }

  /**
   * Prune the stuck-together rolling map: drop entries older than the cutoff,
   * remove now-empty keys, and hard-cap the map at 200 keys (oldest evicted).
   */
  private pruneStuckTogetherRuns(cutoffMs: number): void {
    const map = this.counters.stuck_together_runs;
    for (const [k, arr] of Object.entries(map)) {
      const filtered = arr.filter((iso) => Date.parse(iso) >= cutoffMs);
      if (filtered.length === 0) {
        delete map[k];
      } else {
        map[k] = filtered;
      }
    }
    const keys = Object.keys(map);
    if (keys.length > 200) {
      // Sort by most-recent-timestamp ascending; evict the oldest until under cap.
      const byOldest = keys.sort((a, b) => {
        const aLast = Date.parse(map[a][map[a].length - 1] ?? '');
        const bLast = Date.parse(map[b][map[b].length - 1] ?? '');
        return aLast - bLast;
      });
      for (let i = 0; i < keys.length - 200; i += 1) {
        delete map[byOldest[i]];
      }
    }
  }

  /** Reset all achievement progress — clears in-memory state and deletes persistence file. */
  async reset(): Promise<void> {
    this.resetting = true;
    try {
      // Wait for any in-flight persist to complete before deleting
      await this.pendingPersist.catch(() => {});
      this.unlockedMap = {};
      this.counters = defaultCounters();
      this.streak = defaultStreak();
      this.backfillCompleted = false;
      try {
        await unlink(this.filePath);
        console.log(`[achievements] Reset: deleted ${this.filePath}`);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[achievements] Reset: failed to delete ${this.filePath}`, err);
          throw err;
        }
      }
    } finally {
      this.resetting = false;
    }
  }

  private async persistFullState(): Promise<void> {
    if (this.resetting) return;
    try {
      // Write full in-memory state — avoids read-modify-write race when
      // multiple achievements unlock simultaneously
      await saveAchievements(
        {
          unlocked: { ...this.unlockedMap },
          counters: { ...this.counters, stuck_together_runs: { ...this.counters.stuck_together_runs } },
          streak: { ...this.streak },
          backfillCompleted: this.backfillCompleted,
          schemaVersion: 2,
        },
        this.filePath,
      );
    } catch (err) {
      console.warn(`[achievements] Failed to persist achievement state`, err);
    }
  }
}

