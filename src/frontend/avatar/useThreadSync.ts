/**
 * Records what Lucy and the operator say into the conversation thread (`store/lucy-conversation.ts`).
 *
 * Typed requests write their own entries (`LucyTypedInput.tsx`). What is recorded here is what the thread
 * would otherwise lose, because the sources only know the present moment:
 *  - a hands-free Talk exchange: the Talk session shows only the latest transcript and the answer so far,
 *    and clears them when the next one begins, so each exchange is copied into the thread as it forms;
 *  - the spoken messages (task summaries, questions, permission notices): the clip history keeps only the
 *    last few with their audio, so each one's text is copied into the thread when it arrives. A sentence
 *    she wrote into the thread first (the report of a task she started) gets its clip attached instead;
 *  - connection and "unavailable" notices from Talk.
 *
 * Her read-back of a launch card that is on screen is the one thing not copied: the card says it.
 *
 * These hooks run in `AvatarDock`, which stays mounted while the panel is minimised, so what is said while
 * the operator is not looking is still in the thread when they open it. They read the Talk session; they
 * never change it.
 */
import { useEffect, useRef } from 'react';
import type { ClipHistoryItem } from '../audio/last-clip.js';
import {
  appendConversationEntry,
  getConversationEntries,
  removeConversationEntries,
  updateConversationEntry,
} from '../store/lucy-conversation.js';
import { isLaunchReadBack } from '../store/lucy-launch.js';

/** How far back from the end of the thread a written message is looked for when its spoken clip arrives. */
const RECENT_ENTRIES = 20;

export interface TalkThreadInput {
  /** Hands-free is switched on. */
  enabled: boolean;
  /** The operator's latest transcript, and whether it can still change. */
  operatorText: string;
  operatorFinal: boolean;
  /** The sentences of Lucy's current answer received so far. */
  lucyText: string;
}

interface OpenEntry {
  id: string;
  text: string;
}
interface OpenOperatorEntry extends OpenEntry {
  final: boolean;
}

/** Copy each Talk exchange into the thread: the operator's words (the draft, then the final) and Lucy's answer. */
export function useTalkThreadSync({ enabled, operatorText, operatorFinal, lucyText }: TalkThreadInput): void {
  const operatorEntry = useRef<OpenOperatorEntry | null>(null);
  const lucyEntry = useRef<OpenEntry | null>(null);

  useEffect(() => {
    const open = operatorEntry.current;
    if (!enabled) {
      // Talk was switched off: a draft that never became final has nothing left to finish it.
      if (open && !open.final) removeConversationEntries([open.id]);
      operatorEntry.current = null;
      return;
    }
    if (!operatorText) {
      // The session clears the text when the operator stops speaking, before the final transcript arrives:
      // a draft stays open to receive it. A final one is closed, so the next utterance is a new entry.
      if (open?.final) operatorEntry.current = null;
      return;
    }
    if (open && !open.final) {
      // The same utterance, growing or becoming final.
      if (open.text !== operatorText || operatorFinal) {
        updateConversationEntry(open.id, { text: operatorText, final: operatorFinal });
        open.text = operatorText;
        open.final = operatorFinal;
      }
      return;
    }
    if (open && open.final && open.text === operatorText && operatorFinal) return;
    // Nothing is open, or the open one is finished and this is something new.
    const id = appendConversationEntry({ kind: 'talk-you', text: operatorText, final: operatorFinal });
    operatorEntry.current = { id, text: operatorText, final: operatorFinal };
  }, [enabled, operatorText, operatorFinal]);

  useEffect(() => {
    if (!enabled || !lucyText) {
      lucyEntry.current = null;
      return;
    }
    const open = lucyEntry.current;
    // Her read-back of the launch card on screen repeats the card: it gets no bubble of its own.
    if (!open && isLaunchReadBack(lucyText, { partial: true })) return;
    // Her answer grows by whole sentences. Text that does not continue the open one is a new answer, even when the
    // empty text between the two was never seen (renders can be batched).
    if (open && lucyText.startsWith(open.text)) {
      if (lucyText !== open.text) {
        updateConversationEntry(open.id, { text: lucyText });
        open.text = lucyText;
      }
      return;
    }
    const id = appendConversationEntry({ kind: 'talk-lucy', text: lucyText });
    lucyEntry.current = { id, text: lucyText };
  }, [enabled, lucyText]);
}

/**
 * Add each spoken message to the thread once, when it first appears in the clip history. A message that later
 * falls out of the history (it keeps only the last few, with their audio) stays in the thread as text.
 * `clips` is newest first, as the clip history gives it.
 *
 * A sentence she wrote into the thread first and says aloud second (the report of a task she started) is one
 * message: the clip is attached to the written entry, which gains Replay and the unheard marker.
 */
export function useClipThreadSync(clips: readonly ClipHistoryItem[]): void {
  useEffect(() => {
    if (clips.length === 0) return;
    const known = new Set<string>();
    for (const entry of getConversationEntries()) if ((entry.kind === 'clip' || entry.kind === 'lucy') && entry.clipId) known.add(entry.clipId);
    for (const clip of [...clips].reverse()) {
      if (known.has(clip.clipId)) continue;
      const written = getConversationEntries().slice(-RECENT_ENTRIES)
        .find((entry) => entry.kind === 'lucy' && !entry.clipId && entry.text.trim() === clip.text.trim());
      if (written) {
        updateConversationEntry(written.id, {
          clipId: clip.clipId,
          ...(clip.subject ? { subject: clip.subject } : {}),
          ...(clip.usedFallback ? { usedFallback: true } : {}),
        });
        continue;
      }
      appendConversationEntry({
        kind: 'clip',
        clipId: clip.clipId,
        text: clip.text,
        ...(clip.subject ? { subject: clip.subject } : {}),
        ...(clip.usedFallback ? { usedFallback: true } : {}),
        at: clip.at,
      });
    }
  }, [clips]);
}

/**
 * Add a Talk notice (the reason Talk is unavailable, a connection problem) to the thread when it appears. The same
 * words twice in a row are one entry: pressing an unavailable Talk button again does not repeat them.
 */
export function useNoticeThreadSync(notice: string | null, pressCount: number): void {
  useEffect(() => {
    if (!notice) return;
    const entries = getConversationEntries();
    const last = entries[entries.length - 1];
    if (last?.kind === 'notice' && last.text === notice) return;
    appendConversationEntry({ kind: 'notice', text: notice });
    // `pressCount` is a dependency so a press that repeats the notice after other things were said adds it again.
  }, [notice, pressCount]);
}
