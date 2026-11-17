/**
 * The conversation thread in Lucy's column: one scrolling list, oldest at the top and newest at the bottom,
 * that replaces what used to be three separate areas (the typed reply box, the Talk box and the list of
 * spoken messages).
 *
 * Its entries come from `store/lucy-conversation.ts`:
 *  - what the operator typed and Lucy's reply to it (an error shows in the reply's place; "Thinking…" until
 *    her first words arrive);
 *  - what was said in a hands-free Talk exchange, the operator's draft included while it is still changing;
 *  - notices about Talk (it is unavailable, the connection broke);
 *  - the messages she said aloud (task summaries, questions, permission notices), marked as said aloud, with
 *    their subject, how long ago, "template" and "unheard" markers and their own Replay button. A message whose
 *    audio has been dropped (only the last few are kept) stays as text, without Replay or an unheard marker.
 *
 * The list scrolls to the newest entry as it arrives, unless the operator scrolled up to read: then it stays
 * where it is and a "New message" button appears at the bottom to jump down. It is a log that is not live
 * (`aria-live="off"`): Lucy's answers are spoken aloud already, and a screen reader reading them as well would
 * be a second voice over hers. What a screen reader is told comes from the always-present status regions of the
 * dock and of the composer. The scroll region can be focused, so the keyboard can read a long entry.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ClipHistoryItem } from '../audio/last-clip.js';
import type { ConversationEntry } from '../store/lucy-conversation.js';
import { formatRelativeTime } from './relative-time.js';

const NAME = 'Lucy';
const IDLE_HINT = 'Press a speaker button on a task and I will read its summary to you.';
const LIVE_HINT = 'Talk to me — I’m listening.';
/** Nearer than this to the bottom counts as "at the bottom", so a pixel of rounding does not hide new messages. */
const AT_BOTTOM_SLACK_PX = 24;

export interface LucyThreadProps {
  entries: readonly ConversationEntry[];
  /** The clips whose audio is still kept: only these can be replayed and only these know whether they were heard. */
  clips: readonly ClipHistoryItem[];
  nowMs: number;
  /** Hands-free is connected: the empty thread says so. */
  liveReady: boolean;
  /** Hands-free is connecting. */
  connecting: boolean;
  /** Why Replay is unavailable right now, or null; the per-message buttons point at it. */
  replayUnavailable: string | null;
  /** The id of the hidden text that carries `replayUnavailable`. */
  replayReasonId: string;
  onReplay: (clipId: string) => void;
}

function Who({ children }: { children: string }) {
  return <span className="avatar-live-who">{children}</span>;
}

