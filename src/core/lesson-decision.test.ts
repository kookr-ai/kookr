import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeLessonYield,
  evaluateLessonDecisionGate,
  isLessonDecisionGateEnabled,
  isLessonDecisionSatisfied,
  LESSON_DECISION_GATE_ENV,
  LESSON_DECISION_REQUIRED_CODE,
  resolveTaskLessonDecision,
  scanHookLogForLessonDecision,
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

  test('rejects no-kb-activity', () => {
    const v = evaluateLessonDecisionGate({
      sessionsScanned: 2,
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
    expect(snap.windowDays).toBe(1);
    expect(snap.tasksInWindow).toBe(4); // excludes id 5
    expect(snap.completedInWindow).toBe(3); // excludes inProgress
    expect(snap.buckets.wroteLesson).toBe(1);
    expect(snap.buckets.explicitSkip).toBe(1);
    expect(snap.buckets.noKbActivity).toBe(1);
    expect(snap.decided).toBe(2);
    expect(snap.yieldRate).toBeCloseTo(2 / 3, 5);
    expect(snap.completedWithLogs).toBe(3);
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
  });
});
