import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recordAudioAlertDecision,
  redactAudioAlertDecision,
  updateAudioAlertDecision,
  getClientAudioIdentity,
  type AudioAlertContext,
  type AudioAlertOutcome,
  type LocalAudioAlertDecision,
  type SpeakStatus,
} from '../audio/audio-alert-log.js';
import { getSoundPreferenceState } from '../audio/sound-preference.js';
import { getDndState } from './useDnd.js';
import type {
  SpeakAgentErrorResponse,
  SpeakAgentRequest,
  SpeakAgentResponse,
  VerbosityScale,
} from '../../shared/contracts/speech.js';
import type { SpeakFindingTimings } from '../speech-presentation.js';

export type { SpeakStatus };

export interface SpeakAgentHookState {
  status: SpeakStatus;
  errorReason?: string;
  cached?: boolean;
  timings?: SpeakFindingTimings;
}

interface SpeakAgentDeps {
  /** Test seam. */
  fetcher?: typeof fetch;
}

const DEFAULT_VERBOSITY: VerbosityScale = 'medium';
const CLIENT_TIMEOUT_MS = 20_000;

// Module-level snapshot of the user's effective verbosity preference.
// App.tsx loads it from /api/settings at startup; the SettingsDialog
// refreshes it via onSettingsSaved. Falls back to DEFAULT_VERBOSITY before
// the first load completes.
let currentSpeakVerbosity: VerbosityScale | null = null;

export function setSpeakVerbositySnapshot(value: VerbosityScale | undefined | null): void {
  currentSpeakVerbosity = value ?? null;
}

export function getSpeakVerbositySnapshot(): VerbosityScale {
  return currentSpeakVerbosity ?? DEFAULT_VERBOSITY;
}

let decisionSeq = 0;
function nextDecisionId(): string {
  decisionSeq += 1;
  return `finding-speak-${Date.now().toString(36)}-${decisionSeq}`;
}

function getPageVisibility(): DocumentVisibilityState {
  if (typeof document === 'undefined') return 'visible';
  return document.visibilityState;
}

function getDocumentHasFocus(): boolean {
  if (typeof document === 'undefined' || typeof document.hasFocus !== 'function') return false;
  return document.hasFocus();
}

