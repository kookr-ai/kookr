/**
 * useSTT — React hook for speech-to-text via an external aegiscore STT service.
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

import { useState, useRef, useCallback } from 'react';

export type STTState = 'idle' | 'recording' | 'processing' | 'error';

export interface UseSTTResult {
  state: STTState;
  /** Progressive transcription text (fixed + active) */
  transcript: string;
  /** Error message if state === 'error' */
  error: string | null;
  /** Elapsed recording time in seconds */
  elapsed: number;
  /** Start recording and streaming to STT service */
  start: () => Promise<void>;
  /** Stop recording and receive final transcription */
  stop: () => void;
}

const TARGET_SAMPLE_RATE = 16000;
const PROCESSING_TIMEOUT_MS = 15_000;

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
): Promise<AudioWorkletNode | null> {
  if (!audioContext.audioWorklet) return null;

  try {
    await audioContext.audioWorklet.addModule('/pcm-processor.js');
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

export function useSTT(sttUrl: string, onTranscript: (text: string) => void): UseSTTResult {
  const [state, setState] = useState<STTState>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const stateRef = useRef<STTState>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const audioNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const processingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimeRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  // Keep stateRef in sync
  function setStateAndRef(s: STTState) {
    stateRef.current = s;
    setState(s);
  }

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (processingTimerRef.current) {
      clearTimeout(processingTimerRef.current);
      processingTimerRef.current = null;
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
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    // Guard: don't start if already recording or processing
    if (stateRef.current === 'recording' || stateRef.current === 'processing') return;

    setError(null);
    setTranscript('');
    setElapsed(0);

    // Request microphone
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: TARGET_SAMPLE_RATE, channelCount: 1, echoCancellation: true },
      });
    } catch (err) {
      const msg = err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : 'Could not access microphone';
      setError(msg);
      setStateAndRef('error');
      return;
    }
    streamRef.current = stream;

    // Open WebSocket to STT service
    const ws = new WebSocket(sttUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send config message
      ws.send(JSON.stringify({ type: 'config', language: 'en', progressive: true }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'progressive') {
          const text = [msg.fixedText, msg.activeText].filter(Boolean).join(' ');
          setTranscript(text);
          onTranscriptRef.current(text);
        } else if (msg.type === 'transcription' && msg.is_final) {
          setTranscript(msg.text);
          onTranscriptRef.current(msg.text);
          setStateAndRef('idle');
          cleanup();
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      setError('STT service connection failed');
      setStateAndRef('error');
      cleanup();
    };

    ws.onclose = () => {
      // Use ref to check current state — closure would capture stale value
      if (stateRef.current === 'recording') {
        setError('STT service disconnected');
        setStateAndRef('error');
        cleanup();
      }
    };

    // Set up audio processing
    const actualSampleRate = stream.getAudioTracks()[0].getSettings().sampleRate ?? 48000;
    const audioContext = new AudioContext({ sampleRate: actualSampleRate });
    contextRef.current = audioContext;
    const source = audioContext.createMediaStreamSource(stream);

    // Chunk handler — resample and send via WebSocket
    const handleChunk = (inputData: Float32Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const pcm16 = resampleToInt16(inputData, audioContext.sampleRate);
      ws.send(pcm16.buffer);
    };

    // Prefer AudioWorkletNode (audio thread, never drops frames)
    // Fall back to ScriptProcessorNode (main thread, drops under load)
    const workletNode = await tryCreateWorkletNode(audioContext, source, handleChunk);
    if (workletNode) {
      audioNodeRef.current = workletNode;
    } else {
      audioNodeRef.current = createScriptProcessorFallback(audioContext, source, handleChunk);
    }

    // Elapsed timer
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);

    setStateAndRef('recording');
  }, [sttUrl, cleanup]);

  const stop = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setStateAndRef('processing');
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      // Cleanup audio immediately, keep WS open for final transcription
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
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      // Processing timeout — if server never sends final transcription, recover
      processingTimerRef.current = setTimeout(() => {
        if (stateRef.current === 'processing') {
          setError('Transcription timed out');
          setStateAndRef('error');
          if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
          }
        }
      }, PROCESSING_TIMEOUT_MS);
    } else {
      setStateAndRef('idle');
      cleanup();
    }
  }, [cleanup]);

  return { state, transcript, error, elapsed, start, stop };
}
