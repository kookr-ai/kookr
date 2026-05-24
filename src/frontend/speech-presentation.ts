export interface SpeakFindingTimings {
  /** Wall-clock time from POST dispatch to parsed JSON payload. */
  requestMs?: number;
  /** Server-side LLM summary time; 0 on cache hit. */
  llmMs?: number;
  /** Server-side TTS synthesis time; 0 on cache hit. */
  ttsMs?: number;
  /** Browser-side decodeAudioData time. */
  decodeMs?: number;
  /** Browser-side time from request start until source.start() returned. */
  timeToStartMs?: number;
  /** Audio duration reported by the server-side TTS service. */
  audioMs?: number;
  /** Actual elapsed playback time observed by this tab. */
  playedMs?: number;
  cached?: boolean;
  usedFallback?: boolean;
}

function formatTimingMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatSpeakFindingTimingLine(timings: SpeakFindingTimings | undefined): string | null {
  if (!timings) return null;
  const parts: string[] = [];

  if (timings.cached) {
    parts.push('cache');
  } else {
    if (typeof timings.llmMs === 'number') parts.push(`LLM ${formatTimingMs(timings.llmMs)}`);
    if (typeof timings.ttsMs === 'number') parts.push(`TTS ${formatTimingMs(timings.ttsMs)}`);
  }

  if (typeof timings.decodeMs === 'number') parts.push(`decode ${formatTimingMs(timings.decodeMs)}`);
  if (typeof timings.audioMs === 'number') parts.push(`audio ${formatTimingMs(timings.audioMs)}`);

  return parts.length > 0 ? parts.join(' · ') : null;
}

export function formatSpeakFindingTimingTitle(timings: SpeakFindingTimings | undefined): string | undefined {
  if (!timings) return undefined;
  const lines = [
    typeof timings.requestMs === 'number' ? `Request: ${formatTimingMs(timings.requestMs)}` : null,
    timings.cached ? 'Summary/TTS: cache hit' : null,
    !timings.cached && typeof timings.llmMs === 'number' ? `Summary: ${formatTimingMs(timings.llmMs)}` : null,
    !timings.cached && typeof timings.ttsMs === 'number' ? `Synthesis: ${formatTimingMs(timings.ttsMs)}` : null,
    typeof timings.decodeMs === 'number' ? `Browser decode: ${formatTimingMs(timings.decodeMs)}` : null,
    typeof timings.timeToStartMs === 'number' ? `Time to playback: ${formatTimingMs(timings.timeToStartMs)}` : null,
    typeof timings.audioMs === 'number' ? `Audio length: ${formatTimingMs(timings.audioMs)}` : null,
    typeof timings.playedMs === 'number' ? `Observed playback: ${formatTimingMs(timings.playedMs)}` : null,
    timings.usedFallback ? 'Used fallback text' : null,
  ].filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join('\n') : undefined;
}
