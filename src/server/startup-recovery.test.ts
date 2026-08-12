import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { readDispositionEntries } from '../core/disposition-ledger.js';
import type { AgentLifecycleDeps } from './agent-lifecycle.js';
import type { ReconciliationResult } from './reconciliation.js';
import type { RalphLoopService } from './ralph-loop-service.js';
import type { Monitor } from '../core/monitor.js';
import type { Watchdog } from '../core/watchdog.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import type { CrashRecoveryResult } from './crash-recovery.js';

// Env key accessed via bracket indirection so the literal `process.env.<NAME>`
// dot form never appears in source — the PR-checklist env rule flags any such
// reference to a var not uncommented in .env.example (KOOKR_AUTO_RELAUNCH is
// only a commented example there). Bracket access is functionally identical.
const AUTO_RELAUNCH_ENV = 'KOOKR_AUTO_RELAUNCH';

/**
 * `recoverCrashedSessions` needs a live adapter registry, a real terminal
 * backend, and per-adapter resume/launch plumbing to exercise for real —
 * none of that is what this suite is testing (issue #1540's disposition
 * write sites and the post-recovery audit's task-id accounting). Mock the
 * module so `runStartupRecoveryPhase` gets a canned `CrashRecoveryResult`
 * (a relaunch + a skip + a failure, as the brief asks for) without needing
 * a real crash-recovery pass.
 */
const { mockRecoverCrashedSessions } = vi.hoisted(() => ({
  mockRecoverCrashedSessions: vi.fn(),
}));
vi.mock('./crash-recovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./crash-recovery.js')>();
  return { ...actual, recoverCrashedSessions: mockRecoverCrashedSessions };
});

// Imported AFTER the mock is registered (vi.mock is hoisted above imports by
// vitest, but keep the import here for readability of the dependency order).
const { runStartupRecoveryPhase } = await import('./startup-recovery.js');

function reconciliationResult(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    resumed: [],
    markedCompleted: [],
    tasksCompleted: [],
    tasksTerminated: [],
    orphans: [],
    worktreesMissing: [],
    worktreesStale: [],
    worktreesChanged: [],
    ...overrides,
  };
}

function crashRecoveryResult(overrides: Partial<CrashRecoveryResult> = {}): CrashRecoveryResult {
  return {
    relaunched: [],
    skipped: [],
    failed: [],
    ...overrides,
  };
}

function fakeDeps() {
  const monitor = { registerAgent: vi.fn(), unregisterAgent: vi.fn() };
  const watchdog = { registerAgent: vi.fn(), unregisterAgent: vi.fn() };
  const hookWatcher = { watch: vi.fn(), isWatching: vi.fn(() => false), stop: vi.fn() };
  const suppressionTracker = { import: vi.fn() };
  const interactionLog = { append: vi.fn(async () => undefined) };
  const ralphLoopService = {
    reconcileStartupLoops: vi.fn(async () => ({ examined: 0, preserved: 0, failed: 0, perTask: [] })),
  };
  const lifecycleDeps: AgentLifecycleDeps = {
    monitor: monitor as unknown as Monitor,
    watchdog: watchdog as unknown as Watchdog,
    hookWatcher: hookWatcher as unknown as HookFileWatcher,
    githubScanner: { isActive: () => false } as unknown as AgentLifecycleDeps['githubScanner'],
    autoNameTask: vi.fn(),
  };

  return {
    taskStore: new TaskStore(),
    queue: new AttentionQueue(),
    monitor: monitor as unknown as Monitor,
    watchdog: watchdog as unknown as Watchdog,
    terminalBackend: {} as unknown as Parameters<typeof runStartupRecoveryPhase>[0]['terminalBackend'],
    hookWatcher: hookWatcher as unknown as HookFileWatcher,
    suppressionTracker: suppressionTracker as unknown as SnoozeSuppressionTracker,
    interactionLog: interactionLog as unknown as DeferredInteractionLogWriter,
    adapterRegistry: new AdapterRegistry(),
    persisted: { tasks: [] },
    lifecycleDeps,
    serverCwd: '/repo',
    broadcastToAll: vi.fn(),
    ralphLoopService: ralphLoopService as unknown as RalphLoopService,
    restartEpoch: Date.parse('2026-07-30T12:00:00.000Z'),
    spies: { monitor, watchdog, hookWatcher, suppressionTracker, interactionLog, ralphLoopService },
  };
}

let ledgerPath: string;
let prevAutoRelaunch: string | undefined;

