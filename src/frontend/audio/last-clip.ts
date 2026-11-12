/**
 * Remembers the most recent spoken clips, so the operator can hear them again.
 *
 * Why it exists: Lucy speaks when a speaker button is pressed, and by herself
 * when a task asks the operator a question (`ask-announcement.ts`). Either way
 * the operator may have looked away, had the tab in the background, or had the
 * browser refuse to start audio. Without this, a clip that nobody heard is gone.
 *
 * The last {@link MAX_CLIP_HISTORY} clips are kept (bounded memory: a clip that
 * falls off the end takes its audio with it), newest first, and only in memory:
 * a page reload forgets them. A clip is "heard" once the operator could actually
 * have listened to it (see `clip-playback.ts`); until then the avatar panel shows
 * an "unheard" marker.
 */
import { useSyncExternalStore } from 'react';

/** How many clips are remembered; older ones are dropped together with their audio. */
export const MAX_CLIP_HISTORY = 3;

export interface LastClip {
  /** Joins this clip with the server record and the `lucy_*` telemetry events. */
  clipId: string;
  /** What was spoken. */
  text: string;
  /**
   * Display title of the task the message was about, as sent by the server (already redacted, one line).
   * Untrusted display text: render it as text only. Absent when the task had no title.
   */
  subject?: string;
  /** When the clip arrived (epoch milliseconds). */
  at: number;
  /** The encoded audio (a WAV file) exactly as received; decoded again for each replay. */
  audio: ArrayBuffer;
  /** Length of the audio as reported by the server; 0 when unknown. */
  durationMs: number;
  /** True once the clip was played (nearly) to the end while the tab was visible. */
  heard: boolean;
}

/** What the panel needs to render one remembered clip: everything except the audio. */
export interface ClipHistoryItem {
  clipId: string;
  text: string;
  subject?: string;
  at: number;
  heard: boolean;
}

/** What the avatar panel needs to know; deliberately small so it re-renders rarely. */
export interface LastClipSnapshot {
  hasClip: boolean;
  /** At least one remembered clip has not been heard yet. */
  unheard: boolean;
  /** How many remembered clips have not been heard yet. */
  unheardCount: number;
}

const EMPTY_SNAPSHOT: LastClipSnapshot = { hasClip: false, unheard: false, unheardCount: 0 };
const EMPTY_HISTORY: readonly ClipHistoryItem[] = Object.freeze([]);

/** Newest first. Never holds more than {@link MAX_CLIP_HISTORY} entries. */
let clips: LastClip[] = [];
let snapshot: LastClipSnapshot = EMPTY_SNAPSHOT;
let history: readonly ClipHistoryItem[] = EMPTY_HISTORY;
const listeners = new Set<() => void>();

function publish(): void {
  const unheardCount = clips.reduce((n, c) => (c.heard ? n : n + 1), 0);
  if (clips.length === 0) {
    snapshot = EMPTY_SNAPSHOT;
    history = EMPTY_HISTORY;
  } else {
    // Keep the old object when nothing the panel looks at changed, so it does not re-render for nothing.
    if (snapshot.unheardCount !== unheardCount || !snapshot.hasClip) {
      snapshot = { hasClip: true, unheard: unheardCount > 0, unheardCount };
    }
    history = Object.freeze(
      clips.map((c) => ({
        clipId: c.clipId,
        text: c.text,
        ...(c.subject ? { subject: c.subject } : {}),
        at: c.at,
        heard: c.heard,
      })),
    );
  }
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
  /** See {@link LastClip.subject}; blank or missing means no subject. */
  subject?: string | null;
  audio: ArrayBuffer;
  durationMs?: number;
}

/**
 * Remember a clip that just arrived as the newest one. It starts out unheard.
 * The oldest clip is dropped when more than {@link MAX_CLIP_HISTORY} would be kept.
 */
export function captureLastClip(input: CaptureClipInput): LastClip {
  const clipId = input.clipId || newLocalClipId();
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  const clip: LastClip = {
    clipId,
    text: input.text,
    ...(subject ? { subject } : {}),
    at: Date.now(),
    audio: input.audio,
    durationMs: input.durationMs && input.durationMs > 0 ? input.durationMs : 0,
    heard: false,
  };
  clips = [clip, ...clips.filter((c) => c.clipId !== clipId)].slice(0, MAX_CLIP_HISTORY);
  publish();
  return clip;
}

/** The newest remembered clip. */
export function getLastClip(): LastClip | null {
  return clips[0] ?? null;
}

/** A remembered clip by id, or null when it never existed or has fallen off the end of the history. */
export function getClip(clipId: string): LastClip | null {
  return clips.find((c) => c.clipId === clipId) ?? null;
}

/** Mark a remembered clip heard. Ignored when `clipId` is not (or no longer) in the history. */
export function markClipHeard(clipId: string): void {
  const index = clips.findIndex((c) => c.clipId === clipId);
  if (index < 0 || clips[index].heard) return;
  clips = clips.map((c, i) => (i === index ? { ...c, heard: true } : c));
  publish();
}

/** Forget one clip, e.g. when its audio turned out to be undecodable. Ignored when it is not in the history. */
export function discardLastClip(clipId: string): void {
  if (!clips.some((c) => c.clipId === clipId)) return;
  clips = clips.filter((c) => c.clipId !== clipId);
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

export function getClipHistory(): readonly ClipHistoryItem[] {
  return history;
}

/** React binding: re-renders only when the presence or the unheard count changes. */
export function useLastClip(): LastClipSnapshot {
  return useSyncExternalStore(subscribeLastClip, getLastClipSnapshot, () => EMPTY_SNAPSHOT);
}

/** React binding for the list: the remembered clips, newest first, without their audio. */
export function useClipHistory(): readonly ClipHistoryItem[] {
  return useSyncExternalStore(subscribeLastClip, getClipHistory, () => EMPTY_HISTORY);
}

export function __resetLastClipForTests(): void {
  clips = [];
  snapshot = EMPTY_SNAPSHOT;
  history = EMPTY_HISTORY;
  listeners.clear();
  localSeq = 0;
}
