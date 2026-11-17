/**
 * What Lucy says on her own is written even when it cannot be spoken.
 *
 * A question from a task and a permission notice reach the thread through their clip: the clip is
 * fetched, and `useClipThreadSync` copies its text. When no clip can be fetched (the speech service
 * is not configured, or it failed, or the server could not be reached) there was nothing to copy,
 * and her words appeared nowhere. {@link announceOrWrite} closes that gap: it runs the announcement
 * and, when the result is `'error'` and no clip was fetched, writes a message from her built from
 * what the browser already has.
 *
 * It writes nothing when a clip was fetched, whatever happened next (sound off, Do Not Disturb,
 * audio blocked by the browser, or a clip that failed to play): that clip is in her message list
 * and its text is already in the thread, so a second entry would say the same thing twice. Whether
 * a clip was fetched is seen through the `fetcher` the announcement functions accept.
 */
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { AskAnnouncementResult } from '../audio/ask-announcement.js';
import { appendConversationEntry } from '../store/lucy-conversation.js';

/** A written question longer than this is cut; the card shows all of it. */
const MAX_WRITTEN_QUESTION_CHARS = 300;

/** What is written in the thread in place of a clip. */
export interface WrittenWords {
  text: string;
  /** The task the words are about, so the thread can offer to open it. */
  taskId?: string;
}

/**
 * "Billing migration asks: <question>", for a question whose clip could not be fetched. Null when the
 * question is no longer waiting (`asks` is the current list): a closed question is not announced late.
 */
export function writtenAsk(ask: OperatorAskView, asks: readonly OperatorAskView[]): WrittenWords | null {
  if (!asks.some((current) => current.id === ask.id && current.state === 'pending')) return null;
  const flat = ask.question.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const question = flat.length > MAX_WRITTEN_QUESTION_CHARS ? `${flat.slice(0, MAX_WRITTEN_QUESTION_CHARS - 1).trimEnd()}…` : flat;
  return { text: `${ask.taskName ?? 'A task'} asks: ${question}`, taskId: ask.taskId };
}

/**
 * The server's own sentence for a permission notice whose clip could not be fetched. Null when the
 * announcement carries no sentence (an older server) or every prompt it is about has been answered
 * (`cards` is the current list).
 */
export function writtenPermissionNotice(announcement: LucyPermissionAnnouncement, cards: readonly LucyPermissionCardView[]): WrittenWords | null {
  const text = announcement.text?.trim();
  if (!text) return null;
  const open = cards.filter((card) => announcement.promptIds.includes(card.promptId));
  if (open.length === 0) return null;
  // A sentence about one prompt is about one task; a grouped sentence is about several and points at none.
  return { text, ...(announcement.promptIds.length === 1 ? { taskId: open[0]!.taskId } : {}) };
}

/**
 * Run an announcement (`announceAsk`, `announcePermissionNotice`); when it ends in `'error'` and no
 * clip was fetched, write `written()` into the thread as a message from Lucy. `written` is called
 * only then, so it sees the state at that moment and can decline with null. Never throws.
 */
export async function announceOrWrite(
  announce: (options: { fetcher: typeof fetch }) => Promise<AskAnnouncementResult>,
  written: () => WrittenWords | null,
): Promise<AskAnnouncementResult> {
  let clipFetched = false;
  // Global `fetch` is looked up when the request is made, not when this file loads: tests replace it.
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) clipFetched = true;
    return response;
  };
  let result: AskAnnouncementResult;
  try {
    result = await announce({ fetcher });
  } catch {
    result = 'error';
  }
  if (result !== 'error' || clipFetched) return result;
  try {
    const words = written();
    if (words) appendConversationEntry({ kind: 'typed-lucy', status: 'done', text: words.text, ...(words.taskId ? { taskId: words.taskId } : {}) });
  } catch {
    // Writing is a courtesy: a failure here must not surface as an unhandled rejection.
  }
  return result;
}
