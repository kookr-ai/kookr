import type { Task } from '../core/tasks.js';
import {
  isNonEmptyOperatorDraft,
  reduceOperatorDraft,
  type OperatorDraftInput,
} from '../shared/operator-draft.js';

/**
 * Per-session record of what the operator has typed into a task's terminal and
 * not submitted yet (see `shared/operator-draft.ts` for how the text is
 * rebuilt from raw input bytes).
 *
 * Why it exists: background close paths (the finishedAwaitingAck reapers, the
 * completion-ready and delivered sweeps, the terminal-verdict sweep) used to
 * force-complete a task whose agent was idle at its prompt while the operator
 * was writing the next prompt in that very prompt box. The agent is idle, the
 * pane looks idle, so every age-based selector picked it, and the half-written
 * prompt died with the session. `evaluateLiveWorkVeto` consults this registry
 * so that an unsent draft vetoes every one of those closes.
 *
 * The veto is "an unsent draft exists", not "a key was pressed in the last N
 * seconds": a human pausing ten minutes mid-prompt is still writing. It is
 * bounded by {@link OPERATOR_DRAFT_VETO_MAX_IDLE_MS} only so that a forgotten
 * draft cannot hold a concurrency slot forever.
 *
 * Keyed by terminal session id, which is the task session's `tmuxSession`.
 * In-memory: a server restart forgets drafts, and the next keystroke starts a
 * new one (still non-empty, so the veto comes back on the first key).
 */

/** A draft untouched for this long stops vetoing closes. */
export const OPERATOR_DRAFT_VETO_MAX_IDLE_MS = 60 * 60_000;

export interface OperatorDraftEntry {
  text: string;
  /** Epoch ms of the last input chunk that touched this session's draft. */
  lastInputAtMs: number;
}

export class OperatorDraftRegistry {
  private readonly drafts = new Map<string, OperatorDraftEntry>();

  constructor(private readonly maxIdleMs: number = OPERATOR_DRAFT_VETO_MAX_IDLE_MS) {}

  /** Apply one input chunk the operator sent to `sessionId`. */
  record(sessionId: string, input: OperatorDraftInput, nowMs: number = Date.now()): void {
    const previous = this.drafts.get(sessionId)?.text ?? '';
    const text = reduceOperatorDraft(previous, input);
    if (text.length === 0) {
      this.drafts.delete(sessionId);
      return;
    }
    this.drafts.set(sessionId, { text, lastInputAtMs: nowMs });
  }

  /** The session's current unsent draft, or undefined when there is none. */
  get(sessionId: string): OperatorDraftEntry | undefined {
    return this.drafts.get(sessionId);
  }

  /** Forget a session's draft (session ended, or the draft was delivered). */
  clear(sessionId: string): void {
    this.drafts.delete(sessionId);
  }

  /**
   * True when one of the task's live sessions holds a non-empty unsent draft
   * typed within the idle bound. Ended sessions are ignored: their input box is
   * gone, so their draft can no longer be lost by closing the task.
   */
  hasUnsentDraft(task: Pick<Task, 'sessions'>, nowMs: number = Date.now()): boolean {
    for (const session of task.sessions) {
      if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
      const entry = this.drafts.get(session.tmuxSession);
      if (!entry || !isNonEmptyOperatorDraft(entry.text)) continue;
      if (nowMs - entry.lastInputAtMs <= this.maxIdleMs) return true;
    }
    return false;
  }
}

/**
 * The process-wide registry. The terminal bridges record into it and
 * `evaluateLiveWorkVeto` reads it by default, so a close path that uses the
 * shared veto cannot forget to wire the draft signal.
 */
export const operatorDraftRegistry = new OperatorDraftRegistry();
