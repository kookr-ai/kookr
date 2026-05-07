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
import type { AgentEvent } from '../core/types.js';
import type { TaskStore } from '../core/tasks.js';
import type { TelemetryEvent } from '../core/telemetry.js';

// --- Types ---

export interface AchievementUnlock {
  id: string;
  unlockedAt: string; // ISO timestamp
}

export type AchievementEvent =
  | { type: 'agent'; event: AgentEvent; taskStore: TaskStore; serverCwd: string }
  | { type: 'client'; action: 'respond' | 'directReply' | 'launchTask'; hadAnomaly?: boolean }
  | { type: 'telemetry'; event: TelemetryEvent };

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

export type AchievementCounters = z.infer<typeof AchievementCountersSchema>;
export type AchievementStreak = z.infer<typeof AchievementStreakSchema>;
export type AchievementFile = z.infer<typeof AchievementFileSchema>;

/**
 * Looser shape accepted by the constructor — only `unlocked` is required.
 * Tests and v1 callers pass `{ unlocked: {} }`; the constructor fills in defaults.
 */
export type AchievementFileInput = {
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

  /** Get counter snapshot — used by snapshot broadcast (Phase 1c). */
  getCounters(): AchievementCounters {
    return {
      ...this.counters,
      stuck_together_runs: { ...this.counters.stuck_together_runs },
    };
  }

  /** Get streak snapshot — used by snapshot broadcast (Phase 1c). */
  getStreak(): AchievementStreak {
    return { ...this.streak };
  }

  /** Whether the one-time retroactive back-fill has run on this file. */
  isBackfillCompleted(): boolean {
    return this.backfillCompleted;
  }

  /**
   * Mark back-fill as completed and persist. Called by the post-init back-fill
   * runner once it has evaluated all boolean preconditions exactly once.
   */
  async markBackfillComplete(): Promise<void> {
    if (this.backfillCompleted) return;
    this.backfillCompleted = true;
    await this.persistFullState();
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

  /**
   * Public unlock entry for paths that compute their own conditions
   * (e.g., the post-init back-fill runner). Idempotent — already-unlocked
   * IDs are no-ops. Honors the enabled flag.
   */
  tryUnlockPublic(id: string): boolean {
    if (!this.enabled) return false;
    if (id in this.unlockedMap) return false;
    const ts = new Date().toISOString();
    this.unlockedMap[id] = ts;
    this.onUnlock({ id, unlockedAt: ts });
    const p = this.persistFullState();
    this.pendingPersist = p;
    void p;
    return true;
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
    }

    // five-agents / ten-agents: check concurrent running agent count
    const runningCount = taskStore.listTasks({ status: 'inProgress' }).length;
    if (runningCount >= 5) this.tryUnlock('five-agents', unlocks);
    if (runningCount >= 10) this.tryUnlock('ten-agents', unlocks);
  }

  private checkClientMessage(
    action: 'respond' | 'directReply' | 'launchTask',
    hadAnomaly: boolean | undefined,
    unlocks: string[],
  ): void {
    // first-response: user sent a message
    if (action === 'respond' || action === 'directReply') {
      this.tryUnlock('first-response', unlocks);
    }

    // first-anomaly-resolved: user responded to an agent that had an anomaly
    if (action === 'respond' && hadAnomaly) {
      this.tryUnlock('first-anomaly-resolved', unlocks);
    }

    // task-launched: user launched a task from the UI
    if (action === 'launchTask') {
      this.tryUnlock('task-launched', unlocks);
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
