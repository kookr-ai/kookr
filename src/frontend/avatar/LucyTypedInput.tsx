/**
 * The composer at the foot of Lucy's column (issue #3676): a text box for typing a request to her,
 * "investigate why the issue tasks stop chaining", with the level of autonomy she is working at.
 *
 * Each send is one turn of `POST /api/lucy/turn` (input 'typed') in a conversation id made once per tab
 * and kept in `sessionStorage`, so after a page reload she still remembers the earlier turns (the server
 * keeps the last 20 messages of a conversation). The sentence and her reply are entries in the thread
 * (`store/lucy-conversation.ts`); this component only writes them, the thread shows them. Her reply is
 * written into its entry as it streams in. A proposal she makes arrives as the usual card through the
 * dashboard socket, never from this stream (the `proposal` and `launch` events here are informational
 * and ignored). When the first request answers 404 the operator feature is off, and the box removes
 * itself for good.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';
import {
  LUCY_CONVERSATION_ID_RE,
  LUCY_TURN_PATH,
  MAX_LUCY_TURN_TEXT_CHARS,
  type LucyTurnEvent,
} from '../../shared/contracts/lucy-turn.js';
import { openLucyTask } from './LucyLaunchCard.js';
import { getSettings } from '../api/settings.js';
import { DEFAULT_LUCY_AUTONOMY, isLucyAutonomy, type LucyAutonomy } from '../../shared/contracts/lucy-launch.js';
import {
  appendConversationEntry,
  removeConversationEntries,
  updateConversationEntry,
  useLucyConversation,
} from '../store/lucy-conversation.js';

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

/** Where the tab's conversation id is kept, so a reload continues the same conversation. */
export const LUCY_CONVERSATION_ID_KEY = 'kookr:lucyTypedConversationId';

let conversationId: string | null = null;

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** One stable id for this tab, made on first use and kept in `sessionStorage` (a new tab is a new conversation). */
export function typedConversationId(): string {
  if (conversationId === null) {
    let saved: string | null = null;
    try { saved = sessionStore()?.getItem(LUCY_CONVERSATION_ID_KEY) ?? null; } catch { /* unreadable: make a new one */ }
    if (saved !== null && LUCY_CONVERSATION_ID_RE.test(saved)) {
      conversationId = saved;
    } else {
      const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replace(/-/g, '')
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
      conversationId = `typed-${random}`.slice(0, 64);
      if (!LUCY_CONVERSATION_ID_RE.test(conversationId)) conversationId = `typed-${Date.now().toString(36)}`;
      try { sessionStore()?.setItem(LUCY_CONVERSATION_ID_KEY, conversationId); } catch { /* the id then lasts for this page only */ }
    }
  }
  return conversationId;
}

let featureOff = false;
const listeners = new Set<() => void>();
function markFeatureOff(): void {
  featureOff = true;
  for (const listener of listeners) listener();
}
export function __resetLucyTypedForTests(): void {
  featureOff = false;
  conversationId = null;
  listeners.clear();
  try { sessionStore()?.removeItem(LUCY_CONVERSATION_ID_KEY); } catch { /* nothing to remove */ }
}

/** Forget the id held in memory, as a page reload does; the id saved in `sessionStorage` stays (tests only). */
export function __forgetLucyTypedIdInMemoryForTests(): void {
  conversationId = null;
}

export type TypedTurnResult =
  | { ok: true; reply: string }
  | { ok: false; reason: 'feature_off' | 'failed'; message: string };

/** Send one typed sentence and read the stream. Never throws. */
export async function sendTypedTurn(
  text: string,
  fetcher: typeof fetch = fetch,
  onText?: (replySoFar: string) => void,
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
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let event: LucyTurnEvent;
      try { event = JSON.parse(line) as LucyTurnEvent; } catch { return; }
      if (event.type === 'text') {
        reply += event.delta;
        onText?.(reply);
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
    return { ok: true, reply };
  } catch {
    return { ok: false, reason: 'failed', message: 'Lucy could not be reached.' };
  }
}

export function LucyTypedInput({ fetcher }: { fetcher?: typeof fetch } = {}) {
  const off = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => featureOff,
    () => featureOff,
  );
  const [text, setText] = useState('');
  // What a screen reader is told: the thread is a silent log, so a typed reply (which nobody speaks) is read from
  // here. A new element each time, so the same text is read again. An error is told like a reply.
  const [announce, setAnnounce] = useState<{ seq: number; text: string } | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const level = useLucyAutonomyLabel();
  // Busy while a reply is still arriving. Read from the thread, not from this component, so minimising the panel
  // while Lucy is answering does not make the box look free.
  const entries = useLucyConversation();
  const busy = entries.some((entry) => entry.kind === 'typed-lucy' && entry.status === 'pending');
  if (off) return null;

  const say = (words: string): void => setAnnounce((previous) => ({ seq: (previous?.seq ?? 0) + 1, text: words }));

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const sentence = text.trim();
    if (!sentence || busy) return;
    setText('');
    // The next request is typed in the same place: a press on Send must not take the cursor away from the box.
    inputRef.current?.focus();
    const youId = appendConversationEntry({ kind: 'typed-you', text: sentence });
    const lucyId = appendConversationEntry({ kind: 'typed-lucy', text: '', status: 'pending' });
    say('Thinking\u2026');
    const result = await sendTypedTurn(
      sentence,
      fetcher ?? ((input, init) => fetch(input, init)),
      (replySoFar) => updateConversationEntry(lucyId, { text: replySoFar }),
    );
    if (result.ok) {
      updateConversationEntry(lucyId, { text: result.reply, status: 'done' });
      say(result.reply);
    } else if (result.reason === 'feature_off') {
      removeConversationEntries([youId, lucyId]);
      markFeatureOff();
    } else {
      updateConversationEntry(lucyId, { text: result.message, status: 'error' });
      say(result.message);
    }
  }

  return (
    <form className="avatar-typed" onSubmit={(e) => void submit(e)} data-testid="avatar-typed">
      <label className="sr-only" htmlFor={inputId}>Type a request to Lucy</label>
      <div className="avatar-typed-row">
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={text}
          maxLength={MAX_LUCY_TURN_TEXT_CHARS}
          placeholder="Ask Lucy to look into something"
          onChange={(e) => setText(e.target.value)}
          data-testid="avatar-typed-input"
        />
        <button type="submit" className="avatar-ask-send" aria-disabled={busy ? 'true' : undefined} data-testid="avatar-typed-send">
          Send
        </button>
      </div>
      {level !== null && <p className="avatar-typed-level" data-testid="avatar-autonomy-level">Lucy autonomy: {AUTONOMY_LABEL[level]}</p>}
      {/* Always present, only emptied, so what is added to it is announced. */}
      <div className="sr-only" role="status" data-testid="avatar-typed-announce">
        {announce && <span key={announce.seq}>{announce.text}</span>}
      </div>
    </form>
  );
}
