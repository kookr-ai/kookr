/**
 * Remembers the most recent spoken clip, so the operator can hear it again.
 *
 * Why it exists: Lucy only speaks when a speaker button is pressed, but the
 * operator may have looked away, had the tab in the background, or had the
 * browser refuse to start audio. Without this, a clip that nobody heard is gone.
 *
 * Only the latest clip is kept (bounded memory), and only in memory: a page
 * reload forgets it. A clip is "heard" once the operator could actually have
 * listened to it (see `clip-playback.ts`); until then the avatar panel shows an
 * "unheard" marker.
 */
import { useSyncExternalStore } from 'react';

export interface LastClip {
  /** Joins this clip with the server record and the `lucy_*` telemetry events. */
  clipId: string;
  /** What was spoken (the caption). */
  text: string;
  /** The encoded audio (a WAV file) exactly as received; decoded again for each replay. */
  audio: ArrayBuffer;
  /** Length of the audio as reported by the server; 0 when unknown. */
  durationMs: number;
  /** True once the clip was played (nearly) to the end while the tab was visible. */
  heard: boolean;
}

/** What the avatar panel needs to know; deliberately small so it re-renders rarely. */
export interface LastClipSnapshot {
  hasClip: boolean;
  /** There is a clip and nobody has heard it yet. */
  unheard: boolean;
}

const EMPTY_SNAPSHOT: LastClipSnapshot = { hasClip: false, unheard: false };

let clip: LastClip | null = null;
let snapshot: LastClipSnapshot = EMPTY_SNAPSHOT;
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = clip ? { hasClip: true, unheard: !clip.heard } : EMPTY_SNAPSHOT;
  for (const listener of listeners) listener();
}

let localSeq = 0;
/** Used when the server did not send a clip id (older server). */
export function newLocalClipId(): string {
  localSeq += 1;
  return `local-${Date.now().toString(36)}-${localSeq}`;
}

export interface CaptureClipInput {
  clipId?: string | null;
  text: string;
  audio: ArrayBuffer;
  durationMs?: number;
}

/** Remember a clip that just arrived, replacing the previous one. It starts out unheard. */
export function captureLastClip(input: CaptureClipInput): LastClip {
  clip = {
    clipId: input.clipId || newLocalClipId(),
    text: input.text,
    audio: input.audio,
    durationMs: input.durationMs && input.durationMs > 0 ? input.durationMs : 0,
    heard: false,
  };
  publish();
  return clip;
}

export function getLastClip(): LastClip | null {
  return clip;
}

/** Mark the clip heard. Ignored when `clipId` is not the latest clip (a newer one replaced it). */
export function markClipHeard(clipId: string): void {
  if (!clip || clip.clipId !== clipId || clip.heard) return;
  clip = { ...clip, heard: true };
  publish();
}

/** Forget the clip, e.g. when its audio turned out to be undecodable. Ignored for a different clip id. */
export function discardLastClip(clipId: string): void {
  if (!clip || clip.clipId !== clipId) return;
  clip = null;
  publish();
}

export function subscribeLastClip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLastClipSnapshot(): LastClipSnapshot {
  return snapshot;
}

/** React binding: re-renders only when the presence or unheard flag changes. */
export function useLastClip(): LastClipSnapshot {
  return useSyncExternalStore(subscribeLastClip, getLastClipSnapshot, () => EMPTY_SNAPSHOT);
}

export function __resetLastClipForTests(): void {
  clip = null;
  snapshot = EMPTY_SNAPSHOT;
  listeners.clear();
  localSeq = 0;
}
