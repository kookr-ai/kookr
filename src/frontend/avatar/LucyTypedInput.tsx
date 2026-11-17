/**
 * The composer at the foot of Lucy's column (issue #3676): a text box for typing a request to her,
 * "investigate why the issue tasks stop chaining", with the level of autonomy she is working at.
 *
 * The box grows with what is typed, from one line to five (from two to eight in Lucy's room, `roomy`).
 * Enter sends; Shift+Enter starts a new line.
 * Whatever the dock puts in `leading` (the Talk button) sits beside the box, and stays when the box
 * itself is gone.
 *
 * Each send is one turn of `POST /api/lucy/turn` (input 'typed') in a conversation id made once per browser
 * and kept in `localStorage`, so a reload, a new tab or a browser restart continues the same conversation
 * (the server keeps the last 20 messages of a conversation). The sentence and her reply are entries in the
 * thread (`store/lucy-conversation.ts`); this file only writes them, the thread shows them. Her reply is
 * written into its entry as it streams in, and until her first words arrive the entry says what she is
 * doing, from the stream's `tool_call` and `tool_result` events ("Reading the board…").
 *
 * {@link sendLucyTypedText} is the one way a typed turn is sent: the box, the welcome buttons and the
 * suggestion buttons under her messages all call it, and other code may too.
 *
 * A proposal she makes arrives as the usual card through the dashboard socket, never from this stream
 * (the `launch` events here are informational and ignored; `proposal` is only used to know that her reply
 * may be the card's read-back, which is then not shown a second time as a bubble). When the first request
 * answers 404 the operator feature is off, and the box removes itself for good.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  LUCY_CONVERSATION_ID_RE,
  LUCY_PROPOSE_LAUNCH_TOOL,
  LUCY_TURN_PATH,
  MAX_LUCY_TURN_TEXT_CHARS,
  type LucyTurnEvent,
} from '../../shared/contracts/lucy-turn.js';
import { openLucyTask } from './LucyLaunchCard.js';
import { getSettings } from '../api/settings.js';
import { DEFAULT_LUCY_AUTONOMY, isLucyAutonomy, type LucyAutonomy } from '../../shared/contracts/lucy-launch.js';
import { appendConversationEntry, removeConversationEntries, updateConversationEntry } from '../store/lucy-conversation.js';
import { isLaunchReadBack } from '../store/lucy-launch.js';

const AUTONOMY_LABEL: Record<LucyAutonomy, string> = { careful: 'Careful', balanced: 'Balanced', 'hands-off': 'Hands-off' };

/**
 * The level the operator chose in Settings, for display only. Read from the settings the dashboard loads
 * and refreshed when Settings saves (`kookr:settings-updated`). Absent in the settings means balanced; if the
 * settings cannot be read, nothing is shown.
 */
function useLucyAutonomyLabel(): LucyAutonomy | null {
  // Null until the settings have been read: a label that guessed "Balanced" could be wrong about a looser level.
  const [level, setLevel] = useState<LucyAutonomy | null>(null);
  useEffect(() => {
    let cancelled = false;
    const apply = (settings: { lucyAutonomy?: unknown } | null | undefined): void => {
      setLevel(isLucyAutonomy(settings?.lucyAutonomy) ? settings.lucyAutonomy : DEFAULT_LUCY_AUTONOMY);
    };
    getSettings<{ lucyAutonomy?: unknown }>().then((s) => { if (!cancelled) apply(s); }).catch(() => undefined);
    const onSaved = (event: Event): void => apply((event as CustomEvent<{ lucyAutonomy?: unknown }>).detail);
    window.addEventListener('kookr:settings-updated', onSaved);
    return () => { cancelled = true; window.removeEventListener('kookr:settings-updated', onSaved); };
  }, []);
  return level;
}

/** Where the conversation id is kept, so a reload or a new tab continues the same conversation. */
export const LUCY_CONVERSATION_ID_KEY = 'kookr:lucyTypedConversationId';

let conversationId: string | null = null;

function idStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** One stable id for this browser, made on first use and kept in `localStorage` (every tab shares the conversation). */
export function typedConversationId(): string {
  if (conversationId === null) {
    let saved: string | null = null;
    try { saved = idStore()?.getItem(LUCY_CONVERSATION_ID_KEY) ?? null; } catch { /* unreadable: make a new one */ }
    if (saved !== null && LUCY_CONVERSATION_ID_RE.test(saved)) {
      conversationId = saved;
    } else {
      const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      conversationId = `typed-${random}`.slice(0, 64);
      if (!LUCY_CONVERSATION_ID_RE.test(conversationId)) conversationId = `typed-${Date.now().toString(36)}`;
      try { idStore()?.setItem(LUCY_CONVERSATION_ID_KEY, conversationId); } catch { /* the id then lasts for this page only */ }
    }
  }
  return conversationId;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Two tabs that both made an id at the same moment: the one that was saved last is the one both use.
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === LUCY_CONVERSATION_ID_KEY && event.newValue !== null && LUCY_CONVERSATION_ID_RE.test(event.newValue)) {
      conversationId = event.newValue;
    }
  });
}

/** What the composer and the suggestion buttons need to know about typed turns. */
export interface LucyTypedState {
  /** The operator feature is switched off on the server: nothing can be sent. */
  off: boolean;
  /** A reply is still arriving in this tab; the next request waits for it. */
  busy: boolean;
  /** What a screen reader is told (the thread is a silent log). A new `seq` each time, so the same words are read again. */
  announce: { seq: number; text: string } | null;
}

const IDLE: LucyTypedState = Object.freeze({ off: false, busy: false, announce: null });
let typedState: LucyTypedState = IDLE;
const listeners = new Set<() => void>();
function setTypedState(patch: Partial<LucyTypedState>): void {
  typedState = { ...typedState, ...patch };
  for (const listener of listeners) listener();
}
function say(words: string): void {
  setTypedState({ announce: { seq: (typedState.announce?.seq ?? 0) + 1, text: words } });
}

/** Tell a screen reader something the silent thread just recorded (what became of a card), through the composer's status region. */
export function announceInComposer(words: string): void {
  say(words);
}

export function getLucyTypedState(): LucyTypedState {
  return typedState;
}

/** React binding: whether typed turns can be sent right now, and what to announce. */
export function useLucyTyped(): LucyTypedState {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getLucyTypedState,
    getLucyTypedState,
  );
}

export function __resetLucyTypedForTests(): void {
  typedState = IDLE;
  conversationId = null;
  listeners.clear();
  try { idStore()?.removeItem(LUCY_CONVERSATION_ID_KEY); } catch { /* nothing to remove */ }
}

/** Forget the id held in memory, as a page reload does; the saved id stays (tests only). */
export function __forgetLucyTypedIdInMemoryForTests(): void {
  conversationId = null;
}

/**
 * What she is doing, in plain words, for each thing she can look up. Only the tool's name is used:
 * never an id, a handle or an argument.
 */
const TOOL_PHRASE: Record<string, string> = {
  read_board: 'Reading the board…',
  read_task: 'Reading a task…',
  read_task_output: 'Reading a task’s terminal…',
  read_questions: 'Reading the questions…',
  show_task: 'Opening a task…',
  list_projects: 'Looking at the projects…',
  [LUCY_PROPOSE_LAUNCH_TOOL]: 'Preparing a task to start…',
};
/** The name comes from the model: one it invented gets a phrase that names nothing. */
const UNKNOWN_TOOL_PHRASE = 'Looking something up…';

/** The plain phrase for a tool the stream says she is using. */
export function describeLucyTool(name: string): string {
  return Object.hasOwn(TOOL_PHRASE, name) ? TOOL_PHRASE[name] : UNKNOWN_TOOL_PHRASE;
}

/** "Looked at 3 things": what stays of the look-ups once her answer has started. */
export function lookedAtText(count: number): string {
  return `Looked at ${count} ${count === 1 ? 'thing' : 'things'}`;
}

export interface TypedTurnActivity {
  /** What she is doing right now, or null once her answer has started. */
  doing: string | null;
  /** How many look-ups have succeeded so far. */
  looked: number;
}

export interface TypedTurnHandlers {
  /** Her reply so far, each time more of it arrives. Not called while the reply only repeats the launch card on screen. */
  onText?: (replySoFar: string) => void;
  onActivity?: (activity: TypedTurnActivity) => void;
}

