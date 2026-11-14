import type { Task, TaskStore } from '../../core/tasks.js';
import {
  checkSkillsForPlugins,
  readTranscriptSkillListing,
} from '../plugin-manager/skill-listing-check.js';

export interface SkillListingCheckProcessorDeps {
  taskStore: Pick<TaskStore, 'getTask' | 'setLoadout'>;
  readSkillListing?: (transcriptPath: string) => Promise<string[] | null>;
  now?: () => Date;
}

export interface SkillListingCheckProcessor {
  /** Called on a Stop event; runs the check once per task, in the background. */
  process(stopTask: Pick<Task, 'id'> | undefined, tmuxName: string): Promise<void>;
}

/**
 * After a task's first turn (its first Stop event), compare the plugins its
 * loadout record lists with the transcript's skill listing and store the
 * per-plugin result on the record (RFC "Plugins for the Kookr fleet", section
 * 2). Runs once per task: a record that already has `skillCheck` is left
 * alone. Failure is silent and leaves no result, so a later Stop retries.
 */
export function createSkillListingCheckProcessor(
  deps: SkillListingCheckProcessorDeps,
): SkillListingCheckProcessor {
  const read = deps.readSkillListing ?? readTranscriptSkillListing;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Set<string>();
  return {
    async process(stopTask, tmuxName) {
      // Fire-and-forget from the event pipeline: this must never reject.
      if (!stopTask || inFlight.has(stopTask.id)) return;
      inFlight.add(stopTask.id);
      try {
        const task = deps.taskStore.getTask(stopTask.id);
        const record = task?.loadout;
        if (!task || !record?.plugins?.length || record.skillCheck) return;
        const transcriptPath = task.sessions.find((s) => s.tmuxSession === tmuxName)?.transcriptPath;
        if (!transcriptPath) return;
        const names = await read(transcriptPath);
        if (!names) return;
        const results = checkSkillsForPlugins(record.plugins.map((p) => p.id), names);
        const current = deps.taskStore.getTask(task.id)?.loadout;
        if (!current || current.skillCheck) return;
        deps.taskStore.setLoadout(task.id, { ...current, skillCheck: { checkedAt: now().toISOString(), results } });
        const unseen = Object.entries(results).filter(([, r]) => r === 'no_skills_seen').map(([id]) => id);
        if (unseen.length > 0) {
          console.log(`[loadout] task ${task.id}: no skills seen for ${unseen.join(', ')} (expected for a plugin without skills)`);
        }
      } catch (err) {
        console.warn(`[loadout] skill listing check failed for task ${stopTask.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        inFlight.delete(stopTask.id);
      }
    },
  };
}
