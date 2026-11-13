/**
 * A small text box for typing a request to Lucy (issue #3676): "investigate why the issue tasks stop chaining".
 *
 * Each send is one turn of `POST /api/lucy/turn` (input 'typed') in a conversation id made once per tab.
 * Her reply text is shown under the box. A proposal she makes arrives as the usual card through the dashboard
 * socket, never from this stream (the `proposal` and `launch` events here are informational and ignored).
 * When the first request answers 404 the operator feature is off, and the box removes itself for good.
 */
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
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

let conversationId: string | null = null;
/** One stable id for this tab, made on first use. */
export function typedConversationId(): string {
  if (conversationId === null) {
    const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    conversationId = `typed-${random}`.slice(0, 64);
    if (!LUCY_CONVERSATION_ID_RE.test(conversationId)) conversationId = `typed-${Date.now().toString(36)}`;
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
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [error, setError] = useState('');
  const inputId = useId();
  const level = useLucyAutonomyLabel();
  if (off) return null;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const sentence = text.trim();
    if (!sentence || busy) return;
    setBusy(true);
    setError('');
    setReply('');
    setText('');
    const result = await sendTypedTurn(sentence, fetcher ?? ((input, init) => fetch(input, init)), setReply);
    setBusy(false);
    if (result.ok) setReply(result.reply);
    else if (result.reason === 'feature_off') markFeatureOff();
    else setError(result.message);
  }

  return (
    <form className="avatar-typed" onSubmit={(e) => void submit(e)} data-testid="avatar-typed">
      <label className="sr-only" htmlFor={inputId}>Type a request to Lucy</label>
      <div className="avatar-typed-row">
        <input
          id={inputId}
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
      {(reply || busy) && (
        <p className="avatar-typed-reply" role="status" data-testid="avatar-typed-reply">{reply || 'Thinking…'}</p>
      )}
      {error && <p className="avatar-launch-error" role="alert" data-testid="avatar-typed-error">{error}</p>}
    </form>
  );
}
