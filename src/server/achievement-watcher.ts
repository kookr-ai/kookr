/**
 * AchievementWatcher — detects achievement unlocks from events.
 *
 * Receives events from three channels (adapter events, client messages, telemetry).
 * All methods are synchronous and must not throw into the caller — callers wrap
 * in try/catch as a structural error boundary.
 *
 * Persistence is inlined (atomic write pattern from task-persistence.ts).
 */

import { readFile, rename, access, open, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../core/types.js';
import type { TaskStore } from '../core/tasks.js';
import type { TelemetryEvent } from '../core/telemetry.js';
import { ACHIEVEMENT_CATALOG } from '../core/achievement-catalog.js';

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

// --- Persistence ---

interface AchievementFile {
  unlocked: Record<string, string>; // id → ISO timestamp
}

export async function loadAchievements(filePath: string): Promise<AchievementFile> {
  try {
    await access(filePath);
  } catch {
    return { unlocked: {} };
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.unlocked === 'object') {
      return { unlocked: parsed.unlocked ?? {} };
    }
    return { unlocked: {} };
  } catch (err) {
    console.warn('[achievements] Corrupt achievements file, starting fresh', err);
    return { unlocked: {} };
  }
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
  private unlockedMap: Record<string, string>; // id → ISO timestamp
  private enabled: boolean = true;
  private resetting: boolean = false;
  private pendingPersist: Promise<void> = Promise.resolve();
  private filePath: string;
  private onUnlock: OnUnlockFn;

  constructor(
    filePath: string,
    initialState: AchievementFile,
    onUnlock: OnUnlockFn,
  ) {
    this.filePath = filePath;
    this.unlockedMap = { ...initialState.unlocked };
    this.onUnlock = onUnlock;
  }

  /** Get the full unlocked map for snapshot inclusion. */
  getUnlocked(): Record<string, string> {
    return { ...this.unlockedMap };
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
      const p = this.persistUnlock(id, ts);
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

  /** Reset all achievement progress — clears in-memory map and deletes persistence file. */
  async reset(): Promise<void> {
    this.resetting = true;
    try {
      // Wait for any in-flight persist to complete before deleting
      await this.pendingPersist.catch(() => {});
      this.unlockedMap = {};
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

  private async persistUnlock(id: string, _ts: string): Promise<void> {
    if (this.resetting) return;
    try {
      // Write full in-memory state — avoids read-modify-write race when
      // multiple achievements unlock simultaneously
      await saveAchievements({ unlocked: { ...this.unlockedMap } }, this.filePath);
    } catch (err) {
      console.warn(`[achievements] Failed to persist unlock "${id}"`, err);
    }
  }
}
