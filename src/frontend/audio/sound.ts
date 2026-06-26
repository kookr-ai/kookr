import {
  getClientAudioIdentity,
  recordAudioAlertDecision,
  redactAudioAlertDecision,
  updateAudioAlertDecision,
  type AudioAlertContext,
  type AudioAlertOutcome,
  type LocalAudioAlertDecision,
} from './audio-alert-log.js';
import {
  __resetSoundPreferenceForTests,
  isAudibleAlertEnabled,
  type ChimeSound,
  getSoundPreferenceState,
  isSoundEnabled,
  setChimeSound,
  setSoundEnabled,
  setSoundVolume,
  useSoundPreference,
} from './sound-preference.js';
import { getDndState } from '../hooks/useDnd.js';

export {
  __resetSoundPreferenceForTests,
  getSoundPreferenceState,
  isAudibleAlertEnabled,
  isSoundEnabled,
  setChimeSound,
  setSoundEnabled,
  setSoundVolume,
  useSoundPreference,
};

let warnedRejection = false;
let decisionSeq = 0;

interface AudioScheduleMetadata {
  audioContextInitialState?: AudioContextState;
  audioContextFinalState?: AudioContextState;
  resumeAttempted?: boolean;
  resumeFailed?: boolean;
  audioVolume?: number;
  chimeSound?: ChimeSound;
}

interface AudioScheduleResult {
  metadata: AudioScheduleMetadata;
  resumePromise?: Promise<void>;
  getFinalState: () => AudioContextState;
}

interface ChimeOptions {
  audible?: boolean;
}

interface ChimeTone {
  frequency: number;
  start: number;
  duration: number;
  gain: number;
  type: OscillatorType;
}

const CHIME_PROFILES: Record<ChimeSound, readonly ChimeTone[]> = {
  classic: [
    { frequency: 880, start: 0, duration: 0.3, gain: 0.3, type: 'sine' },
    { frequency: 1109, start: 0.15, duration: 0.35, gain: 0.25, type: 'sine' },
  ],
  soft: [
    { frequency: 660, start: 0, duration: 0.28, gain: 0.18, type: 'sine' },
    { frequency: 880, start: 0.18, duration: 0.32, gain: 0.15, type: 'triangle' },
  ],
  urgent: [
    { frequency: 988, start: 0, duration: 0.18, gain: 0.32, type: 'square' },
    { frequency: 1319, start: 0.12, duration: 0.2, gain: 0.28, type: 'square' },
    { frequency: 988, start: 0.28, duration: 0.2, gain: 0.24, type: 'square' },
  ],
};

function nextDecisionId(): string {
  decisionSeq += 1;
  return `audio-alert-${Date.now().toString(36)}-${decisionSeq}`;
}

function getPageVisibility(): DocumentVisibilityState {
  if (typeof document === 'undefined') return 'visible';
  return document.visibilityState;
}

function getDocumentHasFocus(): boolean {
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return false;
  return document.hasFocus();
}

function makeDecision(
  context: AudioAlertContext,
  outcome: AudioAlertOutcome,
  reason: string,
  audio: AudioScheduleMetadata = {},
): LocalAudioAlertDecision {
  const soundState = getSoundPreferenceState();
  const dndState = getDndState();
  const identity = getClientAudioIdentity();
  return {
    ...context,
    id: nextDecisionId(),
    timestamp: new Date().toISOString(),
    outcome,
    reason,
    soundEnabled: soundState.enabled,
    soundStateSource: soundState.source,
    soundStorageAvailable: soundState.storageAvailable,
    dndEnabled: dndState.enabled,
    dndExpiresAt: dndState.expiresAt,
    pageVisibility: getPageVisibility(),
    documentHasFocus: getDocumentHasFocus(),
    clientSessionId: identity.clientSessionId,
    clientTabId: identity.clientTabId,
    audioVolume: soundState.volume,
    chimeSound: soundState.chimeSound,
    ...audio,
  };
}

function emitDecision(decision: LocalAudioAlertDecision): LocalAudioAlertDecision {
  const isNewEntry = recordAudioAlertDecision(decision);
  if (isNewEntry) {
    console.debug('[kookr.audio]', redactAudioAlertDecision(decision));
  }
  return decision;
}

