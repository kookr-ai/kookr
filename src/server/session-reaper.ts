/**
 * Orphan / terminal-task session reaper (issue #1720).
 *
 * Reconciliation (`reconciliation.ts`) already computes an orphan set at
 * startup and periodically (the "Orphan sessions (not in tasks):" log line)
 * but never acts on it — on 2026-07-30, 41 orphan dtach sessions accumulated
 * over ~a week, holding ~5.5 GB RSS+swap across 85 grok + claude + codex
 * processes, until the kernel OOM killer took out the prod server. A same-day
 * follow-up audit found a second leak class: a task can reach a terminal
 * status while its session's dtach master + agent process are still resident
 * (`kookr-826a3ebe`: `completed` task, codex process alive 1d16h) — the
 * fire-and-forget `adapter.stop()` call in `agent-lifecycle.ts`'s
 * `completeTask`/`terminateTask` can silently fail (only a `console.warn`, no
 * retry), and reconcile's own direct `taskStore.completeTask`/`terminateTask`
 * calls (bypassing the lifecycle wrappers entirely) never call `stop()` at
 * all.
 *
 * This module is the safety-net sweep for BOTH classes: it independently
 * cross-references every backend-reported live session against the
 * TaskStore, classifies each with the pure `core/session-reap-policy.ts`
 * logic, and terminates the ones past their age/grace threshold via the
 * backend's existing `killSession` (TERM -> grace -> KILL + socket removal —
 * see `local-dtach-backend.ts`). Deliberately does NOT touch
 * `reconciliation.ts` itself — reconcile stays a pure "compute the current
 * state" step; this is a separate "act on that state" step run after it, at
 * both startup and every periodic liveness tick.
 *
 * A third leak class (stale `dtach -a` attach clients from dead server
 * generations) is handled by the boot-only `runStaleAttacherSweep`, backed by
 * `adapters/dtach-attach-reaper.ts`.
 */
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import type { TaskStore } from '../core/tasks.js';
import {
  decideSessionReap,
  type SessionOwnership,
  type SessionReapConfig,
  type SessionReapDecision,
} from '../core/session-reap-policy.js';
import type { SessionId, TerminalBackend } from '../adapters/terminal-backend.js';
import { collectProcessTree } from '../adapters/process-tree.js';
import {
  listRealProcesses,
  reapStaleDtachAttachers,
  type ProcessTableEntry,
  type StaleDtachAttacher,
} from '../adapters/dtach-attach-reaper.js';
import { existsSync } from 'node:fs';

export interface SessionReaperDeps {
  taskStore: TaskStore;
  backend: TerminalBackend;
  /** Path to the shared audit.jsonl log. Omitted in tests that don't care about the trail. */
  auditLogPath?: string;
  /** Live config getter — same "live getter" convention as `getCleanupWorktreeOnComplete`. */
  getConfig: () => SessionReapConfig;
  now?: () => number;
  /**
   * Optional thunk sweeping stale Monitor state, bound by the server to both
   * `monitor.sweepAgedTerminalAgents(now - SNAPSHOT_TERMINAL_TASK_MAX_AGE_MS,
   * { skipSessionIds })` (aged terminal tasks, issue #1761) AND
   * `monitor.sweepUnownedDeadAgents({ liveSessionIds, graceMs })` (sessions
   * owned by no task and not live, issue #1763), returning the combined count.
   * Runs on every periodic reaper tick; the boot-time sweep is inert by
   * ordering (hook replay populates the monitor AFTER the boot sweep — the ~5s
   * liveness tick does the real first sweep). Receives this sweep's live
   * session ids so an
   * agent whose session is still alive is NEVER swept (sweeping is terminal:
   * a stopped agent's late hook events are dropped, not re-created — see
   * Monitor.sweepAgedTerminalAgents). Deliberately NOT gated on the reaper
   * kill switch (`KOOKR_REAP_ORPHAN_SESSIONS=false`): with live sessions
   * excluded, the sweep only clears monitor memory of already-dead sessions,
   * which is memory hygiene, not session reaping. Returns the number swept.
   */
  sweepMonitorAgedAgents?: (liveSessionIds: ReadonlySet<string>) => number;
}

