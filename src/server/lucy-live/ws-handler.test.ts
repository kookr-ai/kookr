import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { LucyLiveClientMessage } from '../../shared/contracts/lucy-live.js';
import { bindLucyLiveSocket, MAX_LUCY_LIVE_FRAME_BYTES, type LucyLiveSessionLike } from './ws-handler.js';

function setup() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn() });
  const session = {
    acceptingAudio: false,
    messages: [] as LucyLiveClientMessage[],
    audio: [] as Buffer[],
    closed: false,
    handleMessage(m: LucyLiveClientMessage) { this.messages.push(m); },
    handleAudio(b: Buffer) { this.audio.push(b); },
    close() { this.closed = true; },
  };
  let send!: (m: unknown) => void;
  bindLucyLiveSocket(ws as unknown as WebSocket, (s) => { send = s as (m: unknown) => void; return session as LucyLiveSessionLike; });
  const text = (v: unknown) => ws.emit('message', Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)), false);
  const sentTypes = () => ws.send.mock.calls.map((c) => JSON.parse(String(c[0])));
  return { ws, session, text, sentTypes, send: () => send };
}

describe('bindLucyLiveSocket', () => {
  it('passes valid messages to the session', () => {
    const t = setup();
    t.text({ type: 'hello', language: 'en' });
    expect(t.session.messages).toEqual([{ type: 'hello', language: 'en' }]);
  });

  it('answers invalid json, unknown types and bad fields with bad_message and stays open', () => {
    const t = setup();
    t.text('{nope');
    t.text({ type: 'dance' });
    t.text({ type: 'speech_start' });
    expect(t.sentTypes().map((m) => m.code)).toEqual(['bad_message', 'bad_message', 'bad_message']);
    expect(t.session.messages).toEqual([]);
    t.text({ type: 'barge_in' });
    expect(t.session.messages).toHaveLength(1);
  });

  it('takes binary frames only while the session is accepting audio', () => {
    const t = setup();
    t.ws.emit('message', Buffer.alloc(10), true);
    expect(t.session.audio).toHaveLength(0);
    t.session.acceptingAudio = true;
    t.ws.emit('message', Buffer.alloc(10), true);
    expect(t.session.audio).toHaveLength(1);
  });

  it('rejects oversize frames', () => {
    const t = setup();
    t.session.acceptingAudio = true;
    t.ws.emit('message', Buffer.alloc(MAX_LUCY_LIVE_FRAME_BYTES + 1), true);
    expect(t.session.audio).toHaveLength(0);
    expect(t.sentTypes()[0].code).toBe('bad_message');
  });

  it('reports a throwing session as internal error without crashing', () => {
    const t = setup();
    t.session.handleMessage = () => { throw new Error('boom'); };
    t.text({ type: 'barge_in' });
    expect(t.sentTypes()[0].code).toBe('internal');
  });

  it('closes the session when the socket closes and does not send on a closed socket', () => {
    const t = setup();
    t.ws.emit('close');
    expect(t.session.closed).toBe(true);
    t.ws.readyState = 3;
    t.send()({ type: 'ready' });
    expect(t.ws.send).not.toHaveBeenCalled();
  });
});
