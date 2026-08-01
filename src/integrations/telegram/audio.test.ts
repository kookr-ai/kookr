/**
 * Unit tests for Telegram audio attachment classification and fail-closed
 * size/duration policy (pure functions in audio.ts).
 *
 * Attachment classification regressions used to hit only full bot integration;
 * this file pins boundary sizes, duration caps, document size heuristics, and
 * extractor pure-function contracts so oversized clips cannot reach STT.
 *
 * See issue #1865.
 */

import { describe, it, expect } from 'vitest';
import type { TelegramMessage } from './api-client.js';
import {
  MAX_AUDIO_BYTES,
  audioDropDecision,
  extractAudioAttachment,
  filenameFromFilePath,
  type TelegramAudioAttachment,
} from './audio.js';

/** Mirrors MAX_AUDIO_SECONDS in audio.ts (not exported). */
const MAX_AUDIO_SECONDS = 300;

/** Mirrors MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION in audio.ts (not exported). */
const MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION = 12 * 1024 * 1024;

function baseMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    chat: { id: 42, type: 'private' },
    ...overrides,
  };
}

function voiceAttachment(
  overrides: Partial<TelegramAudioAttachment> = {},
): TelegramAudioAttachment {
  return {
    source: 'voice',
    fileId: 'voice-file',
    durationSec: 30,
    fileSize: 1000,
    mimeType: 'audio/ogg',
    fallbackFilename: 'voice.oga',
    ...overrides,
  };
}

function documentAttachment(
  overrides: Partial<TelegramAudioAttachment> = {},
): TelegramAudioAttachment {
  return {
    source: 'document',
    fileId: 'doc-file',
    fileSize: 1000,
    mimeType: 'audio/mpeg',
    fallbackFilename: 'clip.mp3',
    ...overrides,
  };
}

describe('extractAudioAttachment', () => {
  it('extracts voice with defaults and optional fields', () => {
    const m = baseMessage({
      voice: {
        file_id: 'v1',
        file_unique_id: 'vu1',
        duration: 12,
        mime_type: 'audio/ogg',
        file_size: 2048,
      },
    });
    expect(extractAudioAttachment(m)).toEqual({
      source: 'voice',
      fileId: 'v1',
      durationSec: 12,
      fileSize: 2048,
      mimeType: 'audio/ogg',
      fallbackFilename: 'voice.oga',
    });
  });

  it('defaults voice mimeType to audio/ogg when Telegram omits it', () => {
    const m = baseMessage({
      voice: {
        file_id: 'v2',
        file_unique_id: 'vu2',
        duration: 5,
      },
    });
    expect(extractAudioAttachment(m)?.mimeType).toBe('audio/ogg');
  });

  it('extracts uploaded audio with file_name fallback', () => {
    const m = baseMessage({
      audio: {
        file_id: 'a1',
        file_unique_id: 'au1',
        duration: 90,
        file_name: 'song.mp3',
        mime_type: 'audio/mpeg',
        file_size: 4096,
      },
    });
    expect(extractAudioAttachment(m)).toEqual({
      source: 'audio',
      fileId: 'a1',
      durationSec: 90,
      fileSize: 4096,
      mimeType: 'audio/mpeg',
      fallbackFilename: 'song.mp3',
    });
  });

  it('uses "audio" fallback filename when audio has no file_name', () => {
    const m = baseMessage({
      audio: {
        file_id: 'a2',
        file_unique_id: 'au2',
        duration: 10,
      },
    });
    expect(extractAudioAttachment(m)?.fallbackFilename).toBe('audio');
  });

  it('extracts video_note with fixed mime and filename', () => {
    const m = baseMessage({
      video_note: {
        file_id: 'vn1',
        file_unique_id: 'vnu1',
        duration: 45,
        file_size: 8192,
      },
    });
    expect(extractAudioAttachment(m)).toEqual({
      source: 'video_note',
      fileId: 'vn1',
      durationSec: 45,
      fileSize: 8192,
      mimeType: 'video/mp4',
      fallbackFilename: 'video-note.mp4',
    });
  });

  it('extracts audio/* documents without duration', () => {
    const m = baseMessage({
      document: {
        file_id: 'd1',
        file_unique_id: 'du1',
        mime_type: 'audio/mpeg',
        file_name: 'clip.mp3',
        file_size: 1_000_000,
      },
    });
    expect(extractAudioAttachment(m)).toEqual({
      source: 'document',
      fileId: 'd1',
      fileSize: 1_000_000,
      mimeType: 'audio/mpeg',
      fallbackFilename: 'clip.mp3',
    });
  });

  it.each([
    ['application/pdf', 'report.pdf'],
    ['image/png', 'shot.png'],
    ['video/mp4', 'clip.mp4'],
    [undefined, 'mystery.bin'],
  ] as const)(
    'returns null for non-audio document mime %s (fail-closed classification)',
    (mime_type, file_name) => {
      const m = baseMessage({
        document: {
          file_id: 'd-non',
          file_unique_id: 'du-non',
          mime_type,
          file_name,
          file_size: 100,
        },
      });
      expect(extractAudioAttachment(m)).toBeNull();
    },
  );

  it('returns null when message has no audio-bearing attachment', () => {
    expect(extractAudioAttachment(baseMessage({ text: 'hello' }))).toBeNull();
  });

  it('prefers voice over audio/document when multiple fields present', () => {
    const m = baseMessage({
      voice: {
        file_id: 'voice-wins',
        file_unique_id: 'vu',
        duration: 3,
      },
      audio: {
        file_id: 'audio-ignored',
        file_unique_id: 'au',
        duration: 10,
      },
      document: {
        file_id: 'doc-ignored',
        file_unique_id: 'du',
        mime_type: 'audio/mpeg',
      },
    });
    expect(extractAudioAttachment(m)?.source).toBe('voice');
    expect(extractAudioAttachment(m)?.fileId).toBe('voice-wins');
  });
});

