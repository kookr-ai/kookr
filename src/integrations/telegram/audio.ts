import type { AuditEvent } from './audit.js';
import type { TelegramMessage } from './api-client.js';

/**
 * Cap for Telegram audio we will transcribe. Telegram's default in-app voice
 * recording cap is 60 s, but uploaded audio/video files can be much longer.
 * We refuse anything past 5 minutes — large-v3 on GPU does ~10x realtime, so
 * a 5 min clip is still ~30 s of work.
 */
const MAX_AUDIO_SECONDS = 300;

/**
 * Hard upper bound on audio payload size. Telegram caps voice files at 20 MB
 * and faster-whisper-server defaults its upload limit to 25 MB; uploaded
 * audio/document files can be much larger, so we fail closed at 25 MiB before
 * download whenever Telegram exposes file_size. The Buffer is held in memory
 * only — never persisted — and freed once the multipart POST returns.
 */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Telegram documents do not include a duration field. For audio documents, use
 * a conservative size heuristic before download/transcription; a 5-minute
 * 256 kbps audio file is roughly 10 MiB, so 12 MiB leaves room for container
 * overhead without letting obviously long compressed uploads through.
 */
const MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION = 12 * 1024 * 1024;

type AudioSource = 'voice' | 'audio' | 'video_note' | 'document';

export interface TelegramAudioAttachment {
  source: AudioSource;
  fileId: string;
  durationSec?: number;
  fileSize?: number;
  mimeType?: string;
  fallbackFilename: string;
}

interface AudioDropDecision {
  event: AuditEvent;
  reply: string;
}

export function extractAudioAttachment(m: TelegramMessage): TelegramAudioAttachment | null {
  if (m.voice) {
    return {
      source: 'voice',
      fileId: m.voice.file_id,
      durationSec: m.voice.duration,
      fileSize: m.voice.file_size,
      mimeType: m.voice.mime_type ?? 'audio/ogg',
      fallbackFilename: 'voice.oga',
    };
  }
  if (m.audio) {
    return {
      source: 'audio',
      fileId: m.audio.file_id,
      durationSec: m.audio.duration,
      fileSize: m.audio.file_size,
      mimeType: m.audio.mime_type,
      fallbackFilename: m.audio.file_name ?? 'audio',
    };
  }
  if (m.video_note) {
    return {
      source: 'video_note',
      fileId: m.video_note.file_id,
      durationSec: m.video_note.duration,
      fileSize: m.video_note.file_size,
      mimeType: 'video/mp4',
      fallbackFilename: 'video-note.mp4',
    };
  }
  if (m.document?.mime_type?.startsWith('audio/')) {
    return {
      source: 'document',
      fileId: m.document.file_id,
      fileSize: m.document.file_size,
      mimeType: m.document.mime_type,
      fallbackFilename: m.document.file_name ?? 'document-audio',
    };
  }
  return null;
}

export function filenameFromFilePath(filePath: string, fallback: string): string {
  return filePath.split('/').pop() || fallback;
}

export function audioDropDecision(audio: TelegramAudioAttachment, bytes?: number): AudioDropDecision | null {
  if (typeof audio.durationSec === 'number' && audio.durationSec > MAX_AUDIO_SECONDS) {
    return {
      event: { kind: 'dropped_audio_too_long', source: audio.source, durationSec: audio.durationSec },
      reply: `Audio too long (${audio.durationSec}s). Cap is ${MAX_AUDIO_SECONDS}s — please type.`,
    };
  }
  if (typeof bytes !== 'number') {
    return null;
  }
  if (bytes > MAX_AUDIO_BYTES) {
    return {
      event: { kind: 'dropped_audio_too_large', source: audio.source, bytes, durationSec: audio.durationSec },
      reply: `Audio payload too large (${bytes} bytes). Cap is ${MAX_AUDIO_BYTES} bytes — please type.`,
    };
  }
  if (
    audio.source === 'document' &&
    audio.durationSec === undefined &&
    bytes > MAX_AUDIO_DOCUMENT_BYTES_WITHOUT_DURATION
  ) {
    return {
      event: {
        kind: 'dropped_audio_too_long',
        source: audio.source,
        bytes,
        estimatedFromBytes: true,
      },
      reply: `Audio document may be too long (${bytes} bytes). Cap is ${MAX_AUDIO_SECONDS}s — please type.`,
    };
  }
  return null;
}
