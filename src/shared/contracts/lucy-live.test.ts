import { describe, expect, it } from 'vitest';
import { isLucyLiveClientMessage } from './lucy-live.js';

describe('isLucyLiveClientMessage', () => {
  it('accepts speech_start with or without lucyAudible', () => {
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: 't1' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: 't1', lucyAudible: true })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: 't1', lucyAudible: false })).toBe(true);
  });
  it('rejects a malformed lucyAudible or turn id', () => {
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: 't1', lucyAudible: 'yes' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: '' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'speech_start', turnId: 'x'.repeat(65) })).toBe(false);
  });
  it('keeps the existing messages valid, barge_in included', () => {
    expect(isLucyLiveClientMessage({ type: 'barge_in' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'speech_end', turnId: 't1' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'speech_cancel', turnId: 't1' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'hello', language: 'fr' })).toBe(true);
  });
  it('validates played strictly', () => {
    const ok = { type: 'played', turnId: 't1', seq: 0, complete: true };
    expect(isLucyLiveClientMessage(ok)).toBe(true);
    expect(isLucyLiveClientMessage({ ...ok, seq: -1 })).toBe(false);
    expect(isLucyLiveClientMessage({ ...ok, seq: 1.5 })).toBe(false);
    expect(isLucyLiveClientMessage({ ...ok, complete: 'yes' })).toBe(false);
    expect(isLucyLiveClientMessage({ ...ok, complete: undefined })).toBe(false);
  });
  it('rejects hello with an unsupported language', () => {
    expect(isLucyLiveClientMessage({ type: 'hello', language: 'de' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'hello' })).toBe(false);
  });
  it('does not accept the server-only verdicts from a client', () => {
    expect(isLucyLiveClientMessage({ type: 'speech_confirmed', turnId: 't1' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'speech_rejected', turnId: 't1' })).toBe(false);
  });
  it('validates say_ask and drop_ask (#3711)', () => {
    for (const type of ['say_ask', 'drop_ask']) {
      expect(isLucyLiveClientMessage({ type, askId: 'ask-1' })).toBe(true);
      expect(isLucyLiveClientMessage({ type, askId: '' })).toBe(false);
      expect(isLucyLiveClientMessage({ type, askId: 'x'.repeat(65) })).toBe(false);
      expect(isLucyLiveClientMessage({ type })).toBe(false);
    }
    // turn_start is the server's; a client cannot send it.
    expect(isLucyLiveClientMessage({ type: 'turn_start', turnId: 't1', askId: 'ask-1' })).toBe(false);
  });
  it('validates open_result strictly (#3929)', () => {
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: 'open-1', outcome: 'opened' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: 'open-1', outcome: 'blocked' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: 'open-1', outcome: 'unavailable' })).toBe(true);
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: 'open-1', outcome: 'maybe' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: '', outcome: 'opened' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'open_result', requestId: 'x'.repeat(65), outcome: 'opened' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'open', requestId: 'open-1', target: { kind: 'task', taskId: 't1' } })).toBe(false);
  });
});