function logDecision(
  context: AudioAlertContext,
  outcome: AudioAlertOutcome,
  reason: string,
  extra: Partial<LocalAudioAlertDecision> = {},
): LocalAudioAlertDecision {
  const soundState = getSoundPreferenceState();
  const dndState = getDndState();
  const identity = getClientAudioIdentity();
  const decision: LocalAudioAlertDecision = {
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
    ...extra,
  };
  const isNewEntry = recordAudioAlertDecision(decision);
  if (isNewEntry) {
    console.debug('[kookr.audio]', redactAudioAlertDecision(decision));
  }
  return decision;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const len = binary.length;
  const buf = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

interface UseSpeakAgentArgs {
  agentId: string | null;
  /** Anomaly type for telemetry/log context. */
  anomalyType: string | null;
  /** Whether the server advertises ttsUrl. Drives the toast vs. fetch decision. */
  ttsAvailable: boolean;
  endpoint?: string | null;
}

export interface UseSpeakAgentReturn {
  state: SpeakAgentHookState;
  /** Toggles: starts if idle, stops if playing/generating. */
  speak: () => void;
  /** Force-stop and reset to idle. */
  stop: () => void;
}

/**
 * Owns the speak-agent lifecycle for the currently-selected agent.
 *
 * Fetch + audio decode + playback live here. Suppression + decision logging go
 * through audio-alert-log (same channel as `maybePlayChime` — search for
 * source: 'finding_speak' to find this hook's records). The literal stays
 * `'finding_speak'` per RFC D12 to keep historical telemetry coherent.
 */
export function useSpeakAgent(
  args: UseSpeakAgentArgs,
  deps: SpeakAgentDeps = {},
): UseSpeakAgentReturn {
  const { agentId, anomalyType, ttsAvailable, endpoint } = args;
  const fetcher = deps.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const [state, setState] = useState<SpeakAgentHookState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearClientTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    clearClientTimeout();
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (ctxRef.current && ctxRef.current.state !== 'closed') {
      void ctxRef.current.close();
      ctxRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [clearClientTimeout]);

  const stop = useCallback(() => {
    cleanup();
    setState({ status: 'idle' });
  }, [cleanup]);

  // Cancel any in-flight work when the selected agent changes.
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [agentId, cleanup]);

  const speak = useCallback(() => {
    if (!agentId) return;
    const context: AudioAlertContext = {
      source: 'finding_speak',
      reason: 'speak_requested',
      agentId,
      anomalyType: anomalyType ?? undefined,
    };

    if (state.status === 'generating' || state.status === 'playing') {
      const abortedAtPhase: SpeakStatus = state.status;
      logDecision(context, 'audio_context_error', 'user_canceled', { abortedAtPhase });
      stop();
      return;
    }

    if (!ttsAvailable) {
      logDecision(context, 'audio_context_unavailable', 'tts_not_configured');
      setState({ status: 'error', errorReason: 'tts-not-configured' });
      return;
    }

    const soundState = getSoundPreferenceState();
    if (!soundState.enabled) {
      logDecision(context, 'suppressed_muted', 'sound disabled');
      setState({ status: 'suppressed', errorReason: 'sound-muted' });
      return;
    }
    const dnd = getDndState();
    if (dnd.enabled) {
      logDecision(context, 'suppressed_dnd', 'do not disturb enabled');
      setState({ status: 'suppressed', errorReason: 'dnd' });
      return;
    }
    if (typeof AudioContext === 'undefined') {
      logDecision(context, 'audio_context_unavailable', 'AudioContext unavailable');
      setState({ status: 'error', errorReason: 'audio-context-unavailable' });
      return;
    }

    // Retry paths from `suspended` / `error` leave the previous AudioContext
    // and any armed client timeout in place. Dispose them before starting a
    // new attempt so we never stack two AudioContexts or have a stale timer
    // fire against the new request.
    cleanup();

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logDecision(context, 'audio_context_error', `context_failed:${reason.slice(0, 80)}`);
      setState({ status: 'error', errorReason: 'audio-context-error' });
      return;
    }

    ctxRef.current = ctx;
    const audioContextInitialState = ctx.state;
    let resumeAttempted = false;
    let resumeFailed = false;
    let resumeError: unknown = null;
    let unlockPromise: Promise<void> | undefined;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      // Browser autoplay policy ties resume() to the click's transient user
      // activation, so start unlocking before the slow TTS request.
      resumeAttempted = true;
      unlockPromise = ctx.resume().catch((err: unknown) => {
        resumeFailed = true;
        resumeError = err;
      });
    }

    const ac = new AbortController();
    abortRef.current = ac;
    const requestStartedAt = nowMs();
    setState({ status: 'generating' });

    // Guard the client timeout: if the user kicks off a new speak (or stops
    // the hook), `cleanup()` aborts the old `ac` and the next `speak()` clears
    // `timeoutRef.current`. The callback below verifies the timer is still
    // the active one *and* the AbortController hasn't been retired before
    // taking action — that way a stale 20s timer can never sabotage a
    // subsequent request.
    const ownTimer = setTimeout(() => {
      if (timeoutRef.current !== ownTimer || abortRef.current !== ac) return;
      timeoutRef.current = null;
      if (ac.signal.aborted) return;
      logDecision(context, 'audio_context_error', 'timeout_client', { abortedAtPhase: 'generating' });
      cleanup();
      setState({ status: 'error', errorReason: 'timeout-client' });
    }, CLIENT_TIMEOUT_MS);
    timeoutRef.current = ownTimer;

    const verbosity = getSpeakVerbositySnapshot();
    const requestUrl = endpoint ?? `/api/agents/${encodeURIComponent(agentId)}/speak`;
    const requestBody: SpeakAgentRequest = { verbosity };

    void (async () => {
      let response: Response;
      try {
        response = await fetcher(requestUrl, {
          method: 'POST',
          signal: ac.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        logDecision(context, 'audio_context_error', `fetch_failed:${reason.slice(0, 80)}`);
        cleanup();
        setState({ status: 'error', errorReason: 'fetch-failed' });
        return;
      }

      if (ac.signal.aborted) return;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as SpeakAgentErrorResponse;
        const errorReason = body.error ?? 'http-error';
        logDecision(context, 'audio_context_error', `http_${response.status}:${errorReason}`);
        cleanup();
        setState({ status: 'error', errorReason });
        return;
      }

      const payload = (await response.json().catch(() => null)) as SpeakAgentResponse | null;
      const payloadReceivedAt = nowMs();
      if (ac.signal.aborted) return;
      if (!payload || typeof payload.audioBase64 !== 'string') {
        logDecision(context, 'audio_context_error', 'bad_response');
        cleanup();
        setState({ status: 'error', errorReason: 'bad-response' });
        return;
      }

      if (payload.effectiveVerbosity) {
        console.debug('[kookr.speak] effectiveVerbosity', {
          requested: verbosity,
          effective: payload.effectiveVerbosity,
          requestId: payload.requestId,
        });
      }

      const baseTimings: SpeakFindingTimings = {
        requestMs: payloadReceivedAt - requestStartedAt,
        llmMs: payload.llmMs,
        ttsMs: payload.ttsMs,
        audioMs: payload.durationMs,
        cached: payload.cached,
        usedFallback: payload.usedFallback,
      };
      setState({ status: 'generating', cached: payload.cached, timings: baseTimings });

      let buffer: AudioBuffer;
      const decodeStartedAt = nowMs();
      try {
        buffer = await ctx.decodeAudioData(base64ToArrayBuffer(payload.audioBase64));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logDecision(context, 'audio_context_error', `decode_failed:${reason.slice(0, 80)}`);
        cleanup();
        setState({ status: 'error', errorReason: 'decode-failed', cached: payload.cached, timings: baseTimings });
        return;
      }
      const decodedAt = nowMs();
      const decodedTimings: SpeakFindingTimings = {
        ...baseTimings,
        decodeMs: decodedAt - decodeStartedAt,
      };
      // Abort can fire between fetch resolution and decodeAudioData completion;
      // a stale agentId means this audio belongs to a previous agent and
      // playing it now would mismatch the visible detail panel.
      if (ac.signal.aborted) {
        try { void ctx.close(); } catch {}
        return;
      }

      if (unlockPromise) {
        await unlockPromise;
      }
      if (ac.signal.aborted) {
        try { void ctx.close(); } catch {}
        return;
      }
      if (resumeError) {
        const reason = resumeError instanceof Error ? resumeError.message : String(resumeError);
        logDecision(context, 'audio_context_error', `resume_failed:${reason.slice(0, 80)}`, {
          audioContextInitialState,
          audioContextFinalState: ctx.state,
          resumeAttempted,
          resumeFailed,
        });
        cleanup();
        setState({ status: 'error', errorReason: 'audio-context-resume-failed', cached: payload.cached, timings: decodedTimings });
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      sourceRef.current = source;
      let playbackStartedAt = decodedAt;
      let currentTimings = decodedTimings;

      source.onended = () => {
        if (sourceRef.current === source) {
          sourceRef.current = null;
          const endedTimings: SpeakFindingTimings = {
            ...currentTimings,
            playedMs: nowMs() - playbackStartedAt,
          };
          cleanup();
          setState({ status: 'idle', cached: payload.cached, timings: endedTimings });
        }
      };

      try {
        source.start();
        playbackStartedAt = nowMs();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logDecision(context, 'audio_context_error', `start_failed:${reason.slice(0, 80)}`);
        cleanup();
        setState({ status: 'error', errorReason: 'start-failed', cached: payload.cached, timings: decodedTimings });
        return;
      }

      const playTimings: SpeakFindingTimings = {
        ...decodedTimings,
        timeToStartMs: playbackStartedAt - requestStartedAt,
      };
      currentTimings = playTimings;

      // Detect the case where the tab is backgrounded so AudioContext stays
      // 'suspended' after start() — audio would silently never play. Clear
      // the client timeout here so the stale timer can't fire 20s later and
      // wrongly mark the recovered/retried attempt as a timeout-client
      // failure (see #624 review Finding 1).
      if (ctx.state !== 'running') {
        clearClientTimeout();
        const decision = logDecision(context, 'audio_context_suspended', 'audio_context_suspended', {
          audioContextInitialState,
          audioContextFinalState: ctx.state,
          resumeAttempted,
          resumeFailed,
        });
        updateAudioAlertDecision(decision.id, { audioContextFinalState: ctx.state });
        setState({ status: 'suppressed', errorReason: 'audio-context-suspended', cached: payload.cached, timings: playTimings });
        return;
      }

      logDecision(context, 'scheduled', 'speak_playing', {
        audioContextInitialState,
        audioContextFinalState: ctx.state,
        resumeAttempted,
        resumeFailed,
      });
      clearClientTimeout();
      setState({ status: 'playing', cached: payload.cached, timings: playTimings });
    })();
  }, [agentId, anomalyType, ttsAvailable, endpoint, state.status, stop, fetcher, cleanup, clearClientTimeout]);

  return { state, speak, stop };
}
