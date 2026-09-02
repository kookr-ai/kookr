/**
 * First-hook miss reaper (issue #2036).
 *
 * After a successful adapter launch, a session that never emits SessionStart
 * (or any agent hook) still occupies capacity until the multi-hour hung-task
 * reaper. This sweep terminates those sessions after a short post-registration
 * ack deadline, writes an evidence report + disposition, and increments the
 * process-lifetime `firstHookMissTotal` health counter.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { TaskDisposition } from '../shared/contracts/task.js';
import {
  DEFAULT_FIRST_HOOK_DEADLINE_MS,
  evaluateFirstHookMiss,
  type FirstHookMissEvidence,
} from '../core/first-hook-deadline.js';
import { appendAuditRow } from '../core/audit-log.js';
import { appendDispositionEntry, type DispositionEntry } from '../core/disposition-ledger.js';
import { nowISO } from '../core/interaction-log.js';
import { terminateTask, type LifecycleDeps } from './agent-lifecycle.js';
import { firstHookMissReportBasename } from './first-hook-miss-report-paths.js';
import {
  persistReapReport,
  type ReapReportPersistOutcome,
} from './reap-report-persistence.js';

/** In-memory snapshot for `/api/health` + `/metrics` (issue #2036). */
export interface FirstHookMissMetricsSnapshot {
  /** Cumulative first-hook-miss reclaims since process start. */
  firstHookMissTotal: number;
}

/**
 * Process-lifetime counter for first-hook misses (issue #2036). One instance
 * at bootstrap, threaded into the reaper, `/api/health`, and `/metrics`.
 */
export class FirstHookMissMetrics {
  private firstHookMissTotal = 0;

  recordMiss(count = 1): void {
    if (count > 0) this.firstHookMissTotal += count;
  }

  getSnapshot(): FirstHookMissMetricsSnapshot {
    return { firstHookMissTotal: this.firstHookMissTotal };
  }
}

export interface ReapFirstHookMissDeps {
  taskStore: TaskStore;
  lifecycleDeps: LifecycleDeps;
  /** Kookr data-dir "reports" directory. Absent ⇒ no report file (audit + terminate still run). */
  reportsDir?: string;
  auditLogPath?: string;
  dispositionLedgerPath?: string;
  broadcastToAll?: (msg: ServerMessage) => void;
  metrics?: Pick<FirstHookMissMetrics, 'recordMiss'>;
  /**
   * Wall-clock bound for the best-effort evidence-report write (issue #2852).
   * The write runs AFTER termination has released capacity, so this only caps
   * how long the audit row / alert / pending-task refill wait on it. Defaults
   * to the helper's `DEFAULT_REAP_REPORT_PERSIST_TIMEOUT_MS` (5s); `<= 0` awaits
   * unbounded. Presently an injectable-for-tests knob — no production caller
   * sets it, so operationally the default always applies.
   */
  reportPersistTimeoutMs?: number;
  now?: () => Date;
}

export interface FirstHookMissEvidenceBundle {
  waitedMs: number;
  deadlineMs: number;
  registeredAt: number;
  firstHookAt: number;
  mcpStartupAt: number;
  paneContent: string;
}

export function buildFirstHookMissDisposition(at: string): TaskDisposition {
  return {
    reason: 'first_hook_miss',
    at,
    source: 'first-hook-miss',
    outcome: 'terminated',
    detail:
      'No SessionStart / agent hook within the post-spawn first-hook deadline — session terminated to free capacity.',
  };
}

function buildReportMarkdown(task: Task, evidence: FirstHookMissEvidenceBundle, now: Date): string {
  const tail = evidence.paneContent.split('\n').slice(-50).join('\n');
  return `# First-hook miss report

- **Task ID:** ${task.id}
- **Task name:** ${task.name ?? '(unnamed)'}
- **Prompt:** ${task.prompt}
- **cwd:** ${task.cwd}
- **Reaped at:** ${now.toISOString()}
- **Waited:** ${Math.round(evidence.waitedMs / 1000)}s (deadline: ${Math.round(evidence.deadlineMs / 1000)}s)
- **Registered at:** ${new Date(evidence.registeredAt).toISOString()}
- **firstHookAt:** ${evidence.firstHookAt === 0 ? 'never' : new Date(evidence.firstHookAt).toISOString()}
- **mcpStartupAt:** ${evidence.mcpStartupAt === 0 ? 'never' : new Date(evidence.mcpStartupAt).toISOString()}

## Pane tail (last 50 lines)

\`\`\`
${tail}
\`\`\`
`;
}

/**
 * Write the first-hook-miss report and resolve its path. Errors propagate: the
 * caller runs this through {@link persistReapReport}, which bounds and catches
 * it so a wedged data directory can never delay or crash the reap (issue #2852).
 */
async function writeReport(
  task: Task,
  evidence: FirstHookMissEvidenceBundle,
  reportsDir: string,
  now: Date,
): Promise<string> {
  const slug = now.toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, firstHookMissReportBasename(task.id, slug));
  await mkdir(reportsDir, { recursive: true });
  await writeFile(reportPath, buildReportMarkdown(task, evidence, now), 'utf-8');
  return reportPath;
}

/**
 * Terminate one task for a first-hook miss (issue #2036). Caller must confirm
 * eligibility via {@link evaluateFirstHookMiss} first.
 */
