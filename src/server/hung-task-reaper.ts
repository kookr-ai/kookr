import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { MergedPrAttribution } from '../core/delivered-task-completion.js';
import type { TaskReapOutcome } from '../shared/contracts/task.js';
import { appendAuditRow } from '../core/audit-log.js';
import { buildReapDisposition } from '../core/hung-task-reaper.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';

const PANE_TAIL_LINES = 50;

/** Evidence collected at the moment a task is confirmed reap-eligible (issue #1526 Phase A / FM6). */
export interface HungTaskReapEvidence {
  silentForMs: number;
  thresholdMs: number;
  lastHookEventAt: number;
  lastPaneChangeAt: number;
  lastTokenActivityAt: number;
  /** Raw pane content captured at reap time; the report keeps only the last ~50 lines. */
  paneContent: string;
}

export interface HungTaskReaperDeps {
  taskStore: TaskStore;
  lifecycleDeps: LifecycleDeps;
  /** Kookr data-dir "reports" directory. When absent, no report artifact is written (audit + termination still happen). */
  reportsDir?: string;
  /** Path to the shared audit.jsonl log. */
  auditLogPath?: string;
  /** Optional broadcast for the reap alert — reuses the existing 'alert' channel, no new notification surface. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Delivery attribution (issue #1559): a task's attributable merged PR, or
   * null. Wired to the same `GitHubStateStore`-backed resolver the
   * delivered-completion sweep uses (#1560) — no new attribution mechanism, no
   * pane scraping, no live GitHub call. Absent → the reap records a plain
   * `terminated` outcome (never a false `delivered_then_hung`).
   */
  resolveMergedPr?: (task: Task) => MergedPrAttribution | null;
  now?: () => Date;
}

export interface HungTaskReapResult {
  reportPath?: string;
  /** Recorded reap outcome (issue #1559): `terminated` or `delivered_then_hung`. */
  outcome: TaskReapOutcome;
}

function formatAgeFromNow(now: Date, at: number): string {
  if (at === 0) return 'never';
  const ms = now.getTime() - at;
  const minutes = Math.round(ms / 60_000);
  return `${new Date(at).toISOString()} (${minutes}m ago)`;
}

function buildHungTaskReportMarkdown(task: Task, evidence: HungTaskReapEvidence, now: Date): string {
  const tail = evidence.paneContent.split('\n').slice(-PANE_TAIL_LINES).join('\n');
  return `# Hung-task reap report

- **Task ID:** ${task.id}
- **Task name:** ${task.name ?? '(unnamed)'}
- **Prompt:** ${task.prompt}
- **cwd:** ${task.cwd}
- **Reaped at:** ${now.toISOString()}
- **Silent for:** ${Math.round(evidence.silentForMs / 60_000)}m (threshold: ${Math.round(evidence.thresholdMs / 60_000)}m)

## Liveness timeline (last activity per channel)

- Hook events: ${formatAgeFromNow(now, evidence.lastHookEventAt)}
- Pane-content change: ${formatAgeFromNow(now, evidence.lastPaneChangeAt)}
- Token-count movement: ${formatAgeFromNow(now, evidence.lastTokenActivityAt)}

## Pane tail (last ${PANE_TAIL_LINES} lines)

\`\`\`
${tail}
\`\`\`
`;
}

/** Write the reap evidence report. Never throws — a report-write failure must not block the reap. */
async function writeHungTaskReport(
  task: Task,
  evidence: HungTaskReapEvidence,
  reportsDir: string,
  now: Date,
): Promise<string | undefined> {
  const slug = now.toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, `hung-task-${task.id}-${slug}.md`);
  try {
    await mkdir(reportsDir, { recursive: true });
    await writeFile(reportPath, buildHungTaskReportMarkdown(task, evidence, now), 'utf-8');
    return reportPath;
  } catch (err) {
    console.warn(`[hung-task-reaper] failed to write report for task ${task.id}:`, err);
    return undefined;
  }
}

/**
 * Reap a single hung task (issue #1526 Phase A / FM6): write an evidence
 * report, terminate the task (kills the session via the terminal backend's
 * existing kill path, transitions to the existing `terminated` status, purges
 * attention-queue entries, releases leases/claims — all via the same
 * `terminateTask` reconcile() already uses for dead sessions), write an audit
 * row, and broadcast an alert. The caller is responsible for confirming
 * eligibility (see `evaluateHungTaskReap` in core/hung-task-reaper.ts) before
 * calling this, and for triggering pending-task promotion afterward.
 */
export async function reapHungTask(
  task: Task,
  evidence: HungTaskReapEvidence,
  deps: HungTaskReaperDeps,
): Promise<HungTaskReapResult> {
  const now = deps.now?.() ?? new Date();
  const reportPath = deps.reportsDir
    ? await writeHungTaskReport(task, evidence, deps.reportsDir, now)
    : undefined;

  // Attribute delivery BEFORE terminating, so a task that already merged its PR
  // is recorded as `delivered_then_hung` instead of masking the delivery as a
  // plain `terminated` (issue #1559). Reuses the delivered-completion sweep's
  // attribution (#1560) — cached GitHub state, no pane scrape, no live call.
  const merged = deps.resolveMergedPr?.(task) ?? null;
  const disposition = buildReapDisposition(merged, now.toISOString());
  const outcome = disposition.outcome ?? 'terminated';

  await terminateTask(task.id, deps.lifecycleDeps, {
    reason: 'timeout',
    detail: `hung-task-reaper: silent for ${Math.round(evidence.silentForMs / 1000)}s (threshold ${Math.round(evidence.thresholdMs / 1000)}s)`,
  });

  // Record the disposition on the (still-present) terminated task record. The
  // store keeps reaped tasks, and setDisposition is first-write-wins, so this
  // is the single durable outcome marker for the reap (issue #1559).
  deps.taskStore.setDisposition(task.id, disposition);

  await appendAuditRow(deps.auditLogPath, {
    type: 'task.hungTaskReap',
    timestamp: nowISO(),
    actor: 'system:hung-task-reaper',
    taskId: task.id,
    silentForMs: evidence.silentForMs,
    thresholdMs: evidence.thresholdMs,
    outcome,
    ...(disposition.deliveredPr ? { deliveredPr: disposition.deliveredPr } : {}),
    evidence: {
      lastHookEventAt: evidence.lastHookEventAt,
      lastPaneChangeAt: evidence.lastPaneChangeAt,
      lastTokenActivityAt: evidence.lastTokenActivityAt,
    },
    ...(reportPath ? { reportPath } : {}),
  });

  const silentMinutes = Math.round(evidence.silentForMs / 60_000);
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: disposition.deliveredPr
      ? `Reaped delivered-then-hung task (PR #${disposition.deliveredPr.number}): ${task.name ?? task.id}`
      : `Reaped hung task: ${task.name ?? task.id}`,
    details: disposition.deliveredPr
      ? `Delivered PR #${disposition.deliveredPr.number}, then no hook events, pane change, or token activity for ${silentMinutes}m — session terminated.`
      : `No hook events, pane change, or token activity for ${silentMinutes}m — session terminated.`,
    severity: 'warning',
  });

  return { reportPath, outcome };
}
