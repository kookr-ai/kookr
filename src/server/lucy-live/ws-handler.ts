/**
 * Connects one WebSocket to one {@link LucyLiveSession}: decodes frames, enforces the
 * wire rules and cleans up when the socket closes.
 *
 * Text frames are JSON and must match the client-message contract; anything else gets
 * an `error` of code `bad_message` and the connection stays open. Binary frames are raw
 * microphone audio and are only taken while a turn is listening (between `speech_start`
 * and `speech_end`); a stray frame outside that window is dropped silently because
 * the browser can legitimately send one a moment after `speech_end`. A frame larger
 * than {@link MAX_LUCY_LIVE_FRAME_BYTES} is rejected.
 */

import type { WebSocket } from 'ws';
import {
  isLucyLiveClientMessage,
  type LucyLiveClientMessage,
  type LucyLiveServerMessage,
} from '../../shared/contracts/lucy-live.js';

/** Largest frame accepted from the browser: 2 s of 16 kHz PCM16 mono. */
export const MAX_LUCY_LIVE_FRAME_BYTES = 64 * 1024;

/** What the handler needs from a session (the real class satisfies it). */
export interface LucyLiveSessionLike {
  readonly acceptingAudio: boolean;
  handleMessage(message: LucyLiveClientMessage): void;
  handleAudio(pcm: Buffer): void;
  close(): void;
}

const WS_OPEN = 1;

export function bindLucyLiveSocket(
  ws: WebSocket,
  createSession: (send: (message: LucyLiveServerMessage) => void) => LucyLiveSessionLike,
  warn: (message: string) => void = () => {},
): void {
  const send = (message: LucyLiveServerMessage): void => {
    if (ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      warn(`lucy-live: send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const badMessage = (message: string): void => send({ type: 'error', code: 'bad_message', message });

  const session = createSession(send);

  ws.on('message', (data, isBinary) => {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (buffer.length > MAX_LUCY_LIVE_FRAME_BYTES) {
      badMessage(`Frame too large (limit ${MAX_LUCY_LIVE_FRAME_BYTES} bytes)`);
      return;
    }
    try {
      if (isBinary) {
        if (session.acceptingAudio) session.handleAudio(buffer);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString('utf8'));
      } catch {
        badMessage('Message is not valid JSON');
        return;
      }
      if (!isLucyLiveClientMessage(parsed)) {
        badMessage('Unknown or malformed message');
        return;
      }
      session.handleMessage(parsed);
    } catch (err) {
      warn(`lucy-live: handler failed: ${err instanceof Error ? err.message : String(err)}`);
      send({ type: 'error', code: 'internal', message: 'Lucy live hit an internal error' });
    }
  });
  ws.on('error', (err) => warn(`lucy-live: socket error: ${err.message}`));
  ws.on('close', () => session.close());
}
