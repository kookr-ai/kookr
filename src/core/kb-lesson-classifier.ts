/**
 * Classify Bash hook lines for the post-task KB lesson decision (issue #227).
 *
 * The decision is logged via existing PreToolUse Bash hook entries — agents
 * either run `kb remember` (a lesson write) or print the marker
 * `No generic KB lesson: <reason>` (an explicit skip). Both forms appear in
 * `~/.kookr/hooks/<tmuxSession>.jsonl` alongside the existing `kb search`
 * traffic, so the kb-usage report can read them with no new infrastructure.
 *
 * Detection is deliberately permissive: the marker can appear in `echo`,
 * `printf`, heredocs, or chained shell — we only require the literal
 * substring. The same is true of `kb remember`, which agents sometimes pipe
 * stdin from `cat <<EOF`.
 */

export const KB_LESSON_SKIP_MARKER = 'No generic KB lesson:';

export type KbLineKind = 'lesson-write' | 'lesson-skip' | 'kb-search' | 'none';

export type LessonDecisionState =
  | 'wrote-lesson'
  | 'explicit-skip'
  | 'search-only'
  | 'no-kb-activity';

export function classifyKbCommand(command: string): KbLineKind {
  if (command.includes('kb remember')) return 'lesson-write';
  if (command.includes(KB_LESSON_SKIP_MARKER)) return 'lesson-skip';
  if (command.includes('kb ')) return 'kb-search';
  return 'none';
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
