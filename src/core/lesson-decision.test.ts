import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeLessonYield,
  evaluateLessonDecisionGate,
  extractShellCommandFromHookLine,
  isLessonDecisionGateEnabled,
  isLessonDecisionSatisfied,
  LESSON_DECISION_GATE_ENV,
  LESSON_DECISION_HOOKS_MISSING_CODE,
  LESSON_DECISION_HOOKS_MISSING_HINT,
  LESSON_DECISION_REQUIRED_CODE,
  LESSON_DECISION_HINT,
  resolveCompletionPath,
  resolveTaskLessonDecision,
  scanHookLogForLessonDecision,
  stampTaskCompletionProvenance,
  LESSON_YIELD_SCHEMA_VERSION,
} from './lesson-decision.js';
import { KB_LESSON_SKIP_MARKER } from './kb-lesson-classifier.js';

function preToolBash(command: string): string {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

/** Grok Build camelCase pre_tool_use / run_terminal_command shape (issue #1608). */
function preToolGrok(command: string): string {
  return JSON.stringify({
    hookEventName: 'pre_tool_use',
    toolName: 'run_terminal_command',
    toolInput: { command, description: 'test' },
  });
}

describe('isLessonDecisionSatisfied', () => {
  test('accepts wrote-lesson and explicit-skip only', () => {
    expect(isLessonDecisionSatisfied('wrote-lesson')).toBe(true);
    expect(isLessonDecisionSatisfied('explicit-skip')).toBe(true);
    expect(isLessonDecisionSatisfied('search-only')).toBe(false);
    expect(isLessonDecisionSatisfied('no-kb-activity')).toBe(false);
  });
});

describe('evaluateLessonDecisionGate', () => {
  test('allows when decision is wrote-lesson', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 1,
      decision: 'wrote-lesson',
    });
    expect(v.allow).toBe(true);
    expect(v.code).toBeUndefined();
  });

  test('allows when decision is explicit-skip', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 1,
      decision: 'explicit-skip',
    });
    expect(v.allow).toBe(true);
  });

  test('rejects search-only with lesson_decision_required', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 1,
      decision: 'search-only',
    });
    expect(v.allow).toBe(false);
    expect(v.code).toBe(LESSON_DECISION_REQUIRED_CODE);
    expect(v.hint).toContain('kb remember');
    expect(v.hint).toContain(KB_LESSON_SKIP_MARKER);
  });

  test('rejects no-kb-activity when logs are present', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 2,
      missingLogs: 0,
      decision: 'no-kb-activity',
    });
    expect(v.allow).toBe(false);
    expect(v.code).toBe(LESSON_DECISION_REQUIRED_CODE);
    expect(v.hint).toBe(LESSON_DECISION_HINT);
  });

  test('rejects all-logs-missing with lesson_decision_hooks_missing (issue #1868)', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 2,
      missingLogs: 2,
      decision: 'no-kb-activity',
    });
    expect(v.allow).toBe(false);
    expect(v.code).toBe(LESSON_DECISION_HOOKS_MISSING_CODE);
    expect(v.hint).toBe(LESSON_DECISION_HOOKS_MISSING_HINT);
    expect(v.hint).toMatch(/prun|rotat/i);
    expect(v.reason).toMatch(/missing on disk/i);
    expect(v.missingLogs).toBe(2);
    expect(v.sessionsScanned).toBe(2);
    // Distinct from the logs-present branch.
    expect(v.code).not.toBe(LESSON_DECISION_REQUIRED_CODE);
    expect(v.hint).not.toBe(LESSON_DECISION_HINT);
  });

  test('partial missing logs still uses lesson_decision_required (issue #1868)', () => {
    // At least one log present → operator path is "missed decision", not prune.
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 2,
      missingLogs: 1,
      decision: 'no-kb-activity',
    });
    expect(v.allow).toBe(false);
    expect(v.code).toBe(LESSON_DECISION_REQUIRED_CODE);
  });

  test('fail-open when no sessions were scanned', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 0,
      decision: 'no-kb-activity',
    });
    expect(v.allow).toBe(true);
    expect(v.reason).toMatch(/no agent sessions/i);
  });

  test('fail-open when gate is disabled', () => {
    const v = evaluateLessonDecisionGate({
      enabled: false,
      sessionsScanned: 1,
      decision: 'no-kb-activity',
    });
    expect(v.allow).toBe(true);
  });
});

