/**
 * The conversation thread in Lucy's column: one scrolling chat, oldest at the top and newest at the bottom.
 *
 * Its entries come from `store/lucy-conversation.ts`, and it reads like a chat: the operator's words are
 * bubbles on the right, Lucy's are bubbles on the left, each with the time it was said (entries from the same
 * speaker within a minute share one time). A screen reader hears who speaks before each bubble.
 *  - what the operator typed and Lucy's reply to it. Until her first words arrive a quiet line says what she
 *    is doing ("Reading the board…"); once she answers it shrinks to "Looked at 3 things". An error shows in
 *    the reply's place. Lines of a reply that start with "- " or "• " are shown as a short list;
 *  - what was said in a hands-free Talk exchange, the operator's draft included while it is still changing;
 *  - messages she wrote on her own (a briefing, the report of a task she started), with an "Open task" button
 *    when they are about a task, and what became of a launch she proposed ("Started kookr task");
 *  - notices about Talk (it is unavailable, the connection broke);
 *  - the messages she said aloud (task summaries, questions, permission notices), marked as said aloud, with
 *    their subject, how long ago, "template" and "unheard" markers and their own Replay button. A message whose
 *    audio has been dropped (only the last few are kept) stays as text, without Replay or an unheard marker.
 *
 * The newest entry of hers may offer suggestion buttons (`chips`): pressing one sends that sentence as a typed
 * request. An empty thread shows a short welcome from her with three such buttons.
 *
 * `pendingCards` is whatever is waiting for the operator's decision right now (the launch card). It is shown
 * after the last entry, inside the scrolling area, and brought into view when it appears.
 *
 * The list stays on the newest entry as it arrives and grows, unless the operator scrolled up to read: then it
 * stays where it is and a "New message" button appears at the bottom to jump down. It is a log that is not live
 * (`aria-live="off"`): Lucy's answers are spoken aloud already, and a screen reader reading them as well would
 * be a second voice over hers. What a screen reader is told comes from the always-present status regions of the
 * dock and of the composer. The scroll region can be focused, so the keyboard can read a long entry.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClipHistoryItem } from '../audio/last-clip.js';
import type { ConversationEntry } from '../store/lucy-conversation.js';
import { openLucyTask } from './LucyLaunchCard.js';
import { announceInComposer, lookedAtText, sendLucyTypedText, useLucyTyped } from './LucyTypedInput.js';
import { formatRelativeTime } from './relative-time.js';

const NAME = 'Lucy';
export const WELCOME_TEXT = 'Hi, I’m Lucy. Ask me what is going on with your tasks, or tell me what to do.';
const LIVE_HINT = 'Talk to me — I’m listening.';
/** What the welcome offers; each is sent as typed when pressed. */
export const WELCOME_CHIPS: readonly string[] = ['Brief me', 'What needs me right now?', 'What can you do?'];
/** Nearer than this to the bottom counts as "at the bottom", so a pixel of rounding does not hide new messages. */
const AT_BOTTOM_SLACK_PX = 24;
/** Entries from the same speaker closer together than this share one time. */
const SHARED_TIME_MS = 60_000;

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
  /** Cards waiting for the operator's decision, shown after the last entry and scrolled into view when they appear. */
  pendingCards?: ReactNode;
}

/** "09:02": the local time of day, always two digits each. */
export function formatClock(atMs: number): string {
  const date = new Date(atMs);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

export type ReplyBlock = { kind: 'text'; text: string } | { kind: 'list'; items: string[] };

const LIST_ITEM = /^\s*(?:-|•)\s+(.*)$/;

/**
 * Split a reply into plain text and short lists: consecutive lines that start with "- " or "• " are one
 * list, everything else stays text exactly as written. Nothing else is interpreted (no other markdown).
 */
export function replyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let plain: string[] = [];
  let items: string[] = [];
  const endPlain = (): void => {
    // Blank lines around a list are spacing, not text of their own.
    const joined = plain.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined.trim()) blocks.push({ kind: 'text', text: joined });
    plain = [];
  };
  const endList = (): void => {
    if (items.length > 0) blocks.push({ kind: 'list', items });
    items = [];
  };
  for (const line of text.split('\n')) {
    const item = LIST_ITEM.exec(line)?.[1].trim();
    if (item) {
      endPlain();
      items.push(item);
    } else {
      endList();
      plain.push(line);
    }
  }
  endPlain();
  endList();
  return blocks;
}

