/**
 * Classify Bash hook lines for the post-task KB lesson decision (issue #227).
 *
 * The decision is logged via existing Bash hook entries — agents either run
 * `kb remember` (a lesson write) or print the marker
 * `No generic KB lesson: <reason>` (an explicit skip). Both forms appear in
 * `~/.kookr/hooks/<tmuxSession>.jsonl` alongside the existing `kb search`
 * traffic, so the kb-usage report and the #1538 completion-ready gate can read
 * them with no new infrastructure.
 *
 * Intent vs. outcome (issue #1538 loophole fix). A `kb remember` *command* in
 * the PreToolUse trail only records that the agent *tried* to write a lesson.
 * The real `kb` tool has a similarity guard that silently suppresses the write
 * when a near-duplicate chunk already exists — it returns
 * `"write_performed": false` and a non-zero exit, storing nothing. The gate
 * must not count that suppressed attempt as a decision. So `kb remember` is
 * classified as a {@link KbLineKind} `lesson-write-attempt`, and a genuine
 * write is only confirmed from the command's PostToolUse *output* via
 * {@link isGenuineKbWriteOutput}. `kookr lesson remember` is different: it
 * always runs with `--no-check-similar` and falls back to the durable spool on
 * failure, so it never suppresses — it counts as a confirmed `lesson-write`
 * from the command alone.
 *
 * Detection is deliberately permissive: the marker can appear in `echo`,
 * `printf`, heredocs, or chained shell — we only require the literal
 * substring. The same is true of the remember commands, which agents sometimes
 * pipe stdin from `cat <<EOF`; only when a command holds BOTH the marker and a
 * remember mention does it matter whether the remember call actually runs
 * (issue #4134, see {@link classifyKbCommand}).
 */

export const KB_LESSON_SKIP_MARKER = 'No generic KB lesson:';

/**
 * Marker the Kookr `kb` shim (`bin/kb` → `wrapLessonRemember`) prints to stdout
 * when a lesson write genuinely landed — either the real `kb` reported
 * `write_performed: true`, or a runtime failure was captured to the durable
 * spool for replay. The gate keys on this (plus the raw `write_performed: true`
 * envelope field) so it confirms an outcome instead of guessing from the mere
 * invocation. Printed on the command's stdout, it travels into the PostToolUse
 * `tool_response` the hook-log scanner reads.
 */
export const KB_LESSON_WRITE_RECORDED_MARKER = 'KOOKR_LESSON_WRITE: recorded';

/**
 * Marker the shim prints when a lesson remember stored nothing (similarity
 * guard suppressed it, lesson-body validation failed, or a caller/argv error).
 * Purely advisory for the agent; the gate treats the *absence* of a genuine
 * write as "not recorded", so this marker is not itself load-bearing.
 */
export const KB_LESSON_WRITE_NOT_RECORDED_MARKER = 'KOOKR_LESSON_WRITE: not-recorded';

export type KbLineKind =
  | 'lesson-write'
  | 'lesson-write-attempt'
  | 'lesson-skip'
  | 'kb-search'
  | 'none';

export type LessonDecisionState =
  | 'wrote-lesson'
  | 'explicit-skip'
  | 'search-only'
  | 'no-kb-activity';

/**
 * A remember call in COMMAND position: at the start of the command or right
 * after a shell operator (`|`, `&`, `;`, newline, `$(`, backtick), with an
 * optional path prefix (`~/bin/kb remember`). Text inside a skip line's reason
 * (`'… (kb remember --force)'`, `'… via kb remember'`) is not in command
 * position, so it does not turn the skip into a write (issue #4134).
 */
const KB_REMEMBER_INVOCATION_RE = /(?:^|[|&;\n`]|\$\()\s*(?:[\w.~/-]*\/)?kb\s+remember\b/;
const KOOKR_LESSON_REMEMBER_INVOCATION_RE =
  /(?:^|[|&;\n`]|\$\()\s*(?:[\w.~/-]*\/)?kookr\s+lesson\s+remember\b/;

/**
 * Classify one shell command for the lesson decision.
 *
 * Skip vs. write, when a command holds the skip marker (issue #4134): it is a
 * write (attempt) only when a remember call actually RUNS in it — in command
 * position, see {@link KB_REMEMBER_INVOCATION_RE}. So a skip line whose reason
 * mentions `kb remember` stays a skip, while a write whose lesson body quotes
 * the marker stays a write attempt wherever the body sits (`cat <<EOF | kb
 * remember`, `printf '…marker…' | kb remember`, `cat f | kb remember`). A
 * suppressed write can therefore not pass as a skip. Without the marker the
 * substring rules below apply unchanged.
 * Known limit: a remember call behind a wrapper (`timeout 60 kb remember`) in
 * a command that also prints the marker is read as a skip.
 */
export function classifyKbCommand(command: string): KbLineKind {
  const hasSkipMarker = command.includes(KB_LESSON_SKIP_MARKER);
  // `kookr lesson remember` is the spool-aware operator CLI (#1519). It writes
  // with `--no-check-similar` and spools on failure, so it never gets
  // similarity-suppressed — a confirmed lesson write from the command alone.
  if (
    hasSkipMarker
      ? KOOKR_LESSON_REMEMBER_INVOCATION_RE.test(command)
      : command.includes('kookr lesson remember')
  ) {
    return 'lesson-write';
  }
  // `kb remember` MAY be suppressed by the similarity guard (storing nothing),
  // so the bare command is only an *attempt* until its output confirms a real
  // write. See isGenuineKbWriteOutput + the #1538 gate scanner.
  if (
    hasSkipMarker ? KB_REMEMBER_INVOCATION_RE.test(command) : command.includes('kb remember')
  ) {
    return 'lesson-write-attempt';
  }
  if (hasSkipMarker) return 'lesson-skip';
  if (command.includes('kb ')) return 'kb-search';
  return 'none';
}

/**
 * Whether a `kb remember` command's PostToolUse output confirms a genuine
 * lesson write. Keys off two stable signals, not a stdout heuristic:
 *
 *  - the shim's {@link KB_LESSON_WRITE_RECORDED_MARKER} (also covers the
 *    runtime-failure-then-spooled case, where no `write_performed:true`
 *    envelope exists but the lesson is durably captured), or
 *  - the real `kb` tool's `"write_performed": true` envelope field.
 *
 * A similarity-suppressed or validation-failed attempt emits
 * `"write_performed": false` with neither marker, so it returns false — closing
 * the #1538 loophole where a suppressed write still satisfied the gate.
 */
export function isGenuineKbWriteOutput(output: string): boolean {
  if (!output) return false;
  if (output.includes(KB_LESSON_WRITE_RECORDED_MARKER)) return true;
  // Tolerate pretty-printed (`"write_performed": true`) and compact
  // (`"write_performed":true`) JSON alike.
  return /"write_performed"\s*:\s*true/.test(output);
}

export interface LessonDecisionCounts {
  lessonWrites: number;
  lessonSkips: number;
  kbSearches: number;
}

export function aggregateLessonDecision(
  counts: LessonDecisionCounts,
): LessonDecisionState {
  if (counts.lessonWrites > 0) return 'wrote-lesson';
  if (counts.lessonSkips > 0) return 'explicit-skip';
  if (counts.kbSearches > 0) return 'search-only';
  return 'no-kb-activity';
}
