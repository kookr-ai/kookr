import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import {
  appendSignalOutbox,
  buildSignalOutboxEntry,
  readPendingSignals,
} from '../core/signal-outbox.js';
import { SignalOutboxService } from './signal-outbox-service.js';

async function tempSpoolDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-signal-outbox-svc-'));
}

describe('SignalOutboxService', () => {
  test('drains a spooled completion-ready onto a live task exactly once', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.startTask(task.id);

    const entry = buildSignalOutboxEntry({
      signalId: 'sig-1',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'PR open',
    });
    await appendSignalOutbox(spoolDir, entry);

    const outcomes: Array<{ taskId: string; kind: string }> = [];
    const svc = new SignalOutboxService({
      taskStore: store,
      spoolDir,
      onTaskOutcome: (taskId, outcome) => {
        outcomes.push({ taskId, kind: outcome.kind });
      },
    });

    const first = await svc.tick();
    expect(first.drained.delivered).toBe(1);
    expect(first.drained.remaining).toBe(0);
    expect(store.getPendingSignal(task.id)).toMatchObject({
      kind: 'completion_ready',
      note: 'PR open',
      signalId: 'sig-1',
    });
    expect(outcomes).toEqual([{ taskId: task.id, kind: 'completion_ready' }]);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);

    // Re-append the same signalId (simulates a client that timed out mid-POST
    // and later re-spooled / drain re-ran) — must be a pure no-op.
    await appendSignalOutbox(spoolDir, entry);
    const second = await svc.tick();
    expect(second.drained.delivered).toBe(1);
    expect(second.drained.remaining).toBe(0);
    expect(outcomes).toHaveLength(1); // outcome hook not re-fired
  });

  test('issue #3066: quarantines a stale completion_ready bound to a prior session; live task stays nonterminal', async () => {
    // Reproduces the 2026-09-08 `outbox_drained` incident: a completion delivery
    // raised for an EARLIER generation of a task survives a crash in the spool,
    // then is drained against the same task after a NEW live session started.
    // Applying it would auto-complete the live worker with an unrelated older
    // delivery. The identity fence must discard it with an observable reason.
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('KB-Scout finetune iteration 5', '/repo');
    store.startTask(task.id);
    // The current, live generation's session.
    store.addSession(task.id, {
      tmuxSession: 'kookr-gen-5',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });

    // Stale entry bound to a PRIOR generation's session (the one that merged the
    // old PR), surviving in the spool across a restart.
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'stale-535',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'Delivered: PR #535 merged; post-merge cleanup exceeded the 10m budget',
      boundSessionId: 'kookr-gen-1',
    }));

    const logs: string[] = [];
    const svc = new SignalOutboxService({ taskStore: store, spoolDir, log: (m) => logs.push(m) });
    const result = await svc.tick();

    // Quarantined (discarded), not accepted.
    expect(result.drained.permanentFailed).toBe(1);
    expect(result.drained.delivered).toBe(0);
    // The live task never received the completion signal and stays nonterminal.
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe('inProgress');
    // The stale entry is drained out of the spool (not left to retry forever).
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
    // Observable reason names the generation mismatch.
    expect(logs.some((m) => m.includes('quarantine') && m.includes('kookr-gen-1'))).toBe(true);
  });

  test('issue #3066: a bound completion_ready is quarantined when the task has no session yet', async () => {
    // Boundary: a stale entry carries a bound session, but the task currently
    // has no recorded session (e.g. relaunched/reopened before the new session
    // attaches). The fence must still refuse — a bound entry can only apply to
    // its own generation — and name the missing session in the reason.
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('reopened, no session yet', '/repo');
    store.startTask(task.id); // deliberately no addSession()

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'stale-nosession',
      taskId: task.id,
      kind: 'completion_ready',
      boundSessionId: 'kookr-gen-1',
    }));

    const logs: string[] = [];
    const svc = new SignalOutboxService({ taskStore: store, spoolDir, log: (m) => logs.push(m) });
    const result = await svc.tick();

    expect(result.drained.permanentFailed).toBe(1);
    expect(result.drained.delivered).toBe(0);
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe('inProgress');
    expect(logs.some((m) => m.includes('quarantine') && m.includes('(none)'))).toBe(true);
  });

  test('issue #3066: a completion_ready bound to the CURRENT session still drains', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Ship it', '/repo');
    store.startTask(task.id);
    store.addSession(task.id, {
      tmuxSession: 'kookr-gen-5',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'fresh-1',
      taskId: task.id,
      kind: 'completion_ready',
      boundSessionId: 'kookr-gen-5',
    }));

    const svc = new SignalOutboxService({ taskStore: store, spoolDir });
    const result = await svc.tick();
    expect(result.drained.delivered).toBe(1);
    expect(store.getPendingSignal(task.id)?.kind).toBe('completion_ready');
  });

  test('drops permanent failures (unknown / terminal task) and keeps nothing', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Done', '/repo');
    store.startTask(task.id);
    store.completeTask(task.id);

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'dead-task',
      taskId: task.id,
      kind: 'completion_ready',
    }));
    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'missing',
      taskId: 'no-such-task',
      kind: 'completion_ready',
    }));

    const svc = new SignalOutboxService({ taskStore: store, spoolDir });
    const result = await svc.tick();
    expect(result.drained.permanentFailed).toBe(2);
    expect(result.drained.remaining).toBe(0);
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
  });

  test('offline→online integration: CLI-shaped spool drains after "daemon" is up', async () => {
    // Acceptance criterion #1541: signal against a down daemon, bring daemon
    // up, assert single delivery + empty spool. Modeled without HTTP: the CLI
    // only writes the outbox; the service is what the restarted daemon runs.
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Lucy Daily Progress Report', '/repo');
    store.startTask(task.id);

    // Phase 1 — daemon is down: CLI writes the outbox and exits 0 (no deliver).
    const entry = buildSignalOutboxEntry({
      signalId: 'offline-1',
      taskId: task.id,
      kind: 'completion_ready',
      note: 'report ready',
    });
    await appendSignalOutbox(spoolDir, entry);
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    expect(await readPendingSignals(spoolDir)).toHaveLength(1);

    // Phase 2 — daemon restarts: service boot tick delivers exactly once.
    const broadcasts = vi.fn();
    const svc = new SignalOutboxService({
      taskStore: store,
      spoolDir,
      onDelivered: broadcasts,
    });
    const tick = await svc.tick();
    expect(tick.drained.delivered).toBe(1);
    expect(tick.drained.remaining).toBe(0);
    expect(store.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
    expect(broadcasts).toHaveBeenCalledTimes(1);

    // Phase 3 — a second tick (or a client re-POST with the same signalId)
    // must not re-apply. Capture raisedAt, re-drain, assert unchanged.
    const raisedAt = store.getPendingSignal(task.id)?.raisedAt;
    await appendSignalOutbox(spoolDir, entry);
    const again = await svc.tick();
    expect(again.drained.delivered).toBe(1);
    expect(store.getPendingSignal(task.id)?.raisedAt).toBe(raisedAt);
  });

  test('stamps signal source=outbox on delivered completion_ready (issue #1608)', async () => {
    const spoolDir = await tempSpoolDir();
    const store = new TaskStore();
    const task = store.createTask('Path stamp', '/repo');
    store.startTask(task.id);

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'src-1',
      taskId: task.id,
      kind: 'completion_ready',
    }));
    const svc = new SignalOutboxService({ taskStore: store, spoolDir });
    await svc.tick();
    expect(store.getPendingSignal(task.id)?.source).toBe('outbox');
  });

  test('rejects completion_ready drain when sessions exist without lesson decision (issue #1608)', async () => {
    const spoolDir = await tempSpoolDir();
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-dir-'));
    const hooksDir = join(kookrDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'sess-nodecision.jsonl'),
      `${JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
      })}\n`,
      'utf8',
    );

    const store = new TaskStore();
    const task = store.createTask('Needs lesson', '/repo');
    store.startTask(task.id);
    // Attach a session so the gate does not fail-open.
    store.addSession(task.id, {
      tmuxSession: 'sess-nodecision',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
    });

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'gated-1',
      taskId: task.id,
      kind: 'completion_ready',
    }));

    const svc = new SignalOutboxService({ taskStore: store, spoolDir, kookrDir });
    const result = await svc.tick();
    expect(result.drained.permanentFailed).toBe(1);
    expect(result.drained.delivered).toBe(0);
    expect(store.getPendingSignal(task.id)).toBeUndefined();
    expect(await readPendingSignals(spoolDir)).toHaveLength(0);
  });

  test('allows completion_ready drain after Grok-shaped lesson skip (issue #1608)', async () => {
    const spoolDir = await tempSpoolDir();
    const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-dir-'));
    const hooksDir = join(kookrDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, 'sess-grok.jsonl'),
      `${JSON.stringify({
        hookEventName: 'pre_tool_use',
        toolName: 'run_terminal_command',
        toolInput: { command: 'printf \'No generic KB lesson: scheduled tick\\n\'' },
      })}\n`,
      'utf8',
    );

    const store = new TaskStore();
    const task = store.createTask('Grok skip', '/repo');
    store.startTask(task.id);
    store.addSession(task.id, {
      tmuxSession: 'sess-grok',
      agentType: 'grok-build',
      cwd: '/repo',
      createdAt: new Date(),
    });

    await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
      signalId: 'grok-1',
      taskId: task.id,
      kind: 'completion_ready',
    }));

    const svc = new SignalOutboxService({ taskStore: store, spoolDir, kookrDir });
    const result = await svc.tick();
    expect(result.drained.delivered).toBe(1);
    expect(store.getPendingSignal(task.id)).toMatchObject({
      kind: 'completion_ready',
      source: 'outbox',
    });
  });

  test('rejects completion_ready drain when merge authority + open unmerged PR (issue #1836)', async () => {
    const previousLesson = process.env.KOOKR_LESSON_DECISION_GATE;
    process.env.KOOKR_LESSON_DECISION_GATE = 'off';
    try {
      const spoolDir = await tempSpoolDir();
      const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-dir-'));
      const hooksDir = join(kookrDir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        join(hooksDir, 'sess-merge.jsonl'),
        `${JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'gh pr create --fill' },
        })}\n`,
        'utf8',
      );

      const store = new TaskStore();
      const task = store.createTask(
        'TERMINAL-STATE CONTRACT (mergeAfterImplementation=true): merge authority',
        '/repo',
      );
      store.startTask(task.id);
      store.addSession(task.id, {
        tmuxSession: 'sess-merge',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });

      await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
        signalId: 'merge-gated-1',
        taskId: task.id,
        kind: 'completion_ready',
      }));

      const svc = new SignalOutboxService({ taskStore: store, spoolDir, kookrDir });
      const result = await svc.tick();
      expect(result.drained.permanentFailed).toBe(1);
      expect(result.drained.delivered).toBe(0);
      expect(store.getPendingSignal(task.id)).toBeUndefined();
      expect(await readPendingSignals(spoolDir)).toHaveLength(0);
    } finally {
      if (previousLesson === undefined) delete process.env.KOOKR_LESSON_DECISION_GATE;
      else process.env.KOOKR_LESSON_DECISION_GATE = previousLesson;
    }
  });

  test('allows completion_ready drain after PR-BLOCKER for merge-authority task (issue #1836)', async () => {
    const previousLesson = process.env.KOOKR_LESSON_DECISION_GATE;
    process.env.KOOKR_LESSON_DECISION_GATE = 'off';
    try {
      const spoolDir = await tempSpoolDir();
      const kookrDir = await mkdtemp(join(tmpdir(), 'kookr-dir-'));
      const hooksDir = join(kookrDir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        join(hooksDir, 'sess-blocker.jsonl'),
        [
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'gh pr create --fill' },
          }),
          JSON.stringify({
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: "printf 'PR-BLOCKER: checks red\\n'" },
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const store = new TaskStore();
      const task = store.createTask(
        'TERMINAL-STATE CONTRACT (mergeAfterImplementation=true): merge authority',
        '/repo',
      );
      store.startTask(task.id);
      store.addSession(task.id, {
        tmuxSession: 'sess-blocker',
        agentType: 'claude-code',
        cwd: '/repo',
        createdAt: new Date(),
      });

      await appendSignalOutbox(spoolDir, buildSignalOutboxEntry({
        signalId: 'merge-blocker-1',
        taskId: task.id,
        kind: 'completion_ready',
      }));

      const svc = new SignalOutboxService({ taskStore: store, spoolDir, kookrDir });
      const result = await svc.tick();
      expect(result.drained.delivered).toBe(1);
      expect(store.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    } finally {
      if (previousLesson === undefined) delete process.env.KOOKR_LESSON_DECISION_GATE;
      else process.env.KOOKR_LESSON_DECISION_GATE = previousLesson;
    }
  });
});