/** A reply as React nodes: paragraphs of plain text and short lists. Never markup from the text itself. */
function ReplyText({ text }: { text: string }) {
  return (
    <>
      {replyBlocks(text).map((block, index) => (block.kind === 'list' ? (
        <ul key={index} className="avatar-entry-list" data-testid="avatar-entry-list">
          {block.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      ) : (
        <p key={index} className="avatar-entry-para">{block.text}</p>
      )))}
    </>
  );
}

type Speaker = 'you' | 'lucy';

/** Who said an entry that is shown as a bubble with a time under it; null for the rest. */
function timedSpeaker(entry: ConversationEntry): Speaker | null {
  switch (entry.kind) {
    case 'typed-you':
    case 'talk-you':
      return 'you';
    case 'talk-lucy':
      return 'lucy';
    case 'typed-lucy':
      // Until her first words arrive there is no bubble, only the line that says what she is doing.
      return entry.text ? 'lucy' : null;
    case 'lucy':
      // A spoken message says how long ago in its own line.
      return entry.clipId ? null : 'lucy';
    default:
      return null;
  }
}

function Who({ children }: { children: string }) {
  // Chat bubbles show who speaks by their side and colour; a screen reader is told in words.
  return <span className="sr-only">{children} </span>;
}

export function LucyThread({
  entries, clips, nowMs, liveReady, connecting, replayUnavailable, replayReasonId, onReplay, pendingCards,
}: LucyThreadProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  // The scroll area's own height and its content's height when they were last looked at: a change in either means
  // the room changed, which is told apart from the operator scrolling.
  const sizeRef = useRef({ box: 0, content: 0 });
  const lastIdRef = useRef<string | null>(null);
  const [newBelow, setNewBelow] = useState(false);
  const typed = useLucyTyped();
  // What each outcome line said when last looked at (null before the first look: a thread loaded from storage is not announced).
  const outcomeTextsRef = useRef<Map<string, string> | null>(null);
  // The button inside a card or a suggestion row that holds keyboard focus, so its going away can be noticed.
  const focusedRef = useRef<HTMLElement | null>(null);

  // What became of a card is recorded in this silent log; say it through the composer's status region as well.
  useEffect(() => {
    const seen = outcomeTextsRef.current;
    const now = new Map<string, string>();
    for (const entry of entries) if (entry.kind === 'launch-outcome') now.set(entry.id, entry.text);
    outcomeTextsRef.current = now;
    if (seen === null) return;
    // The newest changed line (a new one, or a "timed out" replaced by what really happened) is the one told.
    let told: string | null = null;
    for (const [id, text] of now) if (seen.get(id) !== text) told = text;
    if (told !== null) announceInComposer(told);
  }, [entries]);

  // A card or a suggestion row that held focus is gone (its button was pressed): keep focus in the thread instead of
  // letting it fall to the page. Focus the operator has moved elsewhere is left alone.
  useEffect(() => {
    const was = focusedRef.current;
    if (!was) return;
    if (was.isConnected) {
      if (document.activeElement !== was) focusedRef.current = null;
      return;
    }
    focusedRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) scrollRef.current?.focus();
  });

  // Follow the newest entry, and the growth of the one still arriving, while the operator is at the bottom.
  // Scrolled up, the list stays put and says there is something new. A thread just opened starts at the newest entry.
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
    sizeRef.current = { box: scroller.clientHeight, content: scroller.scrollHeight };
  }, [entries, connecting]);

  // What the entries cannot tell: the thread got shorter or taller (the tray opened, the composer grew), a
  // card grew, text wrapped differently. While the operator is at the bottom, the bottom stays in view.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scroller.scrollTop = scroller.scrollHeight;
      sizeRef.current = { box: scroller.clientHeight, content: scroller.scrollHeight };
    });
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // A card that appears wants a decision: it is brought into view even when the operator had scrolled up.
  useEffect(() => {
    const scroller = scrollRef.current;
    const cards = cardsRef.current;
    if (!scroller || !cards || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver((records) => {
      if (!records.some((record) => record.addedNodes.length > 0)) return;
      scroller.scrollTop = scroller.scrollHeight;
      atBottomRef.current = true;
      sizeRef.current = { box: scroller.clientHeight, content: scroller.scrollHeight };
      setNewBelow(false);
    });
    observer.observe(cards, { childList: true });
    return () => observer.disconnect();
  }, []);

  const onScroll = (): void => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const before = sizeRef.current;
    const resized = before.box > 0 && (before.box !== scroller.clientHeight || before.content !== scroller.scrollHeight);
    sizeRef.current = { box: scroller.clientHeight, content: scroller.scrollHeight };
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_SLACK_PX;
    if (!atBottom && resized && atBottomRef.current) {
      // The room changed under the operator (the tray opened, a reply grew): they did not scroll away, so stay on the newest entry.
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    atBottomRef.current = atBottom;
    if (atBottom) setNewBelow(false);
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
  const anyReplayable = entries.some((entry) => (entry.kind === 'clip' || entry.kind === 'lucy') && entry.clipId !== undefined && clipsById.has(entry.clipId));
  const lastId = entries[entries.length - 1]?.id;

  /** The time under a bubble, unless the next bubble is the same speaker's within a minute (they share its time). */
  const timeOf = (entry: ConversationEntry, index: number): ReactNode => {
    const speaker = timedSpeaker(entry);
    if (speaker === null) return null;
    const next = entries[index + 1];
    if (next && timedSpeaker(next) === speaker && next.at - entry.at < SHARED_TIME_MS) return null;
    return <time className="avatar-entry-time" dateTime={new Date(entry.at).toISOString()} data-testid="avatar-entry-time">{formatClock(entry.at)}</time>;
  };

  /** Suggestion buttons: only under the newest entry (older suggestions are about a moment that has passed). */
  const chipsOf = (chips: readonly string[] | undefined, show: boolean): ReactNode => {
    if (!show || !chips || chips.length === 0 || typed.off) return null;
    return (
      <div className="avatar-chips" role="group" aria-label="Suggestions" data-testid="avatar-chips">
        {chips.map((chip, index) => (
          <button
            key={`${index}-${chip}`}
            type="button"
            className="avatar-chip"
            onClick={() => { sendLucyTypedText(chip); }}
            // aria-disabled, like the panel's other buttons: it stays focusable while a reply is arriving.
            aria-disabled={typed.busy ? 'true' : undefined}
            data-testid="avatar-chip"
          >
            {chip}
          </button>
        ))}
      </div>
    );
  };

  /** A message of hers that was (or can be) said aloud: the text, then who it was about, how long ago, and Replay. */
  const spokenParts = (entry: ConversationEntry & { clipId: string; subject?: string; usedFallback?: boolean }): ReactNode => {
    const kept = clipsById.get(entry.clipId);
    const time = formatRelativeTime(entry.at, nowMs);
    const replayName = entry.subject ? `Replay message about ${entry.subject}, ${time}` : `Replay message, ${time}`;
    return (
      <>
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
      </>
    );
  };

  const renderEntry = (entry: ConversationEntry, index: number) => {
    const newest = entry.id === lastId;
    switch (entry.kind) {
      case 'typed-you':
        return (
          <li key={entry.id} className="avatar-entry avatar-entry-you" data-testid="avatar-typed-you">
            <div className="avatar-entry-bubble"><Who>You</Who>{entry.text}</div>
            {timeOf(entry, index)}
          </li>
        );
      case 'typed-lucy': {
        if (entry.status === 'error') {
          return (
            <li key={entry.id} className="avatar-entry avatar-entry-lucy avatar-entry-error" data-testid="avatar-typed-error">
              <div className="avatar-entry-bubble"><Who>{NAME}</Who>{entry.text}</div>
              {timeOf(entry, index)}
            </li>
          );
        }
        const waiting = entry.status === 'pending' && !entry.text;
        return (
          <li key={entry.id} className="avatar-entry avatar-entry-lucy" data-testid="avatar-typed-reply">
            {waiting ? (
              // One quiet line: what she is doing right now. Never an id, a handle or an argument.
              <p className="avatar-entry-doing avatar-entry-doing-now" data-testid="avatar-typed-doing"><Who>{NAME}</Who>{entry.doing ?? 'Thinking…'}</p>
            ) : (entry.looked ?? 0) > 0 && (
              <p className="avatar-entry-doing" data-testid="avatar-typed-doing">{lookedAtText(entry.looked ?? 0)}</p>
            )}
            {entry.text && <div className="avatar-entry-bubble"><Who>{NAME}</Who><ReplyText text={entry.text} /></div>}
            {/* A line she wrote on her own about a task (a task that failed, a question she could not speak) offers to open it. */}
            {entry.taskId && entry.status === 'done' && (
              <div className="avatar-entry-actions">
                <button type="button" className="avatar-chip avatar-entry-open" onClick={() => openLucyTask(entry.taskId!)} data-testid="avatar-typed-lucy-open">
                  Open task
                </button>
              </div>
            )}
            {chipsOf(entry.chips, newest && entry.status === 'done')}
            {timeOf(entry, index)}
          </li>
        );
      }
      case 'talk-you':
        return (
          <li
            key={entry.id}
            className={`avatar-entry avatar-entry-you${entry.final ? '' : ' avatar-live-draft'}`}
            data-testid="avatar-live-you"
            data-final={entry.final ? 'true' : 'false'}
          >
            <div className="avatar-entry-bubble"><Who>You</Who>{entry.text}</div>
            {timeOf(entry, index)}
          </li>
        );
      case 'talk-lucy':
        return (
          <li key={entry.id} className="avatar-entry avatar-entry-lucy" data-testid="avatar-live-lucy">
            <div className="avatar-entry-bubble"><Who>{NAME}</Who>{entry.text}</div>
            {chipsOf(entry.chips, newest)}
            {timeOf(entry, index)}
          </li>
        );
      case 'lucy': {
        const spoken = entry.clipId !== undefined;
        return (
          <li
            key={entry.id}
            className={`avatar-entry avatar-entry-lucy${spoken ? ' avatar-msg' : ''}`}
            // A message about a task she started keeps the name its strip had: it is that report, now in the thread.
            data-testid={entry.taskId ? 'avatar-launch-report' : 'avatar-lucy-message'}
            {...(spoken ? { 'data-clip-id': entry.clipId } : {})}
          >
            <div className="avatar-entry-bubble">
              <Who>{NAME}</Who>
              <div className="avatar-msg-text"><ReplyText text={entry.text} /></div>
              {spoken && spokenParts({ ...entry, clipId: entry.clipId! })}
            </div>
            {entry.taskId && (
              <div className="avatar-entry-actions">
                <button type="button" className="avatar-chip avatar-entry-open" onClick={() => openLucyTask(entry.taskId!)} data-testid="avatar-launch-report-open">
                  Open task
                </button>
              </div>
            )}
            {chipsOf(entry.chips, newest)}
            {timeOf(entry, index)}
          </li>
        );
      }
      case 'launch-outcome':
        return (
          <li key={entry.id} className="avatar-entry-event" data-testid="avatar-launch-result">
            {/* Shapes again: a tick when a task was started, a bar when nothing was. */}
            <span className={entry.started ? 'avatar-ask-check' : 'avatar-ask-dash'} aria-hidden="true" />
            <span className="avatar-entry-event-text">{entry.text}</span>
            {entry.taskId && (
              <>
                <span className="avatar-msg-sep" aria-hidden="true">·</span>
                <button type="button" className="avatar-launch-link" onClick={() => openLucyTask(entry.taskId!)} data-testid="avatar-launch-open">
                  Open task
                </button>
              </>
            )}
          </li>
        );
      case 'notice':
        return (
          <li key={entry.id} className="avatar-entry-event avatar-live-notice" data-testid="avatar-live-notice">
            {entry.text}
          </li>
        );
      case 'clip': {
        const kept = clipsById.has(entry.clipId);
        return (
          <li
            key={entry.id}
            className={`avatar-entry avatar-entry-lucy avatar-msg${kept ? '' : ' avatar-msg-text-only'}`}
            data-testid="avatar-message"
            data-clip-id={entry.clipId}
          >
            <div className="avatar-entry-bubble">
              <Who>{NAME}</Who>
              <p className="avatar-msg-text">{entry.text}</p>
              {spokenParts(entry)}
            </div>
          </li>
        );
      }
    }
  };

  return (
    <div
      className="avatar-thread"
      data-testid="avatar-thread-wrap"
      onFocus={(event) => {
        const target = event.target as HTMLElement;
        if (cardsRef.current?.contains(target) || target.closest('.avatar-chips')) focusedRef.current = target;
      }}
      onBlur={(event) => { if (event.relatedTarget !== null) focusedRef.current = null; }}
    >
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
        <div className="avatar-thread-content" ref={contentRef}>
          {replayUnavailable && anyReplayable && <span id={replayReasonId} className="sr-only">{replayUnavailable}</span>}
          {entries.length === 0 ? (
            // Nothing said yet: she says hello, and offers three things to ask.
            <div className="avatar-entry avatar-entry-lucy avatar-welcome" data-testid="avatar-hint">
              <div className="avatar-entry-bubble"><Who>{NAME}</Who>{liveReady ? LIVE_HINT : WELCOME_TEXT}</div>
              {chipsOf(WELCOME_CHIPS, true)}
            </div>
          ) : (
            <ol className="avatar-thread-list" role="list" data-testid="avatar-messages">
              {entries.map(renderEntry)}
            </ol>
          )}
          {connecting && <p className="avatar-live-notice avatar-thread-connecting">Connecting&hellip;</p>}
          {/* Outside the list: a card is not a message. Always present, so a card arriving is seen as a new child. */}
          <div className="avatar-thread-cards" ref={cardsRef} data-testid="avatar-thread-cards">{pendingCards}</div>
        </div>
      </div>
      {newBelow && (
        <button type="button" className="avatar-thread-new" onClick={jumpToNewest} data-testid="avatar-thread-new">
          New message
        </button>
      )}
    </div>
  );
}
