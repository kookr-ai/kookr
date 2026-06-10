/**
 * Narration timeline utilities — converts the recording's tracker marks into
 * subtitle files and cut-segment definitions for the export matrix.
 */

export interface TimelineEntry {
  key: string;
  offsetMs: number;
}

export interface NarrationClipInfo {
  durationMs: number;
}

/**
 * Estimate how long a narration line takes to speak when no TTS clip exists
 * (silent recordings still get accurate-enough subtitles).
 * ~2.6 words/second, clamped to a sane caption window.
 */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.min(9000, Math.max(1800, Math.round((words / 2.6) * 1000)));
}

function srtTimestamp(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = Math.floor(ms % 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/**
 * Build an SRT subtitle document from tracker marks. Each cue starts at its
 * mark offset and lasts the TTS clip duration (or a word-rate estimate),
 * clamped so cues never overlap the next mark.
 */
export function buildSrt(
  entries: TimelineEntry[],
  narrations: Record<string, string>,
  clips: Map<string, NarrationClipInfo>,
): string {
  const cues: string[] = [];
  let index = 1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = narrations[entry.key];
    if (!text) continue;
    const duration = clips.get(entry.key)?.durationMs ?? estimateSpeechMs(text);
    // Clamp against the next NARRATED mark only — structural marks like
    // video_end carry no text and must not truncate the preceding cue.
    const nextOffset = entries
      .slice(i + 1)
      .find((e) => narrations[e.key])?.offsetMs ?? Number.POSITIVE_INFINITY;
    const end = Math.min(entry.offsetMs + duration, nextOffset - 100);
    if (end <= entry.offsetMs) continue;
    cues.push(`${index}\n${srtTimestamp(entry.offsetMs)} --> ${srtTimestamp(end)}\n${text}\n`);
    index++;
  }
  return cues.join('\n');
}

export interface CutSegment {
  startMs: number;
  endMs: number;
}

/**
 * Resolve (fromKey, toKey) pairs against tracker marks. The segment runs from
 * the offset of `fromKey` to the offset of `toKey` (exclusive), or to the end
 * of the video when `toKey` is null. Pairs whose keys are missing are skipped.
 */
export function segmentsFromTracker(
  entries: TimelineEntry[],
  videoDurationMs: number,
  pairs: Array<[string, string | null]>,
): CutSegment[] {
  const offsetOf = new Map(entries.map((e) => [e.key, e.offsetMs]));
  const segments: CutSegment[] = [];
  for (const [fromKey, toKey] of pairs) {
    const start = offsetOf.get(fromKey);
    const end = toKey === null ? videoDurationMs : offsetOf.get(toKey);
    if (start === undefined || end === undefined || end <= start) continue;
    segments.push({ startMs: start, endMs: Math.min(end, videoDurationMs) });
  }
  return segments;
}
