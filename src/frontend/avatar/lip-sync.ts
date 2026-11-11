/**
 * Mouth animation driven by loudness.
 *
 * Kookr's speech service returns a finished audio clip with no timing for
 * individual sounds, so the avatar cannot know which sound is being spoken.
 * Instead it reads how loud the clip is right now and opens the mouth in
 * proportion, switching between mouth shapes at a syllable-like rhythm. The
 * result reads as speech, but it is not phoneme-accurate lip-sync.
 */

/** Mouth shapes ("visemes") present on the avatar's face mesh, in the Oculus naming used by Ready Player Me rigs. */
export const SPEECH_VISEMES = [
  'viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O', 'viseme_U',
  'viseme_PP', 'viseme_FF', 'viseme_DD', 'viseme_kk', 'viseme_SS',
  'viseme_nn', 'viseme_RR', 'viseme_CH', 'viseme_TH',
] as const;

type SpeechViseme = (typeof SPEECH_VISEMES)[number];

/**
 * Root-mean-square loudness of an audio frame, mapped to 0..1.
 * `samples` are unsigned bytes centred on 128, as returned by
 * `AnalyserNode.getByteTimeDomainData`.
 */
export function loudnessFromTimeDomain(samples: ArrayLike<number>, gain = 5.5): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.max(0, Math.min(1, Math.sqrt(sum / n) * gain));
}

/** Deterministic pseudo-random generator (Park-Miller), so tests and renders are repeatable. */
export function createRng(seed = 99): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

interface LipSyncState {
  /** Smoothed loudness, 0..1. */
  amp: number;
  /** The mouth shape currently being formed. */
  viseme: SpeechViseme;
  /** Seconds left before the next mouth shape is chosen. */
  syllableLeft: number;
  /** Current weight of each mouth shape, 0..1. */
  weights: Record<SpeechViseme, number>;
}

export function createLipSyncState(): LipSyncState {
  const weights = {} as Record<SpeechViseme, number>;
  for (const v of SPEECH_VISEMES) weights[v] = 0;
  return { amp: 0, viseme: 'viseme_aa', syllableLeft: 0, weights };
}

/** Frame-rate independent smoothing factor: how far to move toward a target in `dt` seconds. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Advance the mouth by `dt` seconds toward `loudness` (0..1, 0 when silent).
 * Mutates and returns `state`. A new mouth shape is picked every 80-200 ms
 * while there is sound; in silence every shape relaxes back to closed.
 */
export function stepLipSync(
  state: LipSyncState,
  loudness: number,
  dt: number,
  rng: () => number,
): LipSyncState {
  const target = Math.max(0, Math.min(1, loudness));
  state.amp += (target - state.amp) * damp(18, dt);
  if (target > 0.04) {
    state.syllableLeft -= dt;
    if (state.syllableLeft <= 0) {
      state.syllableLeft = 0.08 + rng() * 0.12;
      state.viseme = SPEECH_VISEMES[Math.floor(rng() * SPEECH_VISEMES.length) % SPEECH_VISEMES.length];
    }
  }
  for (const v of SPEECH_VISEMES) {
    const goal = v === state.viseme ? state.amp : 0;
    state.weights[v] += (goal - state.weights[v]) * damp(20, dt);
  }
  return state;
}