export interface SessionReapSweepResult {
  /** Live sessions examined this sweep. */
  scanned: number;
  /** Sessions actually reaped this sweep, with their decision. */
  reaped: SessionReapDecision[];
  /** Live sessions currently classified as unowned (regardless of whether they were old enough to reap). */
  orphanCount: number;
  /** Live sessions currently classified as belonging to an already-terminal task. */
  terminalLeakCount: number;
}

export interface SessionReaperHealthSnapshot {
  enabled: boolean;
  lastSweepAt: string | null;
  lastOrphanCount: number;
  lastTerminalLeakCount: number;
  totalSessionsReaped: number;
  totalStaleAttachersReaped: number;
  lastStaleAttacherSweepAt: string | null;
}

/** Build a `session id -> ownership` lookup from the current TaskStore snapshot. */
function buildOwnershipMap(taskStore: TaskStore): Map<SessionId, SessionOwnership> {
  const map = new Map<SessionId, SessionOwnership>();
  for (const task of taskStore.listTasks()) {
    for (const session of task.sessions) {
      map.set(session.tmuxSession, {
        kind: 'owned',
        taskId: task.id,
        taskStatus: task.status,
        sessionLastStatus: session.lastStatus,
      });
    }
  }
  return map;
}

/** Best-effort process-tree size for the audit row. Linux-only; `null` when unresolvable. */
function bestEffortProcessCount(backend: TerminalBackend, id: SessionId): number | null {
  const masterPid = backend.getSessionDiagnostics?.(id)?.masterPid ?? null;
  if (masterPid === null || masterPid <= 0) return null;
  const tree = collectProcessTree(masterPid);
  return tree.length > 0 ? tree.length : null;
}

/**
 * Orchestrates the orphan/terminal-task sweep (leak classes 1 + 2) and the
 * boot-only stale-attach-client sweep (leak class 3), and holds the small
 * in-memory counters `/api/health` reads (issue #1553: NEVER re-derive these
 * on the request path — the health route only reads whatever this service's
 * last sweep already computed).
 */
export class SessionReaperService {
  private lastSweepAt: string | null = null;
  private lastOrphanCount = 0;
  private lastTerminalLeakCount = 0;
  private totalSessionsReaped = 0;
  private totalStaleAttachersReaped = 0;
  private lastStaleAttacherSweepAt: string | null = null;

  constructor(private readonly deps: SessionReaperDeps) {}

