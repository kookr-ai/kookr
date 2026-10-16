import { describe, test, expect } from 'vitest';
import {
  classifyKbCommand,
  aggregateLessonDecision,
  isGenuineKbWriteOutput,
  KB_LESSON_SKIP_MARKER,
  KB_LESSON_WRITE_RECORDED_MARKER,
} from './kb-lesson-classifier.js';

describe('classifyKbCommand', () => {
  test('`kb remember` is only a write ATTEMPT — naked, piped, and chained forms (#1538)', () => {
    // The similarity guard can suppress a `kb remember` write, so the bare
    // command only signals intent; a real write is confirmed from its output.
    expect(classifyKbCommand('kb remember --kb=agent-task-lessons --title="x" --stdin --yes')).toBe(
      'lesson-write-attempt',
    );
    expect(
      classifyKbCommand('cat <<EOF | kb remember --kb=agent-task-lessons --stdin --yes\n...\nEOF'),
    ).toBe('lesson-write-attempt');
    expect(classifyKbCommand('cd /repo && kb remember --kb=agent-task-lessons --stdin --yes')).toBe(
      'lesson-write-attempt',
    );
  });

  test('`kookr lesson remember` is a confirmed write (it never similarity-suppresses)', () => {
    expect(
      classifyKbCommand('kookr lesson remember --title="x" --stdin --yes'),
    ).toBe('lesson-write');
  });

  test('detects the explicit-skip marker regardless of how it is printed', () => {
    expect(classifyKbCommand("echo 'No generic KB lesson: purely mechanical rename'")).toBe(
      'lesson-skip',
    );
    expect(classifyKbCommand("printf '%s\\n' 'No generic KB lesson: typo fix only'")).toBe(
      'lesson-skip',
    );
    expect(classifyKbCommand('cat <<EOF\nNo generic KB lesson: known one-command run\nEOF')).toBe(
      'lesson-skip',
    );
  });

  test('treats a `kb remember` attempt as stronger than the skip marker on the same line', () => {
    // If an agent both attempts a write and prints a skip note, the attempt
    // takes precedence in the command classification (its real outcome is then
    // confirmed from the PostToolUse output).
    expect(
      classifyKbCommand(
        "kb remember --kb=agent-task-lessons --stdin --yes && echo 'No generic KB lesson: ignore this'",
      ),
    ).toBe('lesson-write-attempt');
  });

  test('treats the skip marker as stronger than a `kb search` on the same line', () => {
    // The marker signals an explicit decision; a search is just lookup
    // activity. Pin the lesson-skip > kb-search precedence so a chained
    // command like `kb search foo && printf '...'` still records the
    // decision rather than collapsing to search-only.
    expect(
      classifyKbCommand("kb search 'gist' && printf 'No generic KB lesson: %s\\n' 'reason'"),
    ).toBe('lesson-skip');
  });

  test('search and list calls fall back to kb-search', () => {
    expect(classifyKbCommand('kb search "task gist"')).toBe('kb-search');
    expect(classifyKbCommand('kb list')).toBe('kb-search');
    expect(classifyKbCommand('kb --help')).toBe('kb-search');
  });

  test('unrelated commands return none', () => {
    expect(classifyKbCommand('git status')).toBe('none');
    expect(classifyKbCommand('pnpm test')).toBe('none');
    // The bare token "kb" with no trailing space is not a CLI invocation —
    // matches the existing kb-usage-report.ts detection rule.
    expect(classifyKbCommand('export PATH=/kbtools:$PATH')).toBe('none');
  });

  test('known false-positive: any string containing literal "kb " (e.g. an echo) classifies as kb-search', () => {
    // The existing kb-usage-report.ts pre-classifier check (cmd.includes("kb "))
    // accepts the same false-positive surface, so the classifier inherits it
    // for parity. Tighten with a regex anchored at word boundary if drift
    // becomes a real signal-quality problem; until then this is documented
    // as known-and-acceptable, not silently encoded.
    expect(classifyKbCommand('echo "kb is great" # not a real call')).toBe('kb-search');
  });

  test('marker constant is exported for prompt/playbook consumers', () => {
    expect(KB_LESSON_SKIP_MARKER).toBe('No generic KB lesson:');
  });
});

describe('isGenuineKbWriteOutput', () => {
  test('confirms a write from the real kb write_performed:true envelope', () => {
    expect(isGenuineKbWriteOutput('{\n  "action": "create",\n  "write_performed": true\n}')).toBe(true);
    // Compact JSON too.
    expect(isGenuineKbWriteOutput('{"write_performed":true}')).toBe(true);
  });

  test('confirms a write from the shim recorded marker (covers the spool path)', () => {
    expect(isGenuineKbWriteOutput(`provider down\n${KB_LESSON_WRITE_RECORDED_MARKER} (durable spool abc…)`)).toBe(
      true,
    );
  });

  test('rejects a similarity-suppressed attempt (write_performed:false, no marker)', () => {
    expect(
      isGenuineKbWriteOutput(
        '{\n  "action": "similarity-check",\n  "write_performed": false,\n  "decision_hint": {}\n}',
      ),
    ).toBe(false);
  });

  test('rejects empty or unrelated output', () => {
    expect(isGenuineKbWriteOutput('')).toBe(false);
    expect(isGenuineKbWriteOutput('some unrelated stdout')).toBe(false);
  });
});

describe('aggregateLessonDecision', () => {
  test('any lesson write wins regardless of other activity', () => {
    expect(
      aggregateLessonDecision({ lessonWrites: 1, lessonSkips: 0, kbSearches: 0 }),
    ).toBe('wrote-lesson');
    expect(
      aggregateLessonDecision({ lessonWrites: 1, lessonSkips: 3, kbSearches: 5 }),
    ).toBe('wrote-lesson');
  });

  test('explicit skip is recorded when no write happened, even alongside searches', () => {
    expect(
      aggregateLessonDecision({ lessonWrites: 0, lessonSkips: 1, kbSearches: 0 }),
    ).toBe('explicit-skip');
    expect(
      aggregateLessonDecision({ lessonWrites: 0, lessonSkips: 1, kbSearches: 4 }),
    ).toBe('explicit-skip');
  });

  test('search-only when only `kb search`/`kb list` traffic appeared', () => {
    expect(
      aggregateLessonDecision({ lessonWrites: 0, lessonSkips: 0, kbSearches: 2 }),
    ).toBe('search-only');
  });

  test('no-kb-activity when nothing was logged', () => {
    expect(
      aggregateLessonDecision({ lessonWrites: 0, lessonSkips: 0, kbSearches: 0 }),
    ).toBe('no-kb-activity');
  });
});