export type TypedTurnResult =
  /** `repeatsCard`: the whole reply is the read-back of the launch card on screen. */
  | { ok: true; reply: string; repeatsCard: boolean }
  | { ok: false; reason: 'feature_off' | 'failed'; message: string };

/** Send one typed sentence and read the stream. Never throws. */
export async function sendTypedTurn(
  text: string,
  fetcher: typeof fetch = fetch,
  handlers: TypedTurnHandlers = {},
): Promise<TypedTurnResult> {
  try {
    const response = await fetcher(LUCY_TURN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, conversationId: typedConversationId(), input: 'typed' }),
    });
    if (response.status === 404) return { ok: false, reason: 'feature_off', message: '' };
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const message = typeof body?.message === 'string' ? body.message : 'Lucy is not available right now.';
      return { ok: false, reason: 'failed', message };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reply = '';
    let errorReason = '';
    let looked = 0;
    let proposed = false;
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let event: LucyTurnEvent;
      try { event = JSON.parse(line) as LucyTurnEvent; } catch { return; }
      if (event.type === 'text') {
        const first = reply === '';
        reply += event.delta;
        // Her read-back of a card that is on screen repeats the card: it is not also written as a bubble.
        if (proposed && isLaunchReadBack(reply, { partial: true })) return;
        if (first) handlers.onActivity?.({ doing: null, looked });
        handlers.onText?.(reply);
      } else if (event.type === 'tool_call') {
        if (reply === '') handlers.onActivity?.({ doing: describeLucyTool(event.name), looked });
      } else if (event.type === 'tool_result') {
        // Preparing a launch is not something she looked at.
        if (event.ok && event.name !== LUCY_PROPOSE_LAUNCH_TOOL) {
          looked += 1;
          if (reply === '') handlers.onActivity?.({ doing: describeLucyTool(event.name), looked });
        }
      } else if (event.type === 'proposal') {
        proposed = true;
      } else if (event.type === 'screen' && event.command === 'show_task') {
        openLucyTask(event.taskId);
      } else if (event.type === 'done' && event.end === 'error' && event.reason) {
        errorReason = event.reason;
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    handleLine(buffer + decoder.decode());
    if (errorReason && !reply) return { ok: false, reason: 'failed', message: errorReason };
    return { ok: true, reply, repeatsCard: proposed && isLaunchReadBack(reply) };
  } catch {
    return { ok: false, reason: 'failed', message: 'Lucy could not be reached.' };
  }
}

/** What her entry says when a turn ended without a word from her. */
export const NO_REPLY_TEXT = 'Lucy did not answer. Try again.';

async function runTypedTurn(sentence: string, fetcher: typeof fetch): Promise<void> {
  setTypedState({ busy: true });
  const youId = appendConversationEntry({ kind: 'typed-you', text: sentence });
  const lucyId = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
  say('Thinking\u2026');
  const result = await sendTypedTurn(sentence, fetcher, {
    onText: (replySoFar) => updateConversationEntry(lucyId, { text: replySoFar }),
    onActivity: ({ doing, looked }) => updateConversationEntry(lucyId, { doing, looked }),
  });
  if (result.ok) {
    if (result.repeatsCard) {
      // The card says it; a bubble with the same sentence above it would be the third copy.
      removeConversationEntries([lucyId]);
    } else if (result.reply.trim()) {
      updateConversationEntry(lucyId, { text: result.reply, status: 'done', doing: null });
    } else {
      updateConversationEntry(lucyId, { text: NO_REPLY_TEXT, status: 'error', doing: null });
    }
    say(result.reply.trim() ? result.reply : NO_REPLY_TEXT);
    setTypedState({ busy: false });
  } else if (result.reason === 'feature_off') {
    removeConversationEntries([youId, lucyId]);
    setTypedState({ busy: false, off: true });
  } else {
    updateConversationEntry(lucyId, { text: result.message, status: 'error', doing: null });
    say(result.message);
    setTypedState({ busy: false });
  }
}

/**
 * Send `text` to Lucy as a typed request, exactly as if the operator had typed it into the box and pressed
 * Send: it is added to the thread, and her reply streams into the entry below it. Returns false, and sends
 * nothing, when the text is empty, the operator feature is off, or a reply is still arriving.
 */