function markResumeRejected(decision: LocalAudioAlertDecision, err: unknown, finalState?: AudioContextState): void {
  if (!warnedRejection) {
    warnedRejection = true;
    console.warn('[kookr] AudioContext resume rejected; chime may be silent', err);
  }
  const updated = updateAudioAlertDecision(decision.id, {
    outcome: 'audio_context_error',
    reason: 'audio_context_resume_error',
    resumeFailed: true,
    ...(finalState ? { audioContextFinalState: finalState } : {}),
  });
  if (updated) {
    console.debug('[kookr.audio]', redactAudioAlertDecision(updated));
  }
}

function scheduleChime(volume: number, chimeSound: ChimeSound): AudioScheduleResult {
  const ctx = new AudioContext();
  const initialState = ctx.state;
  const now = ctx.currentTime;
  const tones = CHIME_PROFILES[chimeSound];
  let closeDelayMs = 600;

  for (const tone of tones) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    const startAt = now + tone.start;
    const stopAt = startAt + tone.duration;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.frequency.value = tone.frequency;
    oscillator.type = tone.type;
    gain.gain.setValueAtTime(tone.gain * volume, startAt);
    gain.gain.exponentialRampToValueAtTime(0.001, stopAt);
    oscillator.start(startAt);
    oscillator.stop(stopAt);
    closeDelayMs = Math.max(closeDelayMs, Math.ceil((tone.start + tone.duration) * 1000) + 100);
  }

  let resumeAttempted = false;
  let resumePromise: Promise<void> | undefined;
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    resumeAttempted = true;
    resumePromise = ctx.resume();
  }

  setTimeout(() => void ctx.close(), closeDelayMs);

  return {
    metadata: {
      audioContextInitialState: initialState,
      audioContextFinalState: ctx.state,
      resumeAttempted,
      resumeFailed: false,
      audioVolume: volume,
      chimeSound,
    },
    resumePromise,
    getFinalState: () => ctx.state,
  };
}

/**
 * Record a chime that was suppressed by caller-side rate limiting (e.g. the
 * cross-agent minimum chime interval in useAudibleAlert) without producing
 * sound. Keeps "a finding arrived but made no noise" diagnosable in the same
 * decision log the chime path uses.
 */
export function recordChimeSuppression(
  context: AudioAlertContext,
  reason: string,
): LocalAudioAlertDecision {
  return emitDecision(makeDecision(context, 'suppressed_rate_limited', reason));
}

/**
 * Single public production entry point for the chime. It records a local
 * decision for every attempted alert so operators can diagnose why Kookr made
 * noise, or why an alert was suppressed, without opening devtools.
 */
export function maybePlayChime(
  context: AudioAlertContext = { source: 'manual_test', reason: 'legacy_chime_call' },
  options: ChimeOptions = {},
): LocalAudioAlertDecision {
  const soundState = getSoundPreferenceState();
  if (!soundState.enabled) {
    return emitDecision(makeDecision(context, 'suppressed_muted', 'sound disabled'));
  }

  if (!isAudibleAlertEnabled(soundState)) {
    return emitDecision(makeDecision(context, 'suppressed_muted', 'sound volume 0'));
  }

  const dndState = getDndState();
  if (dndState.enabled) {
    return emitDecision(makeDecision(context, 'suppressed_dnd', 'do not disturb enabled'));
  }

  if (options.audible === false) {
    return emitDecision(makeDecision(context, 'suppressed_debounced', 'audible cue debounced'));
  }

  if (typeof AudioContext === 'undefined') {
    return emitDecision(makeDecision(context, 'audio_context_unavailable', 'AudioContext unavailable'));
  }

  try {
    const audio = scheduleChime(soundState.volume, soundState.chimeSound);
    const decision = emitDecision(makeDecision(context, 'scheduled', context.reason, audio.metadata));
    if (audio.resumePromise) {
      void audio.resumePromise
        .then(() => {
          updateAudioAlertDecision(decision.id, {
            audioContextFinalState: audio.getFinalState(),
            resumeFailed: false,
          });
        })
        .catch((err: unknown) => {
          markResumeRejected(decision, err, audio.getFinalState());
        });
    }
    return decision;
  } catch (err) {
    if (!warnedRejection) {
      warnedRejection = true;
      console.warn('[kookr] AudioContext rejected; chime suppressed', err);
    }
    return emitDecision(makeDecision(context, 'audio_context_error', 'audio_context_error'));
  }
}