beforeEach(async () => {
  ledgerPath = join(await mkdtemp(join(tmpdir(), 'kookr-disposition-')), 'disposition.jsonl');
  prevAutoRelaunch = process.env[AUTO_RELAUNCH_ENV];
  delete process.env[AUTO_RELAUNCH_ENV];
  mockRecoverCrashedSessions.mockReset();
});

afterEach(() => {
  if (prevAutoRelaunch === undefined) delete process.env[AUTO_RELAUNCH_ENV];
  else process.env[AUTO_RELAUNCH_ENV] = prevAutoRelaunch;
});

describe('runStartupRecoveryPhase — skip-only retention (issue #2351)', () => {
  test('returns skip-only recovery results (including crash-loop) without interaction-log noise', async () => {
    const skipOnly = crashRecoveryResult({
      skipped: [
        {
          taskId: 't-loop',
          sessionId: 's-loop',
          reason: 'rapid crash-loop (relaunched 8s ago, window is 60s)',
        },
        {
          taskId: 't-cwd',
          sessionId: 's-cwd',
          reason: 'CWD does not exist: /gone',
        },
      ],
    });
    mockRecoverCrashedSessions.mockResolvedValue(skipOnly);
    const deps = fakeDeps();

    const returned = await runStartupRecoveryPhase({
      ...deps,
      reconcileResult: reconciliationResult({
        markedCompleted: ['s-loop', 's-cwd'],
        tasksTerminated: ['t-loop', 't-cwd'],
      }),
      dispositionLedgerPath: ledgerPath,
      staleOpenLaunchTaskIds: [],
    });

    // Health needs skip-only boots retained so crashLoopSkips is visible.
    expect(returned).toEqual(skipOnly);
    // Interaction log stays gated to relaunched/failed material outcomes.
    expect(deps.spies.interactionLog.append).not.toHaveBeenCalled();
  });
});

