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
 *
 * With Talk on, a question is handed to the hands-free conversation and no clip is asked for. If the
 * conversation gives it back unsaid (issue #4015), it is played as a clip after all, later; the same
 * rule is applied to how that clip ends, so a question whose late clip could not be fetched is written
 * too. Her words in the conversation and that clip cannot both be in the thread: the conversation
 * shows a question's words only once she has begun to say it, and from then on it is never given back.
 */
import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { LucyPermissionAnnouncement, LucyPermissionCardView } from '../../shared/contracts/lucy-permission.js';
import type { AskAnnouncementResult } from '../audio/ask-announcement.js';
import { appendConversationEntry } from '../store/lucy-conversation.js';

/** A written question longer than this is cut; the card shows all of it. */
const MAX_WRITTEN_QUESTION_CHARS = 300;

/** What is written in the thread in place of a clip. */
export interface WrittenWords {
  /**
   * The thread entry's id, derived from the question or the notice. Every open tab that fails to
   * fetch the clip builds the same one, so a thread shared between tabs gets the words once.
   */
  id: string;
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
  return { id: `ask-text:${ask.id}`, text: `${ask.taskName ?? 'A task'} asks: ${question}`, taskId: ask.taskId };
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
  return { id: `permission-text:${announcement.noticeId}`, text, ...(announcement.promptIds.length === 1 ? { taskId: open[0]!.taskId } : {}) };
}

/** What {@link announceOrWrite} hands the announcement function; `announceAsk` and `announcePermissionNotice` accept it as it is. */
export interface AnnounceOrWriteOptions {
  fetcher: typeof fetch;
  onGivenBack: (result: Promise<AskAnnouncementResult>) => void;
}

/**
 * Run an announcement (`announceAsk`, `announcePermissionNotice`); when it ends in `'error'` and no
 * clip was fetched, write `written()` into the thread as a message from Lucy. `written` is called
 * only then, so it sees the state at that moment and can decline with null. Words whose id is
 * already in the thread are not written again. The same is done when a question the hands-free
 * conversation took is given back and its late clip ends in `'error'` unfetched. Never throws.
 */
export async function announceOrWrite(
  announce: (options: AnnounceOrWriteOptions) => Promise<AskAnnouncementResult>,
  written: () => WrittenWords | null,
): Promise<AskAnnouncementResult> {
  let clipFetched = false;
  // Global `fetch` is looked up when the request is made, not when this file loads: tests replace it.
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) clipFetched = true;
    return response;
  };
  const writeIfUnspoken = (result: AskAnnouncementResult): void => {
    if (result !== 'error' || clipFetched) return;
    try {
      const words = written();
      if (words) appendConversationEntry({ id: words.id, kind: 'typed-lucy', status: 'done', text: words.text, ...(words.taskId ? { taskId: words.taskId } : {}) });
    } catch {
      // Writing is a courtesy: a failure here must not surface as an unhandled rejection.
    }
  };
  const onGivenBack = (later: Promise<AskAnnouncementResult>): void => {
    void later.then(writeIfUnspoken, () => writeIfUnspoken('error'));
  };
  let result: AskAnnouncementResult;
  try {
    result = await announce({ fetcher, onGivenBack });
  } catch {
    result = 'error';
  }
  writeIfUnspoken(result);
  return result;
}