export function sendLucyTypedText(text: string, options: { fetcher?: typeof fetch } = {}): boolean {
  const sentence = text.trim().slice(0, MAX_LUCY_TURN_TEXT_CHARS);
  if (!sentence || typedState.off || typedState.busy) return false;
  // `fetch` is looked up when the request is made, so a test's (or the page's) replacement is the one used.
  void runTypedTurn(sentence, options.fetcher ?? ((input, init) => fetch(input, init)));
  return true;
}

/** The box never grows past this many lines; beyond that it scrolls inside itself. */
const MAX_COMPOSER_LINES = 5;
/** In Lucy's room there is room for more; it also starts two lines tall there (styles.css). */
const MAX_ROOMY_COMPOSER_LINES = 8;

export interface LucyTypedInputProps {
  fetcher?: typeof fetch;
  /** Shown beside the box (the Talk button). It stays when the box is gone because the feature is off. */
  leading?: ReactNode;
  /** True in Lucy's room: the box starts at two lines and grows to eight. */
  roomy?: boolean;
}

export function LucyTypedInput({ fetcher, leading, roomy = false }: LucyTypedInputProps = {}) {
  const { off, busy, announce } = useLucyTyped();
  const [text, setText] = useState('');
  const inputId = useId();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const level = useLucyAutonomyLabel();

  // As tall as what is typed, from one line to five (two to eight in the room; the stylesheet holds the least
  // height); only past the most does it scroll. Measured again when the room is entered or left, so a draft
  // typed in one layout has the right height in the other.
  const maxLines = roomy ? MAX_ROOMY_COMPOSER_LINES : MAX_COMPOSER_LINES;
  useLayoutEffect(() => {
    const box = inputRef.current;
    if (!box) return;
    if (!text) {
      // Empty: the one line the stylesheet gives it (a placeholder that wraps must not make it taller).
      box.style.height = '';
      box.style.overflowY = 'hidden';
      return;
    }
    box.style.height = 'auto';
    const style = getComputedStyle(box);
    const line = Number.parseFloat(style.lineHeight);
    const edges = box.offsetHeight - box.clientHeight;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const wanted = box.scrollHeight + edges;
    const most = Number.isFinite(line) ? line * maxLines + padding + edges : Infinity;
    if (wanted > 0) box.style.height = `${Math.min(wanted, most)}px`;
    box.style.overflowY = wanted > most ? 'auto' : 'hidden';
  }, [text, off, maxLines]);

  if (off && !leading) return null;

  const send = (): void => {
    if (!sendLucyTypedText(text, fetcher ? { fetcher } : {})) return;
    setText('');
    // The next request is typed in the same place: a press on Send must not take the cursor away from the box.
    inputRef.current?.focus();
  };
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    send();
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends; Shift+Enter is a new line. An Enter that only confirms a composed character (IME) is neither.
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <div className="avatar-composer" data-testid="avatar-composer">
      <div className="avatar-composer-row">
        {leading}
        {!off && (
          <form className="avatar-typed" onSubmit={onSubmit} data-testid="avatar-typed">
            <label className="sr-only" htmlFor={inputId}>Type a request to Lucy</label>
            <textarea
              id={inputId}
              ref={inputRef}
              rows={roomy ? 2 : 1}
              value={text}
              maxLength={MAX_LUCY_TURN_TEXT_CHARS}
              placeholder="Ask Lucy, or tell her what to do"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              data-testid="avatar-typed-input"
            />
            <button type="submit" className="avatar-ask-send" aria-disabled={busy ? 'true' : undefined} data-testid="avatar-typed-send">
              Send
            </button>
          </form>
        )}
      </div>
      {!off && level !== null && <p className="avatar-typed-level" data-testid="avatar-autonomy-level">Lucy autonomy: {AUTONOMY_LABEL[level]}</p>}
      {/* Always present, only emptied, so what is added to it is announced. */}
      <div className="sr-only" role="status" data-testid="avatar-typed-announce">
        {announce && <span key={announce.seq}>{announce.text}</span>}
      </div>
    </div>
  );
}
