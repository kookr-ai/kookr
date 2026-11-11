/**
 * A tiny publish/subscribe channel announcing what Kookr's speech playback is
 * doing, so something else on the page (the optional avatar panel) can react:
 * show "thinking" while a spoken summary is being generated, move its mouth
 * while the clip plays.
 *
 * Playback itself stays where it was (`useSpeakAgent`). The bus only observes.
 * With no subscriber it does nothing at all — in particular it creates no
 * audio nodes — so the feature costs nothing when the avatar panel is off.
 */

export type SpeechBusEvent =
  /** A spoken summary was requested and is being generated (LLM + TTS round trip). */
  | { type: 'generating' }
  /**
   * A clip started playing. `analyser` taps the clip's audio so a listener can
   * read its loudness; it is null when the tap could not be created.
   */
  | { type: 'playing'; analyser: AnalyserNode | null }
  /** Playback finished, failed or was cancelled. */
  | { type: 'idle' };

type SpeechBusListener = (event: SpeechBusEvent) => void;

const listeners = new Set<SpeechBusListener>();
let last: SpeechBusEvent = { type: 'idle' };
/**
 * Who made the latest generating/playing announcement. Several speaker buttons
 * exist at once, each with its own playback; only the one that is currently
 * speaking may announce the end, so a different button being stopped or removed
 * cannot cut the avatar off in the middle of someone else's clip.
 */
let owner: object | null = null;

/** Subscribe; the listener immediately receives the current state. Returns an unsubscribe function. */
export function subscribeSpeechBus(listener: SpeechBusListener): () => void {
  listeners.add(listener);
  listener(last);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: SpeechBusEvent): void {
  last = event;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      // A broken listener must never break speech playback.
      console.warn('[kookr.speech-bus] listener failed', err);
    }
  }
}

/** `by` identifies the caller (any object it keeps for its lifetime); see `owner` above. */
export function emitSpeechGenerating(by: object): void {
  owner = by;
  if (last.type === 'generating') return;
  emit({ type: 'generating' });
}

/**
 * Announce that `source` started playing on `ctx`. When someone is listening,
 * a silent AnalyserNode is attached to the source (it is not connected to the
 * speakers, so it cannot change what the operator hears).
 */
export function emitSpeechPlaying(
  by: object,
  ctx: Pick<AudioContext, 'createAnalyser'>,
  source: Pick<AudioNode, 'connect'>,
): void {
  owner = by;
  let analyser: AnalyserNode | null = null;
  if (listeners.size > 0) {
    try {
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
    } catch {
      analyser = null;
    }
  }
  emit({ type: 'playing', analyser });
}

/** Announce that `by` is no longer speaking. Ignored unless `by` made the latest announcement. */
export function emitSpeechIdle(by: object): void {
  if (owner !== by) return;
  owner = null;
  if (last.type === 'idle') return;
  emit({ type: 'idle' });
}

export function __resetSpeechBusForTests(): void {
  listeners.clear();
  last = { type: 'idle' };
  owner = null;
}
