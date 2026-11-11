/**
 * A tiny publish/subscribe channel announcing what Kookr's speech playback is
 * doing, so something else on the page (the optional avatar panel) can react:
 * show "thinking" while a spoken summary is being generated, move its mouth
 * while the clip plays, and show the spoken text as a caption.
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
  | { type: 'playing'; analyser: AnalyserNode | null; text: string | null; durationMs: number | null }
  /** Playback finished, failed or was cancelled. */
  | { type: 'idle' };

export type SpeechBusListener = (event: SpeechBusEvent) => void;

const listeners = new Set<SpeechBusListener>();
let last: SpeechBusEvent = { type: 'idle' };

/** Subscribe; the listener immediately receives the current state. Returns an unsubscribe function. */
export function subscribeSpeechBus(listener: SpeechBusListener): () => void {
  listeners.add(listener);
  listener(last);
  return () => {
    listeners.delete(listener);
  };
}

export function hasSpeechBusListeners(): boolean {
  return listeners.size > 0;
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

export function emitSpeechGenerating(): void {
  if (last.type === 'generating') return;
  emit({ type: 'generating' });
}

/**
 * Announce that `source` started playing on `ctx`. When someone is listening,
 * a silent AnalyserNode is attached to the source (it is not connected to the
 * speakers, so it cannot change what the operator hears).
 */
export function emitSpeechPlaying(
  ctx: Pick<AudioContext, 'createAnalyser'>,
  source: Pick<AudioNode, 'connect'>,
  meta: { text?: string | null; durationMs?: number | null } = {},
): void {
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
  emit({
    type: 'playing',
    analyser,
    text: meta.text ?? null,
    durationMs: meta.durationMs ?? null,
  });
}

export function emitSpeechIdle(): void {
  if (last.type === 'idle') return;
  emit({ type: 'idle' });
}

export function __resetSpeechBusForTests(): void {
  listeners.clear();
  last = { type: 'idle' };
}
