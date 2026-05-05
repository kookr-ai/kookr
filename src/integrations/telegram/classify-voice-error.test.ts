/**
 * Direct unit tests for classifyVoiceError — fast branch coverage that doesn't
 * pay the E2E setup cost in index.test.ts. The integration tests in
 * index.test.ts still verify the catch block actually wires through to
 * sendMessageSafe; this file pins the pure-function contract.
 *
 * See issue #577.
 */
import { describe, it, expect } from 'vitest';
import { classifyVoiceError } from './index.js';
import { TranscriptionError } from './transcribe.js';
import { TelegramApiError } from './api-client.js';

const UNREACHABLE = 'Transcription server unreachable. Please type — audio will retry on the next message.';
const FOUR_XX = 'Could not transcribe that recording. Please re-record or type.';
const SERVER_ERROR = 'Transcription failed (server error). Please type or try again.';
const FALLBACK = 'Transcription failed. Please type.';

describe('classifyVoiceError', () => {
  describe('whisper TranscriptionError, status known', () => {
    // The "payload-rejected" bucket is enumerated rather than range-based — see
    // PAYLOAD_REJECTED_STATUSES in index.ts. Other 4xx (429, 408, 401, 403, ...)
    // are infrastructure failures, not bad recordings, and should advise retry.
    it.each([400, 413, 415, 422])('classifies payload-shape status %d as payload-rejected', (status) => {
      expect(classifyVoiceError(new TranscriptionError(status, `whisper ${status}: nope`))).toBe(FOUR_XX);
    });
    it.each([
      [408, 'Request Timeout'],
      [425, 'Too Early'],
      [429, 'Too Many Requests'],
      [499, 'Client Closed Request'],
    ])('classifies retryable 4xx %d (%s) as server-error, NOT payload-rejected (codex review)', (status, label) => {
      expect(classifyVoiceError(new TranscriptionError(status, `whisper ${status}: ${label}`))).toBe(SERVER_ERROR);
    });
    it.each([
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [407, 'Proxy Auth Required'],
      [451, 'Unavailable For Legal Reasons'],
    ])('classifies auth/proxy 4xx %d (%s) as server-error — recording is fine, user can\'t fix it by re-recording', (status, label) => {
      expect(classifyVoiceError(new TranscriptionError(status, `whisper ${status}: ${label}`))).toBe(SERVER_ERROR);
    });
    it.each([500, 502, 503, 504, 599])('classifies status %d as server-error', (status) => {
      expect(classifyVoiceError(new TranscriptionError(status, `whisper ${status}: down`))).toBe(SERVER_ERROR);
    });
    it('classifies 2xx with non-JSON body as server-error (message-based)', () => {
      const err = new TranscriptionError(200, 'whisper returned non-JSON body: SyntaxError: unexpected token');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
    it('classifies 2xx missing "text" field as server-error', () => {
      const err = new TranscriptionError(200, 'whisper response missing "text" field');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
  });

  describe('whisper TranscriptionError, status null (transport failure)', () => {
    it.each([
      'whisper request failed: TypeError: fetch failed: connect ECONNREFUSED 127.0.0.1:8010',
      'whisper request failed: Error: connect EHOSTUNREACH 192.168.1.1:8010',
      'whisper request failed: Error: getaddrinfo ENOTFOUND whisper.local',
      'whisper request failed: Error: getaddrinfo EAI_AGAIN whisper.local',
      'whisper request failed: Error: read ECONNRESET',
      'whisper request failed: Error: write EPIPE',
      'whisper request failed: Error: socket hang up',
      'whisper request failed: TypeError: fetch failed: cause UND_ERR_SOCKET',
      'whisper request failed: TypeError: fetch failed: UND_ERR_CONNECT_TIMEOUT',
      'whisper request failed: TypeError: fetch failed: UND_ERR_HEADERS_TIMEOUT',
      'whisper request aborted after 30000ms',
    ])('classifies %s as unreachable', (msg) => {
      expect(classifyVoiceError(new TranscriptionError(null, msg))).toBe(UNREACHABLE);
    });
  });

  describe('TelegramApiError from getFile / downloadFile', () => {
    it('classifies 429 rate-limit as server-error (recording is fine, retry advised)', () => {
      // Telegram's getUpdates/sendMessage are rate-limited via 429 + retry_after;
      // getFile/downloadFile inherit the same. Routing this to "re-record" would
      // be wrong UX (codex review #581) — the bytes are identical next try.
      const err = new TelegramApiError(429, 30, 'Telegram getFile 429: Too Many Requests');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
    it('classifies 404 (e.g. file GC\'d server-side) as payload-rejected', () => {
      // 404 isn't in PAYLOAD_REJECTED_STATUSES; falls through to server-error.
      // The recording is irretrievable but still fine; type-instead is the
      // right advice. Pinning the actual classification.
      const err = new TelegramApiError(404, null, 'Telegram getFile 404: file expired');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
    it('classifies 5xx Telegram CDN errors as server-error', () => {
      const err = new TelegramApiError(503, null, 'Telegram downloadFile 503: Service Unavailable');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
    it('classifies 200-not-ok responses (status=200, ok:false) as fallback — no actionable user advice possible', () => {
      // Telegram API quirk: ok:false sometimes returns HTTP 200. Without a 4xx/5xx
      // signal there's no honest classification, so the generic message wins.
      const err = new TelegramApiError(200, null, 'Telegram getFile not-ok: file not found');
      expect(classifyVoiceError(err)).toBe(FALLBACK);
    });
  });

  describe('bare Error (not wrapped)', () => {
    it('classifies an Error whose message contains a transport token as unreachable', () => {
      expect(classifyVoiceError(new Error('connect ECONNREFUSED 127.0.0.1:8010'))).toBe(UNREACHABLE);
    });
    it('classifies an AbortError without the magic substring as unreachable', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      expect(classifyVoiceError(err)).toBe(UNREACHABLE);
    });
    it('classifies an unrelated Error as the generic fallback', () => {
      expect(classifyVoiceError(new Error('something else broke'))).toBe(FALLBACK);
    });
  });

  describe('false-positive guards', () => {
    it('5xx body containing "ECONNREFUSED" stays classified as server-error, not unreachable', () => {
      const err = new TranscriptionError(500, 'whisper 500: trace mentions ECONNREFUSED 10.0.0.5:9000 internally');
      expect(classifyVoiceError(err)).toBe(SERVER_ERROR);
    });
    it('4xx body containing "non-JSON" stays classified as payload-rejected, not server-error', () => {
      const err = new TranscriptionError(400, 'whisper 400: client sent non-JSON metadata');
      expect(classifyVoiceError(err)).toBe(FOUR_XX);
    });
  });

  describe('non-Error inputs', () => {
    it('classifies a thrown string as fallback', () => {
      expect(classifyVoiceError('something weird')).toBe(FALLBACK);
    });
    it('classifies a thrown string containing transport token as unreachable (msg fallback via String())', () => {
      expect(classifyVoiceError('connect ECONNREFUSED 127.0.0.1:8010')).toBe(UNREACHABLE);
    });
    it('classifies undefined/null as fallback', () => {
      expect(classifyVoiceError(undefined)).toBe(FALLBACK);
      expect(classifyVoiceError(null)).toBe(FALLBACK);
    });
  });
});