export async function reapFirstHookMiss(
  task: Task,
  evidence: FirstHookMissEvidenceBundle,
  deps: ReapFirstHookMissDeps,
): Promise<{ reportPath?: string; reportPersistence: ReapReportPersistOutcome['status'] }> {
  const now = deps.now?.() ?? new Date();

  const disposition = buildFirstHookMissDisposition(now.toISOString());

  // Terminate and release capacity BEFORE any evidence-report I/O (issue
  // #2852). The report is a diagnostic artifact, not lifecycle state; writing
  // it first meant a full/slow/wedged data directory could stall capacity
  // release indefinitely. The report is persisted best-effort further down,
  // bounded so a never-settling write cannot delay the reap.
  await terminateTask(task.id, deps.lifecycleDeps, {
    reason: 'timeout',
    detail:
      `first-hook-miss: no agent hook for ${Math.round(evidence.waitedMs / 1000)}s ` +
      `(deadline ${Math.round(evidence.deadlineMs / 1000)}s)`,
  });

  deps.taskStore.setDisposition(task.id, disposition);
  deps.metrics?.recordMiss(1);

  if (deps.dispositionLedgerPath) {
    const entry: DispositionEntry = {
      schemaVersion: 'disposition-ledger.v1',
      taskId: task.id,
      disposition: 'needs-human',
      detail:
        `needs-human: first-hook miss after ${Math.round(evidence.waitedMs / 1000)}s ` +
        'with no SessionStart / agent hook — decide retry vs abandon',
      incidentId: `first-hook-miss-${now.toISOString().slice(0, 10)}`,
      source: 'first-hook-miss',
      at: now.toISOString(),
    };
    await appendDispositionEntry(deps.dispositionLedgerPath, entry).catch((err) => {
      console.error(
        `[first-hook-miss] failed to record disposition-ledger entry for task ${task.id}:`,
        err,
      );
    });
  }

  // Persist the evidence report best-effort, now that capacity is already
  // released (issue #2852). Bounded so a wedged data directory cannot delay the
  // audit row / alert / pending-task refill, and every failure — including a
  // late rejection after the bound — is caught inside `persistReapReport`.
  const report: ReapReportPersistOutcome = deps.reportsDir
    ? await persistReapReport(
        () => writeReport(task, evidence, deps.reportsDir!, now),
        deps.reportPersistTimeoutMs,
        `[first-hook-miss] task ${task.id}:`,
      )
    : { status: 'skipped' };
  const reportPath = report.status === 'ok' ? report.reportPath : undefined;

  await appendAuditRow(deps.auditLogPath, {
    type: 'task.firstHookMiss',
    timestamp: nowISO(),
    actor: 'system:first-hook-miss',
    taskId: task.id,
    waitedMs: evidence.waitedMs,
    deadlineMs: evidence.deadlineMs,
    registeredAt: evidence.registeredAt,
    ...(reportPath ? { reportPath } : {}),
    // Surface a report-persistence failure on the durable trail (issue #2852)
    // without touching the happy-path shape: `error`/`timeout` only.
    ...(report.status === 'error' || report.status === 'timeout'
      ? { reportPersistence: report.status }
      : {}),
  });

  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: `First-hook miss: ${task.name ?? task.id}`,
    details:
      `No SessionStart / agent hook within ${Math.round(evidence.deadlineMs / 1000)}s of spawn — ` +
      'session terminated to free capacity.',
    severity: 'warning',
  });

  return { reportPath, reportPersistence: report.status };
}

/**
 * Evaluate and optionally reap a single agent for a first-hook miss.
 * Returns true when a task was reaped.
 */
export async function maybeReapFirstHookMiss(
  agentId: string,
  paneContent: string,
  deps: {
    taskStore: TaskStore;
    lifecycleDeps: LifecycleDeps;
    getFirstHookDeadlineMs?: () => number;
    getMcpStartupGracePeriodMs?: () => number;
    reportsDir?: string;
    auditLogPath?: string;
    dispositionLedgerPath?: string;
    broadcastToAll?: (msg: ServerMessage) => void;
    metrics?: Pick<FirstHookMissMetrics, 'recordMiss'>;
    reportPersistTimeoutMs?: number;
    promotePending?: () => Promise<void>;
    now?: () => Date;
  },
  state: FirstHookMissEvidence | undefined,
): Promise<boolean> {
  if (!state) return false;

  const task = deps.taskStore.findTaskBySession(agentId);
  if (!task || task.status !== 'inProgress') return false;

  const nowDate = deps.now?.() ?? new Date();
  const deadlineMs = deps.getFirstHookDeadlineMs?.() ?? DEFAULT_FIRST_HOOK_DEADLINE_MS;
  const mcpGrace = deps.getMcpStartupGracePeriodMs?.();
  const verdict = evaluateFirstHookMiss(state, {
    now: nowDate.getTime(),
    deadlineMs,
    ...(mcpGrace !== undefined ? { mcpStartupGracePeriodMs: mcpGrace } : {}),
  });
  if (!verdict.eligible) return false;

  console.warn(
    `[first-hook-miss] reaping task ${task.id} — no agent hook for ` +
      `${Math.round(verdict.waitedMs / 1000)}s (deadline ${Math.round(deadlineMs / 1000)}s)`,
  );

  await reapFirstHookMiss(
    task,
    {
      waitedMs: verdict.waitedMs,
      deadlineMs,
      registeredAt: state.registeredAt,
      firstHookAt: state.firstHookAt,
      mcpStartupAt: state.mcpStartupAt,
      paneContent,
    },
    {
      taskStore: deps.taskStore,
      lifecycleDeps: deps.lifecycleDeps,
      reportsDir: deps.reportsDir,
      auditLogPath: deps.auditLogPath,
      dispositionLedgerPath: deps.dispositionLedgerPath,
      broadcastToAll: deps.broadcastToAll,
      metrics: deps.metrics,
      reportPersistTimeoutMs: deps.reportPersistTimeoutMs,
      now: deps.now,
    },
  );

  await deps.promotePending?.();
  return true;
}