describe('isLessonDecisionGateEnabled', () => {
  const previous = process.env[LESSON_DECISION_GATE_ENV];

  afterEach(() => {
    if (previous === undefined) delete process.env[LESSON_DECISION_GATE_ENV];
    else process.env[LESSON_DECISION_GATE_ENV] = previous;
  });

  test('defaults to enabled', () => {
    delete process.env[LESSON_DECISION_GATE_ENV];
    expect(isLessonDecisionGateEnabled({})).toBe(true);
  });

  test('recognizes off values', () => {
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: '0' })).toBe(false);
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: 'false' })).toBe(false);
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: 'OFF' })).toBe(false);
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: 'no' })).toBe(false);
  });

  test('treats other values as enabled', () => {
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: '1' })).toBe(true);
    expect(isLessonDecisionGateEnabled({ [LESSON_DECISION_GATE_ENV]: 'on' })).toBe(true);
  });
});

describe('scanHookLogForLessonDecision + resolveTaskLessonDecision', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kookr-lesson-decision-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('detects kb remember as wrote-lesson', async () => {
    const log = join(dir, 'hooks', 'sess-a.jsonl');
    writeFileSync(
      log,
      [
        preToolBash('kb search "x"'),
        preToolBash('cat <<EOF | kb remember --kb=agent-task-lessons --title="t" --stdin --yes\nbody\nEOF'),
        '',
      ].join('\n'),
      'utf8',
    );
    const stats = await scanHookLogForLessonDecision(log);
    expect(stats.lessonWrites).toBe(1);
    expect(stats.kbSearches).toBe(1);
    expect(stats.exists).toBe(true);

    const result = await resolveTaskLessonDecision(
      { id: 't1', sessions: [{ tmuxSession: 'sess-a' }] },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('wrote-lesson');
    expect(result.satisfied).toBe(true);
    expect(result.sessionsScanned).toBe(1);
  });

  test('detects skip marker as explicit-skip', async () => {
    const log = join(dir, 'hooks', 'sess-b.jsonl');
    writeFileSync(
      log,
      preToolBash(`printf '%s\\n' '${KB_LESSON_SKIP_MARKER} purely mechanical rename'`) + '\n',
      'utf8',
    );
    const result = await resolveTaskLessonDecision(
      { id: 't2', sessions: [{ tmuxSession: 'sess-b' }] },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('explicit-skip');
    expect(result.satisfied).toBe(true);
  });

  test('missing log counts as no-kb-activity', async () => {
    const result = await resolveTaskLessonDecision(
      { id: 't3', sessions: [{ tmuxSession: 'never-existed' }] },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('no-kb-activity');
    expect(result.missingLogs).toBe(1);
    expect(result.satisfied).toBe(false);
  });

  test('rejects path-traversal session names without opening files outside hooksDir', async () => {
    // Plant a decoy file that would satisfy the gate IF the path escaped.
    const outside = join(dir, 'evil.jsonl');
    writeFileSync(
      outside,
      preToolBash('kb remember --kb=agent-task-lessons --title=x --stdin --yes') + '\n',
      'utf8',
    );
    const result = await resolveTaskLessonDecision(
      { id: 't-evil', sessions: [{ tmuxSession: '../evil' }] },
      join(dir, 'hooks'),
    );
    expect(result.sessionsScanned).toBe(1);
    expect(result.missingLogs).toBe(1);
    expect(result.decision).toBe('no-kb-activity');
    expect(result.satisfied).toBe(false);
  });

  test('aggregates across multiple sessions (write wins)', async () => {
    writeFileSync(
      join(dir, 'hooks', 's1.jsonl'),
      preToolBash('kb search foo') + '\n',
      'utf8',
    );
    writeFileSync(
      join(dir, 'hooks', 's2.jsonl'),
      preToolBash('kb remember --kb=agent-task-lessons --title=x --stdin --yes') + '\n',
      'utf8',
    );
    const result = await resolveTaskLessonDecision(
      {
        id: 't4',
        sessions: [{ tmuxSession: 's1' }, { tmuxSession: 's2' }],
      },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('wrote-lesson');
    expect(result.sessionsScanned).toBe(2);
  });

  test('detects Grok Build camelCase pre_tool_use / run_terminal_command (issue #1608)', async () => {
    const log = join(dir, 'hooks', 'sess-grok.jsonl');
    writeFileSync(
      log,
      [
        preToolGrok('kb search "topic"'),
        preToolGrok(`printf '%s\\n' '${KB_LESSON_SKIP_MARKER} scheduled tick'`),
        '',
      ].join('\n'),
      'utf8',
    );
    const stats = await scanHookLogForLessonDecision(log);
    expect(stats.lessonSkips).toBe(1);
    expect(stats.kbSearches).toBe(1);
    const result = await resolveTaskLessonDecision(
      { id: 't-grok', sessions: [{ tmuxSession: 'sess-grok' }] },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('explicit-skip');
    expect(result.satisfied).toBe(true);
  });

  test('detects Grok Build kb remember as wrote-lesson (issue #1608)', async () => {
    const log = join(dir, 'hooks', 'sess-grok-write.jsonl');
    writeFileSync(
      log,
      preToolGrok('kb remember --kb=agent-task-lessons --title=t --stdin --yes') + '\n',
      'utf8',
    );
    const result = await resolveTaskLessonDecision(
      { id: 't-grok-w', sessions: [{ tmuxSession: 'sess-grok-write' }] },
      join(dir, 'hooks'),
    );
    expect(result.decision).toBe('wrote-lesson');
  });
});

describe('extractShellCommandFromHookLine + completion path (issue #1608)', () => {
  test('accepts Claude and Grok shell pre-tool shapes', () => {
    expect(
      extractShellCommandFromHookLine({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
    ).toBe('echo hi');
    expect(
      extractShellCommandFromHookLine({
        hookEventName: 'pre_tool_use',
        toolName: 'run_terminal_command',
        toolInput: { command: 'ls' },
      }),
    ).toBe('ls');
    expect(
      extractShellCommandFromHookLine({
        hookEventName: 'pre_tool_use',
        toolName: 'read_file',
        toolInput: { target_file: '/x' },
      }),
    ).toBeNull();
  });

  test('resolveCompletionPath maps signal source and actors', () => {
    expect(resolveCompletionPath({ hadPendingCompletionReady: true, signalSource: 'http' })).toBe('normal');
    expect(resolveCompletionPath({ hadPendingCompletionReady: true, signalSource: 'outbox' })).toBe(
      'outbox_drained',
    );
    expect(resolveCompletionPath({ actorSource: 'api' })).toBe('api_complete');
    expect(resolveCompletionPath({ actorSource: 'websocket' })).toBe('ui_complete');
    expect(resolveCompletionPath({ actorSource: 'system:completion-ready-ttl' })).toBe('recovery');
  });

  test('stampTaskCompletionProvenance leaves exempt off when signal was pending', () => {
    const task: {
      pendingSignal?: { kind?: string; source?: 'http' | 'outbox' };
      completionPath?: string;
      lessonGateExempt?: string;
    } = {
      pendingSignal: { kind: 'completion_ready', source: 'outbox' },
    };
    const stamped = stampTaskCompletionProvenance(task);
    expect(stamped.completionPath).toBe('outbox_drained');
    expect(stamped.lessonGateExempt).toBeUndefined();
    expect(task.lessonGateExempt).toBeUndefined();
  });

  test('stampTaskCompletionProvenance stamps default exempt for api complete', () => {
    const task: {
      pendingSignal?: { kind?: string; source?: 'http' | 'outbox' };
      completionPath?: string;
      lessonGateExempt?: string;
    } = {};
    const stamped = stampTaskCompletionProvenance(task, { actorSource: 'api' });
    expect(stamped.completionPath).toBe('api_complete');
    expect(stamped.lessonGateExempt).toBe('api_complete_ungated');
  });
});

describe('scan hardening (issue #1553)', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `kookr-lesson-scan-hardening-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a pre-aborted signal rejects the scan with the abort reason', async () => {
    const log = join(dir, 'hooks', 'sess-abort.jsonl');
    writeFileSync(log, preToolBash('kb search x') + '\n', 'utf8');
    const controller = new AbortController();
    controller.abort(new Error('scan-cancelled'));
    await expect(
      scanHookLogForLessonDecision(log, { signal: controller.signal }),
    ).rejects.toThrow('scan-cancelled');
  });

  test('an abort mid-scan interrupts a large in-progress scan', async () => {
    const log = join(dir, 'hooks', 'sess-midscan.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(preToolBash(`echo filler ${i}`));
    writeFileSync(log, lines.join('\n') + '\n', 'utf8');

    const controller = new AbortController();
    const scan = scanHookLogForLessonDecision(log, { signal: controller.signal });
    // Fires while the ~4MB scan is still iterating (parsing 50k JSON lines
    // takes far longer than one timer tick). Depending on where the abort
    // lands it surfaces as the abort reason (between lines) or as the
    // stream's AbortError (mid-chunk) — both are interruptions.
    setTimeout(() => controller.abort(new Error('mid-scan-abort')), 5);
    await expect(scan).rejects.toThrow(/mid-scan-abort|abort/i);
  });

  test('computeLessonYield propagates an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('yield-cancelled'));
    await expect(
      computeLessonYield([], join(dir, 'hooks'), { signal: controller.signal }),
    ).rejects.toThrow('yield-cancelled');
  });

  test('resolveTaskLessonDecision propagates an aborted signal', async () => {
    writeFileSync(
      join(dir, 'hooks', 'sess-x.jsonl'),
      preToolBash('kb search x') + '\n',
      'utf8',
    );
    const controller = new AbortController();
    controller.abort(new Error('resolve-cancelled'));
    await expect(
      resolveTaskLessonDecision(
        { id: 't-abort', sessions: [{ tmuxSession: 'sess-x' }] },
        join(dir, 'hooks'),
        { signal: controller.signal },
      ),
    ).rejects.toThrow('resolve-cancelled');
  });

  // The 2026-07-26 prod OOM regression: the scanner breaks early on the first
  // decisive lesson write, and `rl.close()` alone left the underlying read
  // stream's file descriptor pinned open. /proc-based, so Linux-only.
  test.runIf(process.platform === 'linux')(
    'early-break scans do not leak file descriptors',
    async () => {
      const log = join(dir, 'hooks', 'sess-fd.jsonl');
      const lines = [preToolBash('kb remember --kb=agent-task-lessons --title=x --stdin --yes')];
      for (let i = 0; i < 5000; i++) lines.push(preToolBash(`echo filler ${i}`));
      writeFileSync(log, lines.join('\n') + '\n', 'utf8');

      const countFds = (): number => readdirSync('/proc/self/fd').length;
      const before = countFds();
      for (let i = 0; i < 20; i++) {
        const stats = await scanHookLogForLessonDecision(log);
        expect(stats.lessonWrites).toBe(1);
      }
      // Let destroyed streams finish closing before counting — poll instead
      // of one fixed sleep so CI thread-pool contention cannot false-fail.
      let after = countFds();
      for (let i = 0; i < 40 && after - before > 1; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        after = countFds();
      }
      expect(after - before).toBeLessThanOrEqual(1);
    },
  );
});

describe('computeLessonYield', () => {
  let dir: string;
  const nowMs = Date.parse('2026-07-25T12:00:00.000Z');

  beforeEach(() => {
    dir = join(tmpdir(), `kookr-lesson-yield-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('computes yield rate over completed tasks in the window', async () => {
    writeFileSync(
      join(dir, 'hooks', 'done-write.jsonl'),
      preToolBash('kb remember --kb=agent-task-lessons --title=a --stdin --yes') + '\n',
    );
    writeFileSync(
      join(dir, 'hooks', 'done-skip.jsonl'),
      preToolBash(`echo '${KB_LESSON_SKIP_MARKER} already documented'`) + '\n',
    );
    writeFileSync(
      join(dir, 'hooks', 'done-none.jsonl'),
      preToolBash('ls -la') + '\n',
    );

    const tasks = [
      {
        id: '1',
        status: 'completed',
        updatedAt: '2026-07-25T10:00:00.000Z',
        sessions: [{ tmuxSession: 'done-write' }],
      },
      {
        id: '2',
        status: 'completed',
        updatedAt: '2026-07-25T11:00:00.000Z',
        sessions: [{ tmuxSession: 'done-skip' }],
      },
      {
        id: '3',
        status: 'completed',
        updatedAt: '2026-07-25T11:30:00.000Z',
        sessions: [{ tmuxSession: 'done-none' }],
      },
      {
        id: '4',
        status: 'inProgress',
        updatedAt: '2026-07-25T11:45:00.000Z',
        sessions: [{ tmuxSession: 'done-write' }],
      },
      {
        id: '5',
        status: 'completed',
        updatedAt: '2026-07-20T10:00:00.000Z', // outside 1-day window
        sessions: [{ tmuxSession: 'done-write' }],
      },
    ];

    const snap = await computeLessonYield(tasks, join(dir, 'hooks'), { days: 1, nowMs });
    expect(snap.schemaVersion).toBe(LESSON_YIELD_SCHEMA_VERSION);
    expect(snap.schemaVersion).toBe('lesson-yield.v2');
    expect(snap.windowDays).toBe(1);
    expect(snap.tasksInWindow).toBe(4); // excludes id 5
    expect(snap.completedInWindow).toBe(3); // excludes inProgress
    expect(snap.buckets.wroteLesson).toBe(1);
    expect(snap.buckets.explicitSkip).toBe(1);
    expect(snap.buckets.noKbActivity).toBe(1);
    expect(snap.decided).toBe(2);
    expect(snap.yieldRate).toBeCloseTo(2 / 3, 5);
    expect(snap.completedWithLogs).toBe(3);
    // Unstamped historical tasks land under `unknown`.
    expect(snap.byCompletionPath.unknown?.completed).toBe(3);
    expect(snap.byCompletionPath.unknown?.decided).toBe(2);
    expect(snap.byCompletionPath.unknown?.noKbActivity).toBe(1);
    expect(snap.explainedExceptions).toBe(0);
    expect(snap.contractRate).toBeCloseTo(2 / 3, 5);
  });

  test('yieldRate is 0 when no completed tasks', async () => {
    const snap = await computeLessonYield(
      [{ id: 'x', status: 'inProgress', updatedAt: '2026-07-25T11:00:00.000Z', sessions: [] }],
      join(dir, 'hooks'),
      { days: 1, nowMs },
    );
    expect(snap.completedInWindow).toBe(0);
    expect(snap.yieldRate).toBe(0);
    expect(snap.decided).toBe(0);
    expect(snap.contractRate).toBe(0);
    expect(snap.byCompletionPath).toEqual({});
  });

  test('v2 joins decision buckets onto completionPath + gateExempt (issue #1608)', async () => {
    writeFileSync(
      join(dir, 'hooks', 'path-write.jsonl'),
      preToolBash('kb remember --kb=agent-task-lessons --title=a --stdin --yes') + '\n',
    );
    writeFileSync(
      join(dir, 'hooks', 'path-none.jsonl'),
      preToolBash('ls') + '\n',
    );
    writeFileSync(
      join(dir, 'hooks', 'path-grok.jsonl'),
      preToolGrok(`echo '${KB_LESSON_SKIP_MARKER} tick'`) + '\n',
    );

    const tasks = [
      {
        id: 'n1',
        status: 'completed',
        updatedAt: '2026-07-25T10:00:00.000Z',
        sessions: [{ tmuxSession: 'path-write' }],
        completionPath: 'normal' as const,
      },
      {
        id: 'a1',
        status: 'completed',
        updatedAt: '2026-07-25T10:30:00.000Z',
        sessions: [{ tmuxSession: 'path-none' }],
        completionPath: 'api_complete' as const,
        lessonGateExempt: 'api_complete_ungated',
      },
      {
        id: 'o1',
        status: 'completed',
        updatedAt: '2026-07-25T11:00:00.000Z',
        sessions: [{ tmuxSession: 'path-grok' }],
        completionPath: 'outbox_drained' as const,
      },
    ];

    const snap = await computeLessonYield(tasks, join(dir, 'hooks'), { days: 1, nowMs });
    expect(snap.buckets.wroteLesson).toBe(1);
    expect(snap.buckets.explicitSkip).toBe(1);
    expect(snap.buckets.noKbActivity).toBe(1);
    expect(snap.decided).toBe(2);
    expect(snap.explainedExceptions).toBe(1);
    expect(snap.contractRate).toBeCloseTo(1, 5); // 2 decided + 1 explained / 3
    expect(snap.byCompletionPath.normal).toMatchObject({
      completed: 1,
      decided: 1,
      wroteLesson: 1,
    });
    expect(snap.byCompletionPath.api_complete).toMatchObject({
      completed: 1,
      decided: 0,
      noKbActivity: 1,
      gateExempt: 1,
    });
    expect(snap.byCompletionPath.outbox_drained).toMatchObject({
      completed: 1,
      decided: 1,
      explicitSkip: 1,
    });
    expect(snap.gateExemptReasons).toEqual({ api_complete_ungated: 1 });
  });
});