describe('filenameFromFilePath', () => {
  it.each([
    ['voice/file_42.oga', 'voice.oga', 'file_42.oga'],
    ['path/to/audio.mp3', 'audio', 'audio.mp3'],
    ['bare-name.ogg', 'fallback', 'bare-name.ogg'],
    ['', 'fallback.oga', 'fallback.oga'],
    ['/', 'fallback.oga', 'fallback.oga'],
  ])('path %j fallback %j → %j', (filePath, fallback, expected) => {
    expect(filenameFromFilePath(filePath, fallback)).toBe(expected);
  });
});

describe('audioDropDecision — duration cap', () => {
  it.each([
    [0, false],
    [1, false],
    [MAX_AUDIO_SECONDS, false],
    [MAX_AUDIO_SECONDS + 1, true],
    [600, true],
  ])('durationSec=%d → dropped=%s', (durationSec, dropped) => {
    const decision = audioDropDecision(voiceAttachment({ durationSec }));
    if (dropped) {
      expect(decision).toMatchObject({
        event: {
          kind: 'dropped_audio_too_long',
          source: 'voice',
          durationSec,
        },
      });
      expect(decision?.reply).toContain(`${durationSec}s`);
      expect(decision?.reply).toContain(`${MAX_AUDIO_SECONDS}s`);
    } else {
      expect(decision).toBeNull();
    }
  });

  it('duration check runs before size — over-long is rejected even with tiny bytes', () => {
    const decision = audioDropDecision(
      voiceAttachment({ durationSec: MAX_AUDIO_SECONDS + 1 }),
      100,
    );
    expect(decision?.event.kind).toBe('dropped_audio_too_long');
  });
});

