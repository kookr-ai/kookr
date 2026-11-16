/**
 * The spoken clips that are audible right now, so Lucy's hands-free conversation
 * (`lucy-live/lucy-live-session.ts`) can treat them as Lucy talking (issue #3672).
 *
 * A clip is anything Lucy says outside the hands-free conversation: a speaker
 * button's summary (`hooks/useSpeakAgent.ts`), a Replay, or a question read
 * aloud (both through `clip-playback.ts`). Each one registers here for as long as
 * it is audible and hands over two controls: its volume and a stop.
 *
 * With Talk on, the session uses them like its own audio: a sound that may be the
 * operator turns the clips down while the server checks it, a confirmed
 * interruption stops them, a rejected one turns them back up. With Talk off no
 * session exists, so nothing reads this list and clips play exactly as before.
 *
 * Overlap between a clip and a hands-free answer follows one rule: a clip that
 * starts stops the answer she is saying (the operator asked for the clip last),
 * and an answer that becomes ready while a clip plays waits for it to end. The
 * session registers {@link setAnswerYield} for the first half and listens with
 * {@link subscribePlayingClips} for the second.
 *
 * This module only keeps the list: it creates no audio and opens no microphone.
 */

/** Why a clip was stopped from outside its own player. */
export type ClipStopReason = 'barge_in';

export interface PlayingClip {
  /** Move the clip's volume to `gain` (1 is full) over a short ramp. */
  setVolume(gain: number): void;
  /** Stop the clip for good. Its player records why and announces the end. */
  stop(reason: ClipStopReason): void;
}

/** Time a clip's volume takes to move between full and turned down, in seconds; the same as for a hands-free answer. */
export const CLIP_VOLUME_RAMP_S = 0.03;

const playing = new Set<PlayingClip>();
const listeners = new Set<() => void>();
let answerYield: (() => void) | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.warn('[kookr.playing-clips] listener failed', err);
    }
  }
}

/**
 * Call once the clip is audible. Stops whatever hands-free answer she is saying
 * first, so the two never play together. Returns the function to call when the
 * clip ends, however it ends; calling it more than once is harmless.
 */
export function clipStarted(clip: PlayingClip): () => void {
  try {
    answerYield?.();
  } catch (err) {
    console.warn('[kookr.playing-clips] answer yield failed', err);
  }
  playing.add(clip);
  notify();
  return () => {
    if (playing.delete(clip)) notify();
  };
}

/** The clips audible right now. */
export function playingClips(): readonly PlayingClip[] {
  return [...playing];
}

/** Called whenever a clip starts or ends. Returns an unsubscribe function. */
export function subscribePlayingClips(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The hands-free session registers what to do when a clip is about to start: stop
 * the answer it is saying. Returns a function that removes it again (only if it is
 * still the registered one).
 */
export function setAnswerYield(fn: () => void): () => void {
  answerYield = fn;
  return () => {
    if (answerYield === fn) answerYield = null;
  };
}

/** Ramp `node` to `target` over {@link CLIP_VOLUME_RAMP_S}, from wherever it is now. */
export function rampClipVolume(node: GainNode, context: Pick<BaseAudioContext, 'currentTime'>, target: number): void {
  const gain = node.gain;
  const now = context.currentTime;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(gain.value, now);
  gain.linearRampToValueAtTime(target, now + CLIP_VOLUME_RAMP_S);
}

export function __resetPlayingClipsForTests(): void {
  playing.clear();
  listeners.clear();
  answerYield = null;
}