export function LucyThread({ entries, clips, nowMs, liveReady, connecting, replayUnavailable, replayReasonId, onReplay }: LucyThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const lastIdRef = useRef<string | null>(null);
  const [newBelow, setNewBelow] = useState(false);

  // Follow the newest entry, and the growth of the one still arriving, while the operator is at the bottom.
  // Scrolled up, the list stays put and says there is something new.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const lastId = entries[entries.length - 1]?.id ?? null;
    const added = lastId !== null && lastId !== lastIdRef.current;
    lastIdRef.current = lastId;
    if (atBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      setNewBelow(false);
    } else if (added) {
      setNewBelow(true);
    }
  }, [entries, connecting]);

  const onScroll = (): void => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    atBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_SLACK_PX;
    if (atBottomRef.current) setNewBelow(false);
  };

  const jumpToNewest = (): void => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    atBottomRef.current = true;
    setNewBelow(false);
    // The button is gone now; keep keyboard focus in the thread instead of letting it fall to the page.
    scroller.focus();
  };

  const clipsById = new Map(clips.map((clip) => [clip.clipId, clip]));
  const anyReplayable = entries.some((entry) => entry.kind === 'clip' && clipsById.has(entry.clipId));

  const renderEntry = (entry: ConversationEntry) => {
    switch (entry.kind) {
      case 'typed-you':
        return (
          <li key={entry.id} className="avatar-entry avatar-entry-you" data-testid="avatar-typed-you">
            <Who>You</Who> {entry.text}
          </li>
        );
      case 'typed-lucy':
        return entry.status === 'error' ? (
          <li key={entry.id} className="avatar-entry avatar-entry-error" data-testid="avatar-typed-error">
            <Who>{NAME}</Who> {entry.text}
          </li>
        ) : (
          <li key={entry.id} className="avatar-entry avatar-entry-lucy" data-testid="avatar-typed-reply">
            <Who>{NAME}</Who> {entry.text || 'Thinking…'}
          </li>
        );
      case 'talk-you':
        return (
          <li
            key={entry.id}
            className={`avatar-entry avatar-entry-you${entry.final ? '' : ' avatar-live-draft'}`}
            data-testid="avatar-live-you"
            data-final={entry.final ? 'true' : 'false'}
          >
            <Who>You</Who> {entry.text}
          </li>
        );
      case 'talk-lucy':
        return (
          <li key={entry.id} className="avatar-entry avatar-entry-lucy" data-testid="avatar-live-lucy">
            <Who>{NAME}</Who> {entry.text}
          </li>
        );
      case 'notice':
        return (
          <li key={entry.id} className="avatar-entry avatar-live-notice" data-testid="avatar-live-notice">
            {entry.text}
          </li>
        );
      case 'clip': {
        const kept = clipsById.get(entry.clipId);
        const time = formatRelativeTime(entry.at, nowMs);
        const replayName = entry.subject ? `Replay message about ${entry.subject}, ${time}` : `Replay message, ${time}`;
        return (
          <li
            key={entry.id}
            className={`avatar-msg${kept ? '' : ' avatar-msg-text-only'}`}
            data-testid="avatar-message"
            data-clip-id={entry.clipId}
          >
            <p className="avatar-msg-text">{entry.text}</p>
            <div className="avatar-msg-meta">
              <span className="avatar-msg-aloud" data-testid="avatar-msg-aloud">said aloud</span>
              <span className="avatar-msg-sep" aria-hidden="true">·</span>
              {entry.subject && (
                <>
                  <span className="avatar-msg-subject">{entry.subject}</span>
                  <span className="avatar-msg-sep" aria-hidden="true">·</span>
                </>
              )}
              <span className="avatar-msg-time">{time}</span>
              {entry.usedFallback && (
                // Template wording, not a model summary (issue #3631): say so, or it reads as Lucy's own words.
                // The tooltip reaches only mouse users, so a screen reader hears the full phrase instead of the bare word (issue #3859).
                <span
                  className="avatar-msg-template"
                  data-testid="avatar-msg-template"
                  title="Template wording: the summary model was not used for this message"
                >
                  <span aria-hidden="true">template</span>
                  <span className="sr-only">template wording, not a model summary</span>
                </span>
              )}
              {kept && !kept.heard && (
                <span className="avatar-msg-unheard" data-testid="avatar-msg-unheard">
                  <span className="avatar-mark-dot" aria-hidden="true" />
                  unheard
                </span>
              )}
            </div>
            {kept && (
              <button
                type="button"
                className="avatar-dock-button avatar-msg-replay"
                onClick={() => onReplay(entry.clipId)}
                // Same pattern as the header button: aria-disabled keeps it focusable, so focus stays here after a press.
                aria-disabled={replayUnavailable ? 'true' : undefined}
                aria-label={replayName}
                aria-describedby={replayUnavailable ? replayReasonId : undefined}
                title={replayUnavailable ?? replayName}
                data-testid="avatar-msg-replay"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" /><path d="M7 6v4l3-2z" /></svg>
              </button>
            )}
          </li>
        );
      }
    }
  };

  return (
    <div className="avatar-thread" data-testid="avatar-thread-wrap">
      {/* A log, but not a live one: Lucy's answers are spoken aloud already, so they are not announced.
          Focusable because it scrolls. */}
      <div
        className="avatar-thread-scroll"
        role="log"
        aria-live="off"
        aria-label={`Conversation with ${NAME}`}
        tabIndex={0}
        ref={scrollRef}
        onScroll={onScroll}
        data-testid="avatar-thread"
      >
        {replayUnavailable && anyReplayable && <span id={replayReasonId} className="sr-only">{replayUnavailable}</span>}
        {entries.length === 0 ? (
          <p className="avatar-dock-hint" data-testid="avatar-hint">{liveReady ? LIVE_HINT : IDLE_HINT}</p>
        ) : (
          <ol className="avatar-thread-list" role="list" data-testid="avatar-messages">
            {entries.map(renderEntry)}
          </ol>
        )}
        {connecting && <p className="avatar-live-notice avatar-thread-connecting">Connecting&hellip;</p>}
      </div>
      {newBelow && (
        <button type="button" className="avatar-thread-new" onClick={jumpToNewest} data-testid="avatar-thread-new">
          New message
        </button>
      )}
    </div>
  );
}
