import type { ClientMessage } from '../shared/contracts/messages.js';

/**
 * Tells the server whether a task's dashboard reply box holds unsent text, so
 * the server's background close paths leave a task alone while the operator
 * is writing to it (`composerDraft` message, read by the server's operator
 * draft registry).
 *
 * Sends only when the answer changes for a task, plus a periodic refresh while
 * the operator keeps typing: the server lets a draft go after an hour with no
 * report, so the refresh keeps an actively edited draft protected without
 * sending a message per keystroke.
 */

/** While a draft is being edited, re-report at most this often. */
export const COMPOSER_DRAFT_REFRESH_MS = 30_000;

export interface ComposerDraftReporter {
  /** Report the reply box content of `taskId` after a change. */
  report(taskId: string, text: string): void;
}

export function createComposerDraftReporter(
  send: (msg: ClientMessage) => boolean,
  opts: { refreshMs?: number; now?: () => number } = {},
): ComposerDraftReporter {
  const refreshMs = opts.refreshMs ?? COMPOSER_DRAFT_REFRESH_MS;
  const now = opts.now ?? Date.now;
  const last = new Map<string, { hasDraft: boolean; sentAt: number }>();

  return {
    report(taskId, text) {
      const hasDraft = text.trim().length > 0;
      const previous = last.get(taskId) ?? { hasDraft: false, sentAt: -Infinity };
      const at = now();
      const changed = previous.hasDraft !== hasDraft;
      const refreshDue = hasDraft && at - previous.sentAt >= refreshMs;
      if (!changed && !refreshDue) return;
      if (send({ type: 'composerDraft', taskId, hasDraft })) {
        last.set(taskId, { hasDraft, sentAt: at });
      }
    },
  };
}
