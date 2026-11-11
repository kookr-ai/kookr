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
  it('does not accept the server-only verdicts from a client', () => {
    expect(isLucyLiveClientMessage({ type: 'speech_confirmed', turnId: 't1' })).toBe(false);
    expect(isLucyLiveClientMessage({ type: 'speech_rejected', turnId: 't1' })).toBe(false);
  });
});