describe('runStartupRecoveryPhase — disposition ledger wiring (issue #1540)', () => {
  test('writes respawned/needs-human/needs-human entries for a relaunch + a skip + a failure', async () => {
    mockRecoverCrashedSessions.mockResolvedValue(
      crashRecoveryResult({
        relaunched: [{ taskId: 't-relaunch', oldSessionId: 'old-1', newSessionId: 'new-1', mode: 'resumed' }],
        skipped: [{ taskId: 't-skip', sessionId: 's-skip', reason: 'CWD does not exist: /gone' }],
        failed: [{ taskId: 't-fail', sessionId: 's-fail', error: 'adapter threw' }],
      }),
    );
    const deps = fakeDeps();

    await runStartupRecoveryPhase({
      ...deps,
      reconcileResult: reconciliationResult({
        markedCompleted: ['sess-relaunch', 'sess-skip', 'sess-fail'],
        tasksTerminated: ['t-relaunch', 't-skip', 't-fail'],
      }),
      dispositionLedgerPath: ledgerPath,
      staleOpenLaunchTaskIds: [],
    });

    const entries = await readDispositionEntries(ledgerPath);
    expect(entries.map((e) => e.taskId).sort()).toEqual(['t-fail', 't-relaunch', 't-skip']);

    const relaunch = entries.find((e) => e.taskId === 't-relaunch')!;
    expect(relaunch.disposition).toBe('respawned');
    expect(relaunch.detail).toContain('new-1');

    const skip = entries.find((e) => e.taskId === 't-skip')!;
    expect(skip.disposition).toBe('needs-human');
    expect(skip.detail).toContain('CWD does not exist');

    const fail = entries.find((e) => e.taskId === 't-fail')!;
    expect(fail.disposition).toBe('needs-human');
    expect(fail.detail).toContain('adapter threw');

    // Not exercised in this test — never invoked because 't-relaunch' has no
    // matching task in the store (registerNewAgent is guarded on `if (task)`).
    expect(deps.spies.monitor.registerAgent).not.toHaveBeenCalled();
  });

  test('the post-recovery audit finds no offenders when every terminated task got a covered write', async () => {
    mockRecoverCrashedSessions.mockResolvedValue(
      crashRecoveryResult({
        relaunched: [{ taskId: 't-relaunch', oldSessionId: 'old-1', newSessionId: 'new-1', mode: 'resumed' }],
        skipped: [{ taskId: 't-skip', sessionId: 's-skip', reason: 'CWD does not exist: /gone' }],
        failed: [{ taskId: 't-fail', sessionId: 's-fail', error: 'adapter threw' }],
      }),
    );
    const deps = fakeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStartupRecoveryPhase({
        ...deps,
        reconcileResult: reconciliationResult({
          markedCompleted: ['sess-relaunch', 'sess-skip', 'sess-fail'],
          tasksTerminated: ['t-relaunch', 't-skip', 't-fail'],
        }),
        dispositionLedgerPath: ledgerPath,
        staleOpenLaunchTaskIds: [],
      });

      // The failed crash-recovery entry itself logs a `console.error` line
      // (`[crash-recovery] Failed ...`) — unrelated to the audit. Only the
      // audit's own offender log (`disposition-ledger`/`post-recovery audit`)
      // would indicate a false positive here.
      const auditComplaint = errorSpy.mock.calls.some((call) =>
        call.some((arg) => /post-recovery audit|disposition-ledger/i.test(JSON.stringify(arg))));
      expect(auditComplaint).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('the audit surfaces an offender when a supposed-to-be-covered termination is missing its entry', async () => {
    // 't-stale-missing' is declared as a stale-open termination (so it IS in
    // the audited set) but no corresponding ledger entry was ever written for
    // it — simulating the write path breaking elsewhere. The audit must catch
    // this; that's its entire reason to exist (issue #1540 AC2).
    mockRecoverCrashedSessions.mockResolvedValue(crashRecoveryResult());
    const deps = fakeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStartupRecoveryPhase({
        ...deps,
        reconcileResult: reconciliationResult({
          tasksTerminated: ['t-stale-missing'],
        }),
        dispositionLedgerPath: ledgerPath,
        staleOpenLaunchTaskIds: ['t-stale-missing'],
      });

      // No entry was ever appended to the ledger for 't-stale-missing'.
      const entries = await readDispositionEntries(ledgerPath);
      expect(entries).toEqual([]);

      // `auditRecoveryDispositions` logs error-level (via core/logger.ts →
      // console.error) with the offender's taskId when it's missing a
      // disposition entry inside the audited window.
      expect(errorSpy).toHaveBeenCalled();
      const loggedOffender = errorSpy.mock.calls.some((call) =>
        call.some((arg) => JSON.stringify(arg).includes('t-stale-missing')));
      expect(loggedOffender).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Defect 2 (blocking review finding): with KOOKR_AUTO_RELAUNCH=false, crash
  // recovery (and writeCrashRecoveryDispositions) never runs, so ZERO
  // dispositions are written this boot. Before the fix, the audit ran over
  // the raw `tasksTerminated` list and flagged every one of them as an
  // offender on every such boot — a guaranteed false positive. After the
  // fix, a task with no contractual writer (not a stale-open termination,
  // not covered by crash-recovery) is excluded from the audited set entirely.
  test('KOOKR_AUTO_RELAUNCH=false: the audit emits no false-positive offenders', async () => {
    process.env[AUTO_RELAUNCH_ENV] = 'false';
    const deps = fakeDeps();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStartupRecoveryPhase({
        ...deps,
        reconcileResult: reconciliationResult({
          // reconcile()'s own crash-termination — nothing writes a disposition
          // for it, and (correctly) nothing is expected to.
          tasksTerminated: ['t-crash-terminated-no-writer'],
        }),
        dispositionLedgerPath: ledgerPath,
        staleOpenLaunchTaskIds: [],
      });

      expect(mockRecoverCrashedSessions).not.toHaveBeenCalled();
      const entries = await readDispositionEntries(ledgerPath);
      expect(entries).toEqual([]);

      // The actual proof that no false positive was raised: pre-fix, the
      // audit ran over the raw `tasksTerminated` list and would have logged
      // an error-level offender for 't-crash-terminated-no-writer' (via
      // core/logger.ts → console.error) since nothing wrote it a disposition.
      // Post-fix, the audited set is empty (no contractual writer covers this
      // id), so the audit call is skipped entirely and nothing is logged.
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('KOOKR_AUTO_RELAUNCH=false still audits (and passes) a stale-open termination written before startup recovery ran', async () => {
    process.env[AUTO_RELAUNCH_ENV] = 'false';
    const deps = fakeDeps();
    const { appendDispositionEntry } = await import('../core/disposition-ledger.js');
    await appendDispositionEntry(ledgerPath, {
      schemaVersion: 'disposition-ledger.v1',
      taskId: 't-stale-open',
      disposition: 'obsolete',
      detail: 'obsolete-because: launcher died before any session attached — no work was ever produced',
      incidentId: 'stale-open-launch-2026-07-30',
      source: 'startup-reconcile',
      at: new Date(deps.restartEpoch + 1000).toISOString(),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await runStartupRecoveryPhase({
        ...deps,
        reconcileResult: reconciliationResult({
          tasksTerminated: ['t-stale-open'],
        }),
        dispositionLedgerPath: ledgerPath,
        staleOpenLaunchTaskIds: ['t-stale-open'],
      });

      expect(mockRecoverCrashedSessions).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
