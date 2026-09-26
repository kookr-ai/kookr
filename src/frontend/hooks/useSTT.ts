/**
 * useSTT — React hook for speech-to-text via the configured Kookr STT service.
 *
 * Handles the full lifecycle: microphone capture, audio resampling to 16kHz PCM,
 * WebSocket streaming to the STT service, and progressive transcription updates.
 *
 * Uses AudioWorkletNode (dedicated audio thread) to prevent dropped frames
 * under main-thread load. Falls back to ScriptProcessorNode for browsers
 * that don't support AudioWorklet.
 *
 * This module is dynamically imported only when STT is enabled (KOOKR_STT_URL set).
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

import type { STTLanguage } from '../store/stt-language.js';

export type STTState = 'starting' | 'idle' | 'recording' | 'processing' | 'error';

interface AudioSignal {
  /** Normalized input level, from silence (zero) to full scale (one). */
  level: number;
  status: 'waiting' | 'receiving' | 'quiet' | 'weak' | 'interrupted' | 'clipping';
}

export interface UseSTTResult {
  state: STTState;
  /** Progressive transcription text (fixed + active) */
  transcript: string;
  /** Error message if state === 'error' */
  error: string | null;
  /** True when the last failure came from the STT service itself. */
  degraded: boolean;
  /** True while an on-demand STT health retry is in flight. */
  retrying: boolean;
  /** Elapsed recording time in seconds */
  elapsed: number;
  /** Microphone input, measured before transport to the transcription service. */
  audioSignal: AudioSignal;
  /** Start recording and streaming to STT service */
  start: () => Promise<void>;
  /** Stop recording and receive final transcription */
  stop: () => void;
  /** Re-probe STT health and clear degraded state when healthy. */
  retryHealth: () => Promise<void>;
}

const TARGET_SAMPLE_RATE = 16000;
const PROCESSING_TIMEOUT_MS = 15_000;
const AUDIO_METER_INTERVAL_MS = 100;
// Allow nearly three 4096-sample chunks at 16 kHz before declaring capture stale.
const AUDIO_STALE_MS = 750;
// Flatten immediately on silence, but let short pauses pass without changing the label.
const AUDIO_QUIET_LABEL_DELAY_MS = 600;
const EMPTY_AUDIO_SIGNAL: AudioSignal = { level: 0, status: 'waiting' };

function measureAudioSignal(input: Float32Array): AudioSignal {
  let energy = 0;
  let peak = 0;
  for (const sample of input) {
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  const rms = Math.sqrt(energy / Math.max(1, input.length));
  const decibels = 20 * Math.log10(Math.max(rms, 1e-6));
  // The meter displays the sixty decibels below digital full scale, not room loudness.
  const level = Math.min(1, Math.max(0, (decibels + 60) / 60));
  const status = peak >= 0.99 ? 'clipping' : decibels <= -60 ? 'quiet' : decibels < -40 ? 'weak' : 'receiving';
  return { level, status };
}

interface STTHealthSnapshot {
  degraded: boolean;
  retrying: boolean;
  error: string | null;
}

let sttHealthSnapshot: STTHealthSnapshot = { degraded: false, retrying: false, error: null };
let sttHealthUrl = '';
const sttHealthSubscribers = new Set<() => void>();

function getSTTHealthSnapshot(): STTHealthSnapshot {
  return sttHealthSnapshot;
}

function subscribeSTTHealth(listener: () => void): () => void {
  sttHealthSubscribers.add(listener);
  return () => sttHealthSubscribers.delete(listener);
}

function setSTTHealth(next: Partial<STTHealthSnapshot>): void {
  const snapshot = { ...sttHealthSnapshot, ...next };
  if (
    snapshot.degraded === sttHealthSnapshot.degraded
    && snapshot.retrying === sttHealthSnapshot.retrying
    && snapshot.error === sttHealthSnapshot.error
  ) {
    return;
  }
  sttHealthSnapshot = snapshot;
  for (const listener of sttHealthSubscribers) listener();
}

/**
 * Resample Float32Array audio from sourceSampleRate to TARGET_SAMPLE_RATE
 * using linear interpolation, then convert to Int16Array for transmission.
 */
function resampleToInt16(input: Float32Array, sourceSampleRate: number): Int16Array {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
    }
    return out;
  }

  const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.round(input.length / ratio);
  const out = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const sample = idx + 1 < input.length
      ? input[idx] * (1 - frac) + input[idx + 1] * frac
      : input[idx];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  }
  return out;
}

/**
 * Set up AudioWorkletNode for audio capture (preferred — runs on audio thread).
 * Returns the worklet node, or null if AudioWorklet is not supported.
 */
