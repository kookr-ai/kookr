import { copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskCompletionFeedback } from '../../core/tasks.js';
import type { InteractionEvent } from '../../core/interaction-log.js';
import { buildInteractionSlice, type FeedbackBundle } from '../../core/feedback-bundle.js';

export interface WriteFeedbackBundleDeps {
  /** Where bundle dirs live. Typically `<kookrDir>/feedback`. */
  feedbackDir: string;
  /** Where hook JSONL files live. Typically `<kookrDir>/hooks`. */
  hooksDir: string;
  /** Reads the current full interaction log (snapshot at submission time). */
  readInteractionLog: () => Promise<InteractionEvent[]>;
}

export interface WriteFeedbackBundleResult {
  /** Absolute path to the new bundle dir, e.g. `<feedbackDir>/<taskId>/<bundleId>/`. */
  bundlePath: string;
  bundleId: string;
}

/**
 * Snapshot a feedback bundle at thumb-submission time. Bundle dirs are immutable
 * per-launch — amendments write a new <bundleId> subdir; the prior dir is left
 * untouched so any in-flight reflect task keeps reading the bundle it was
 * launched against.
 *
 * Hook JSONL files are best-effort copies — a missing hook file (e.g. swept by
 * an unrelated cleanup) is logged and skipped, not fatal. The bundle still
 * carries the interaction-log slice and the completion digest.
 */
export async function writeFeedbackBundle(
  task: Task,
  feedback: TaskCompletionFeedback,
  deps: WriteFeedbackBundleDeps,
): Promise<WriteFeedbackBundleResult> {
  const bundleId = nowBundleId();
  const bundlePath = join(deps.feedbackDir, task.id, bundleId);
  await mkdir(bundlePath, { recursive: true });

  // Copy hook JSONLs (one per source-task session). Best-effort — missing files don't abort.
  const hookFiles: string[] = [];
  for (const session of task.sessions) {
    const src = join(deps.hooksDir, `${session.tmuxSession}.jsonl`);
    try {
      await access(src);
      const dst = `hook-${session.tmuxSession}.jsonl`;
      await copyFile(src, join(bundlePath, dst));
      hookFiles.push(dst);
    } catch {
      // Hook file not present — skip
    }
  }

  // Reconstruct interaction-log slice for this task (across all its sessions)
  const events = await deps.readInteractionLog();
  const slice = buildInteractionSlice(task, events);
  await writeFile(
    join(bundlePath, 'interaction-slice.jsonl'),
    slice.map((e) => JSON.stringify(e)).join('\n') + (slice.length ? '\n' : ''),
    'utf-8',
  );

  const bundle: FeedbackBundle = {
    taskId: task.id,
    rating: feedback.rating,
    agentType: task.agentType,
    taskPrompt: task.prompt,
    hookFiles,
  };
  if (feedback.note !== undefined) bundle.note = feedback.note;
  if (feedback.downReason !== undefined) bundle.downReason = feedback.downReason;
  if (task.completionDigest) bundle.completionDigest = { bullets: task.completionDigest.bullets };

  await writeFile(join(bundlePath, 'bundle.json'), JSON.stringify(bundle, null, 2), 'utf-8');

  return { bundlePath, bundleId };
}

function nowBundleId(): string {
  // ISO timestamp with colons replaced — filesystem-safe and lexically sortable
  return new Date().toISOString().replace(/[:.]/g, '-');
}