describe('audioDropDecision — hard byte cap', () => {
  it.each([
    [0, false],
    [1, false],
    [MAX_AUDIO_BYTES, false],
    [MAX_AUDIO_BYTES + 1, true],
    [MAX_AUDIO_BYTES * 2, true],
  ])('bytes=%d → dropped=%s', (bytes, dropped) => {
    const decision = audioDropDecision(
      voiceAttachment({ durationSec: 30 }),
      bytes,
    );
    if (dropped) {
      expect(decision).toMatchObject({
        event: {
          kind: 'dropped_audio_too_large',
          source: 'voice',
          bytes,
          durationSec: 30,
        },
      });
      expect(decision?.reply).toContain(String(bytes));
      expect(decision?.reply).toContain(String(MAX_AUDIO_BYTES));
    } else {
      expect(decision).toBeNull();
    }
  });

  it('accepts under-limit when bytes are omitted (size unknown until download)', () => {
    // No bytes arg → cannot enforce size yet; duration already checked.
    expect(audioDropDecision(voiceAttachment({ durationSec: 60 }))).toBeNull();
  });
});

describe('audioDropDecision — document without duration (fail-closed size heuristic)', () => {
  it.each([
    [0, false],
    [MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION, false],
    [MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION + 1, true],
    [MAX_AUDIO_BYTES - 1, true], // still under hard byte cap, over document heuristic
  ])(
    'document without duration: bytes=%d → dropped=%s',
    (bytes, dropped) => {
      const decision = audioDropDecision(documentAttachment({ durationSec: undefined }), bytes);
      if (dropped) {
        expect(decision).toMatchObject({
          event: {
            kind: 'dropped_audio_too_long',
            source: 'document',
            bytes,
            estimatedFromBytes: true,
          },
        });
        expect(decision?.reply).toContain(String(bytes));
      } else {
        expect(decision).toBeNull();
      }
    },
  );

  it('document WITH duration uses duration cap, not the size heuristic', () => {
    // 13 MiB would fail the no-duration heuristic, but duration is known and under cap.
    const underDurationOverHeuristic = MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION + 1;
    expect(
      audioDropDecision(
        documentAttachment({ durationSec: 120 }),
        underDurationOverHeuristic,
      ),
    ).toBeNull();
  });

  it('document with over-limit duration is rejected regardless of small size', () => {
    const decision = audioDropDecision(
      documentAttachment({ durationSec: MAX_AUDIO_SECONDS + 1 }),
      100,
    );
    expect(decision?.event.kind).toBe('dropped_audio_too_long');
    expect(decision?.event).not.toHaveProperty('estimatedFromBytes');
  });

  it('non-document sources do not apply the document size heuristic', () => {
    // Voice with no duration metadata and "long-looking" size is not estimated.
    const decision = audioDropDecision(
      voiceAttachment({ durationSec: undefined }),
      MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION + 1,
    );
    // Still under MAX_AUDIO_BYTES, no duration → accept (wait for real duration path).
    expect(decision).toBeNull();
  });
});

describe('audioDropDecision — malformed / edge metadata fail-closed', () => {
  it('rejects hard-cap oversize even when duration is missing (fail closed on known size)', () => {
    const decision = audioDropDecision(
      documentAttachment({ durationSec: undefined }),
      MAX_AUDIO_BYTES + 1,
    );
    // Hard byte cap wins over document heuristic kind.
    expect(decision?.event.kind).toBe('dropped_audio_too_large');
  });

  it('rejects hard-cap oversize on voice when duration is present but under cap', () => {
    const decision = audioDropDecision(
      voiceAttachment({ durationSec: 10 }),
      MAX_AUDIO_BYTES + 1,
    );
    expect(decision?.event.kind).toBe('dropped_audio_too_large');
  });

  it('accepts boundary values at exact caps (not exclusive upper bounds)', () => {
    expect(
      audioDropDecision(voiceAttachment({ durationSec: MAX_AUDIO_SECONDS }), MAX_AUDIO_BYTES),
    ).toBeNull();
    expect(
      audioDropDecision(
        documentAttachment({ durationSec: undefined }),
        MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION,
      ),
    ).toBeNull();
  });
});

describe('MAX_AUDIO_BYTES export', () => {
  it('is 25 MiB (Telegram voice cap / whisper upload default alignment)', () => {
    expect(MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024);
  });
});