async function tryCreateWorkletNode(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  onChunk: (data: Float32Array) => void,
  isCurrent: () => boolean,
): Promise<AudioWorkletNode | null> {
  if (!audioContext.audioWorklet) return null;

  try {
    await audioContext.audioWorklet.addModule('/pcm-processor.js');
    if (!isCurrent()) return null;
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
    workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      onChunk(e.data);
    };
    source.connect(workletNode);
    // AudioWorkletNode doesn't need to connect to destination to receive data
    workletNode.connect(audioContext.destination);
    return workletNode;
  } catch {
    return null;
  }
}

/**
 * Set up ScriptProcessorNode as fallback (deprecated — runs on main thread).
 * Drops audio frames under heavy UI load.
 */
function createScriptProcessorFallback(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  onChunk: (data: Float32Array) => void,
): ScriptProcessorNode {
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    // Copy the data — the buffer is reused by the audio graph
    onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  return processor;
}

/** Partial results stay in the preview; the callback receives each final result once. */
export function useSTT(sttUrl: string, language: STTLanguage, onTranscript: (text: string) => void): UseSTTResult {
  const [state, setState] = useState<STTState>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [audioSignal, setAudioSignal] = useState<AudioSignal>(EMPTY_AUDIO_SIGNAL);
  const sttHealth = useSyncExternalStore(subscribeSTTHealth, getSTTHealthSnapshot, getSTTHealthSnapshot);

  const stateRef = useRef<STTState>('idle');
  const sessionRef = useRef(0);
  const mountedRef = useRef(false);
  const serviceErrorRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const audioNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function setStateAndRef(next: STTState) {
    stateRef.current = next;
    setState(next);
  }

  function markSTTDegraded(message: string) {
    serviceErrorRef.current = true;
    setError(message);
    setSTTHealth({ degraded: true, error: message });
    setStateAndRef('error');
  }

  const releaseAudio = useCallback(() => {
    if (mountedRef.current) setAudioSignal(EMPTY_AUDIO_SIGNAL);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (audioNodeRef.current) {
      audioNodeRef.current.disconnect();
      audioNodeRef.current = null;
    }
    if (contextRef.current) {
      void contextRef.current.close();
      contextRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    // Pending microphone/worklet requests and queued socket events belong only
    // to the session that started them, even if this control starts again.
    sessionRef.current += 1;
    releaseAudio();
    if (processingTimerRef.current) {
      clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }, [releaseAudio]);

  // Cancel before the next task's input is painted. Cancellation discards the
  // pending result; stopping explicitly is what requests a final transcript.
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, [sttUrl, cleanup]);

  useEffect(() => {
    setStateAndRef('idle');
    if (sttUrl === sttHealthUrl) return;
    sttHealthUrl = sttUrl;
    serviceErrorRef.current = false;
    setSTTHealth({ degraded: false, retrying: false, error: null });
  }, [sttUrl]);

  useEffect(() => {
    if (sttHealth.degraded || !serviceErrorRef.current || stateRef.current !== 'error') return;
    serviceErrorRef.current = false;
    setError(null);
    setStateAndRef('idle');
  }, [sttHealth.degraded]);

  const start = useCallback(async () => {
    if (!mountedRef.current || !['idle', 'error'].includes(stateRef.current)) return;
    cleanup();
    const session = sessionRef.current;
    const isCurrent = () => mountedRef.current && sessionRef.current === session;
    setStateAndRef('starting');
    setError(null);
    serviceErrorRef.current = false;
    setSTTHealth({ degraded: false, error: null });
    setTranscript('');
    setElapsed(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: TARGET_SAMPLE_RATE, channelCount: 1, echoCancellation: true },
      });
    } catch (err) {
      if (!isCurrent()) return;
      const message = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : 'Could not access microphone';
      setError(message);
      setStateAndRef('error');
      cleanup();
      return;
    }
    if (!isCurrent()) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    streamRef.current = stream;

    try {
      const ws = new WebSocket(sttUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        if (isCurrent()) ws.send(JSON.stringify({ type: 'config', language, progressive: true }));
      };
      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        let msg: { type?: string; language?: string; fixedText?: string; activeText?: string; text?: string; is_final?: boolean; error?: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'config_ack' && msg.language !== language) {
          markSTTDegraded('Selected dictation language is unavailable. Update the STT service or choose another language.');
          cleanup();
        } else if (msg.type === 'progressive') {
          const text = [msg.fixedText, msg.activeText].filter((part) => typeof part === 'string').join(' ');
          setTranscript(text);
        } else if (msg.type === 'transcription' && msg.is_final === true && typeof msg.text === 'string') {
          setTranscript('');
          setStateAndRef('idle');
          cleanup();
          // Capture this recording's consumer instead of retargeting to a
          // different input when props change while the service is processing.
          if (msg.text.trim()) onTranscript(msg.text);
        } else if (msg.type === 'transcription' && msg.is_final === false && typeof msg.text === 'string') {
          setTranscript(msg.text);
        } else if (msg.type === 'error') {
          markSTTDegraded(typeof msg.error === 'string' ? msg.error : 'Transcription failed');
          cleanup();
        }
      };
      ws.onerror = () => {
        if (!isCurrent()) return;
        markSTTDegraded('STT service connection failed');
        cleanup();
      };
      ws.onclose = () => {
        if (!isCurrent()) return;
        markSTTDegraded('STT service disconnected');
        cleanup();
      };

      const actualSampleRate = stream.getAudioTracks()[0].getSettings().sampleRate ?? 48000;
      const audioContext = new AudioContext({ sampleRate: actualSampleRate });
      contextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      let latestSignal = EMPTY_AUDIO_SIGNAL;
      let lastChunkAt: number | null = null;
      let quietSince: number | null = null;
      const handleChunk = (inputData: Float32Array) => {
        if (!isCurrent() || stateRef.current !== 'recording' || inputData.length === 0) return;
        latestSignal = measureAudioSignal(inputData);
        lastChunkAt = performance.now();
        quietSince = latestSignal.status === 'quiet' ? quietSince ?? lastChunkAt : null;
        if (ws.readyState !== WebSocket.OPEN) return;
        const pcm16 = resampleToInt16(inputData, audioContext.sampleRate);
        ws.send(pcm16.buffer as ArrayBuffer);
      };
      const workletNode = await tryCreateWorkletNode(audioContext, source, handleChunk, isCurrent);
      if (!isCurrent()) {
        workletNode?.disconnect();
        return;
      }
      audioNodeRef.current = workletNode ?? createScriptProcessorFallback(audioContext, source, handleChunk);
      const startedAt = Date.now();
      const captureStartedAt = performance.now();
      timerRef.current = setInterval(() => {
        if (!isCurrent() || stateRef.current !== 'recording') return;
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
        const now = performance.now();
        const track = stream.getAudioTracks()[0];
        const interrupted = track.muted || track.readyState === 'ended'
          || audioContext.state === 'suspended' || audioContext.state === 'closed'
          || now - (lastChunkAt ?? captureStartedAt) >= AUDIO_STALE_MS;
        setAudioSignal((previous) => {
          let next = interrupted ? { level: 0, status: 'interrupted' as const } : latestSignal;
          if (!interrupted && quietSince !== null && now - quietSince < AUDIO_QUIET_LABEL_DELAY_MS) {
            next = { level: 0, status: previous.status === 'interrupted' ? 'waiting' : previous.status };
          }
          return next.level === previous.level && next.status === previous.status ? previous : next;
        });
      }, AUDIO_METER_INTERVAL_MS);
      setStateAndRef('recording');
    } catch {
      if (!isCurrent()) return;
      setError('Could not start voice input');
      setStateAndRef('error');
      cleanup();
    }
  }, [sttUrl, language, onTranscript, cleanup]);

  const stop = useCallback(() => {
    if (stateRef.current !== 'recording') return;
    const ws = wsRef.current;
    releaseAudio();
    if (ws?.readyState === WebSocket.OPEN) {
      setStateAndRef('processing');
      processingTimerRef.current = setTimeout(() => {
        markSTTDegraded('Transcription timed out');
        cleanup();
      }, PROCESSING_TIMEOUT_MS);
      ws.send(JSON.stringify({ type: 'stop' }));
    } else {
      setStateAndRef('idle');
      cleanup();
    }
  }, [releaseAudio, cleanup]);

  const retryHealth = useCallback(async () => {
    if (sttHealthSnapshot.retrying) return;
    setSTTHealth({ retrying: true });
    try {
      const res = await fetch('/api/health/stt', { cache: 'no-store' });
      const body = await res.json().catch(() => ({})) as { status?: unknown };
      if (res.ok && body.status === 'ok') {
        setSTTHealth({ degraded: false, error: null });
        if (mountedRef.current) {
          setError(null);
          serviceErrorRef.current = false;
          setStateAndRef('idle');
        }
        return;
      }
      setSTTHealth({ degraded: true, error: 'STT service unavailable' });
    } catch {
      setSTTHealth({ degraded: true, error: 'STT service unavailable' });
    } finally {
      setSTTHealth({ retrying: false });
    }
  }, []);

  return {
    state,
    transcript,
    error: sttHealth.degraded ? sttHealth.error : error,
    degraded: sttHealth.degraded,
    retrying: sttHealth.retrying,
    elapsed,
    audioSignal,
    start,
    stop,
    retryHealth,
  };
}