  /** Run the orphan + terminal-task-leak sweep. Safe to call at boot and on every periodic tick. */
  async runSweep(): Promise<SessionReapSweepResult> {
    const config = this.deps.getConfig();
    const now = this.deps.now?.() ?? Date.now();
    const ownershipMap = buildOwnershipMap(this.deps.taskStore);
    const liveSessions = await this.deps.backend.listSessions();

    const reaped: SessionReapDecision[] = [];
    let orphanCount = 0;
    let terminalLeakCount = 0;

    for (const id of liveSessions) {
      const ownership: SessionOwnership = ownershipMap.get(id) ?? { kind: 'unowned' };
      const startedAtMs = (await this.deps.backend.getSessionStartedAt?.(id)) ?? null;
      const decision = decideSessionReap(id, ownership, startedAtMs, now, config);

      if (decision.kind === 'unowned') orphanCount += 1;
      else if (decision.kind === 'terminal-task-leak') terminalLeakCount += 1;

      if (!decision.shouldReap) continue;

      const processCount = bestEffortProcessCount(this.deps.backend, id);
      const ownerTaskId = ownership.kind === 'owned' ? ownership.taskId : null;
      try {
        await this.deps.backend.killSession(id);
      } catch (err) {
        console.warn(`[session-reaper] killSession failed for ${id}:`, err instanceof Error ? err.message : err);
        continue;
      }
      reaped.push(decision);
      this.totalSessionsReaped += 1;

      await appendAuditRow(this.deps.auditLogPath, {
        type: 'session.reap',
        timestamp: nowISO(),
        actor: 'system:session-reaper',
        sessionId: id,
        taskId: ownerTaskId,
        kind: decision.kind,
        ageMs: decision.ageMs,
        processCount,
        signal: 'SIGTERM_then_SIGKILL',
        reason: decision.reason,
      });

      console.warn(
        `[session-reaper] reaped ${decision.kind} session ${id}` +
        (ownerTaskId ? ` (task ${ownerTaskId})` : '') +
        `: ${decision.reason}`,
      );
    }

    this.lastSweepAt = nowISO();
    this.lastOrphanCount = orphanCount;
    this.lastTerminalLeakCount = terminalLeakCount;

    // Stale Monitor-state sweep (issues #1761 aged-terminal + #1763 unowned):
    // piggybacks on this safety-net tick because the paths that create the leak
    // (startup hook replay, reconciliation terminal transitions, deleted-task
    // orphans) have no teardown of their own. Best-effort — a throw here must
    // not break session reaping.
    if (this.deps.sweepMonitorAgedAgents) {
      try {
        const sweptAgents = this.deps.sweepMonitorAgedAgents(new Set(liveSessions));
        if (sweptAgents > 0) {
          console.log(`[session-reaper] swept ${sweptAgents} stale monitor agent(s) (issues #1761/#1763)`);
        }
      } catch (err) {
        console.warn('[session-reaper] monitor aged-agent sweep failed:', err instanceof Error ? err.message : err);
      }
    }

    return { scanned: liveSessions.length, reaped, orphanCount, terminalLeakCount };
  }

  /**
   * Boot-only: kill stale `dtach -a` attach clients from dead server
   * generations (issue #1720 leak class 3). `instanceDir` is this backend's
   * own socket directory (`LocalDtachBackend.getInstanceDir()`) so the scan
   * never touches another port's sessions or a user's own terminal.
   */
  async runStaleAttacherSweep(
    instanceDir: string,
    listProcesses: () => ProcessTableEntry[] = listRealProcesses,
  ): Promise<StaleDtachAttacher[]> {
    const config = this.deps.getConfig();
    if (!config.enabled) return [];

    const stale = await reapStaleDtachAttachers(instanceDir, {
      listProcesses,
      socketExists: (sock) => existsSync(sock),
    });

    this.lastStaleAttacherSweepAt = nowISO();
    this.totalStaleAttachersReaped += stale.length;

    for (const attacher of stale) {
      await appendAuditRow(this.deps.auditLogPath, {
        type: 'session.reapStaleAttacher',
        timestamp: nowISO(),
        actor: 'system:session-reaper',
        pid: attacher.pid,
        sock: attacher.sock,
        signal: 'SIGTERM_then_SIGKILL',
        reason: 'stale dtach -a attach client from a dead server generation (target socket missing)',
      });
    }

    if (stale.length > 0) {
      console.warn(`[session-reaper] reaped ${stale.length} stale dtach attach client(s) under ${instanceDir}`);
    }

    return stale;
  }

  /** Cheap, in-memory snapshot for `/api/health` (issue #1553: no disk/process scan on the request path). */
  getHealthSnapshot(): SessionReaperHealthSnapshot {
    return {
      enabled: this.deps.getConfig().enabled,
      lastSweepAt: this.lastSweepAt,
      lastOrphanCount: this.lastOrphanCount,
      lastTerminalLeakCount: this.lastTerminalLeakCount,
      totalSessionsReaped: this.totalSessionsReaped,
      totalStaleAttachersReaped: this.totalStaleAttachersReaped,
      lastStaleAttacherSweepAt: this.lastStaleAttacherSweepAt,
    };
  }
}
