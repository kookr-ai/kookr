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
});
