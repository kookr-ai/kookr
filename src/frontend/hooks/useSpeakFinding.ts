import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recordAudioAlertDecision,
  redactAudioAlertDecision,
  updateAudioAlertDecision,
  getClientAudioIdentity,
  type AudioAlertContext,
  type AudioAlertOutcome,
  type LocalAudioAlertDecision,
} from '../audio/audio-alert-log.js';
import { getSoundPreferenceState } from '../audio/sound-preference.js';
import { getDndState } from './useDnd.js';
import type {
  SpeakFindingErrorResponse,
  SpeakFindingResponse,
} from '../../shared/contracts/speech.js';
import type { SpeakFindingTimings } from '../speech-presentation.js';

export type SpeakFindingStatus = 'idle' | 'loading' | 'playing' | 'suppressed' | 'error';

export interface SpeakFindingState {
  status: SpeakFindingStatus;
  errorReason?: string;
  cached?: boolean;
  timings?: SpeakFindingTimings;
}

interface SpeakFindingDeps {
  /** Test seam. */
  fetcher?: typeof fetch;
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

interface UseSpeakFindingArgs {
  agentId: string | null;
  /** Anomaly type for telemetry/log context. */
  anomalyType: string | null;
  /** Whether the server advertises ttsUrl. Drives the toast vs. fetch decision. */
  ttsAvailable: boolean;
}

export interface UseSpeakFindingReturn {
  state: SpeakFindingState;
  /** Toggles: starts if idle, stops if playing/loading. */
  speak: () => void;
  /** Force-stop and reset to idle. */
  stop: () => void;
}

/**
 * Owns the speak-finding lifecycle for the currently-selected finding.
 *
 * Fetch + audio decode + playback live here. Suppression + decision logging go
 * through audio-alert-log (same channel as `maybePlayChime` — search for
 * source: 'finding_speak' to find this hook's records).
 */
export function useSpeakFinding(
  args: UseSpeakFindingArgs,
  deps: SpeakFindingDeps = {},
): UseSpeakFindingReturn {
  const { agentId, anomalyType, ttsAvailable } = args;
  const fetcher = deps.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

  const [state, setState] = useState<SpeakFindingState>({ status: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  const cleanup = useCallback(() => {
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
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState({ status: 'idle' });
  }, [cleanup]);

  // Cancel any in-flight work when the selected finding changes.
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

    if (state.status === 'loading' || state.status === 'playing') {
      logDecision(context, 'audio_context_error', 'user_canceled');
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

    const ac = new AbortController();
    abortRef.current = ac;
    const requestStartedAt = nowMs();
    setState({ status: 'loading' });

    void (async () => {
      let response: Response;
      try {
        response = await fetcher(`/api/findings/${encodeURIComponent(agentId)}/speak`, {
          method: 'POST',
          signal: ac.signal,
        });
      } catch (err) {
        if (ac.signal.aborted) return;
        const reason = err instanceof Error ? err.message : String(err);
        logDecision(context, 'audio_context_error', `fetch_failed:${reason.slice(0, 80)}`);
        setState({ status: 'error', errorReason: 'fetch-failed' });
        return;
      }

      if (ac.signal.aborted) return;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as SpeakFindingErrorResponse;
        const errorReason = body.error ?? 'http-error';
        logDecision(context, 'audio_context_error', `http_${response.status}:${errorReason}`);
        setState({ status: 'error', errorReason });
        return;
      }

      const payload = (await response.json().catch(() => null)) as SpeakFindingResponse | null;
      const payloadReceivedAt = nowMs();
      if (ac.signal.aborted) return;
      if (!payload || typeof payload.audioBase64 !== 'string') {
        logDecision(context, 'audio_context_error', 'bad_response');
        setState({ status: 'error', errorReason: 'bad-response' });
        return;
      }

      const baseTimings: SpeakFindingTimings = {
        requestMs: payloadReceivedAt - requestStartedAt,
        llmMs: payload.llmMs,
        ttsMs: payload.ttsMs,
        audioMs: payload.durationMs,
        cached: payload.cached,
        usedFallback: payload.usedFallback,
      };
      setState({ status: 'loading', cached: payload.cached, timings: baseTimings });

      const ctx = new AudioContext();
      ctxRef.current = ctx;
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
      // a stale agentId means this audio belongs to a previous finding and
      // playing it now would mismatch the visible detail panel.
      if (ac.signal.aborted) {
        try { void ctx.close(); } catch {}
        return;
      }

      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try { await ctx.resume(); } catch {}
      }
      if (ac.signal.aborted) {
        try { void ctx.close(); } catch {}
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
      // 'suspended' after start() — audio would silently never play.
      if (ctx.state !== 'running') {
        const decision = logDecision(context, 'audio_context_suspended', 'audio_context_suspended', {
          audioContextInitialState: ctx.state,
          audioContextFinalState: ctx.state,
        });
        updateAudioAlertDecision(decision.id, { audioContextFinalState: ctx.state });
        setState({ status: 'suppressed', errorReason: 'audio-context-suspended', cached: payload.cached, timings: playTimings });
        return;
      }

      logDecision(context, 'scheduled', 'speak_playing', {
        audioContextInitialState: ctx.state,
        audioContextFinalState: ctx.state,
      });
      setState({ status: 'playing', cached: payload.cached, timings: playTimings });
    })();
  }, [agentId, anomalyType, ttsAvailable, state.status, stop, fetcher, cleanup]);

  return { state, speak, stop };
}
