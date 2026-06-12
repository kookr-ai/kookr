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
  getSoundPreferenceState,
  isSoundEnabled,
  setSoundEnabled,
  useSoundPreference,
} from './sound-preference.js';
import { getDndState } from '../hooks/useDnd.js';

export {
  __resetSoundPreferenceForTests,
  getSoundPreferenceState,
  isSoundEnabled,
  setSoundEnabled,
  useSoundPreference,
};

let warnedRejection = false;
let decisionSeq = 0;

interface AudioScheduleMetadata {
  audioContextInitialState?: AudioContextState;
  audioContextFinalState?: AudioContextState;
  resumeAttempted?: boolean;
  resumeFailed?: boolean;
}

interface AudioScheduleResult {
  metadata: AudioScheduleMetadata;
  resumePromise?: Promise<void>;
  getFinalState: () => AudioContextState;
}

interface ChimeOptions {
  audible?: boolean;
}

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

function scheduleChime(): AudioScheduleResult {
  const ctx = new AudioContext();
  const initialState = ctx.state;
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.connect(gain1);
  gain1.connect(ctx.destination);
  osc1.frequency.value = 880;
  osc1.type = 'sine';
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc1.start(now);
  osc1.stop(now + 0.3);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.connect(gain2);
  gain2.connect(ctx.destination);
  osc2.frequency.value = 1109;
  osc2.type = 'sine';
  gain2.gain.setValueAtTime(0.25, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.5);

  let resumeAttempted = false;
  let resumePromise: Promise<void> | undefined;
  if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
    resumeAttempted = true;
    resumePromise = ctx.resume();
  }

  setTimeout(() => void ctx.close(), 600);

  return {
    metadata: {
      audioContextInitialState: initialState,
      audioContextFinalState: ctx.state,
      resumeAttempted,
      resumeFailed: false,
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
    const audio = scheduleChime();
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
