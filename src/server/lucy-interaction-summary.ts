/**
 * Aggregates `lucy-interactions.jsonl` (see lucy-interaction-log.ts) into the
 * numbers needed to tune how the avatar talks: how much she said, how often
 * the operator replayed, cut her off, or never heard a clip, and which
 * phrasings get cut off most.
 *
 * The aggregation is a pure line accumulator so it can be fed from a file
 * stream (production) or an array (tests). Corrupt or unrecognised lines are
 * counted and skipped; they never abort a summary.
 *
 * Definitions (all over records whose `ts` falls in the window):
 *  - said: `kind:"said"` lines. Share = count / total said.
 *  - clipsStarted: distinct `clipId`s with a LIVE (`trigger:"click"`)
 *    `lucy_clip_started` event. Replays reuse the clipId, so they never add to it.
 *  - replays: `count` = `lucy_clip_started` events with `trigger:"replay"`;
 *    `clipsReplayed` = distinct clipIds replayed; `rate` = clipsReplayed /
 *    clipsStarted (so one clip replayed five times counts once; the rate only
 *    exceeds 1 if a replayed clip's live start predates the window).
 *  - earlyStop: a `lucy_clip_ended` with `endedBy:"user_stop"` and
 *    playedMs/totalMs < 0.5; earlyStopRate = earlyStops / clip-ended events.
 *  - unheard: distinct clips that reached the client but never started
 *    (`lucy_clip_unheard` with a clipId not already seen in a started event;
 *    a failed replay of a clip that did play is not "unheard"). Events without a
 *    clipId count individually. unheardRate = unheard / (unheard + clipsStarted).
 *    `byReason` sums to `unheard.count`; reasons and panel actions outside the
 *    documented values are bucketed as `other` (the browser is not trusted, so
 *    client strings never become object keys).
 *  - topEarlyStopped: early stops grouped by the clip's spoken text (joined
 *    from the `said` record on `clipId`, truncated).
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { LUCY_EVENT_ENUMS, LUCY_OTHER } from './lucy-interaction-log.js';

const UNHEARD_REASONS: readonly string[] = LUCY_EVENT_ENUMS.reason;
const PANEL_ACTIONS: readonly string[] = LUCY_EVENT_ENUMS.action;

export const LUCY_SUMMARY_SCHEMA_VERSION = 'lucy-interactions-summary.v1';
const EARLY_STOP_FRACTION = 0.5;
const TEXT_TRUNCATE_CHARS = 120;
const TOP_EARLY_STOPPED_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface LucySaidStats {
  count: number;
  fromFallback: { count: number; share: number };
  cacheHits: { count: number; share: number };
  meanWords: number;
  medianWords: number;
}

export interface LucyInteractionSummary {
  schemaVersion: typeof LUCY_SUMMARY_SCHEMA_VERSION;
  generatedAt: string;
  days: number;
  since: string;
  /** Lines that were not valid JSON or not a recognised record. */
  corruptLines: number;
  said: LucySaidStats & { bySource: Record<string, LucySaidStats> };
  ui: {
    clipsStarted: number;
    /**
     * `count`: replay starts. `clipsReplayed`: distinct clips replayed.
     * `rate` = clipsReplayed / clipsStarted (not count / clipsStarted, which
     * grows with every extra replay of the same clip).
     */
    replays: { count: number; clipsReplayed: number; rate: number };
    clipsEnded: number;
    earlyStops: { count: number; rate: number };
    unheard: { count: number; rate: number; byReason: Record<string, number> };
    panelActions: Record<string, number>;
  };
  /** Early stops whose clip text could not be joined (the `said` line is outside the log). */
  earlyStopsWithoutText: number;
  topEarlyStopped: Array<{ text: string; earlyStops: number }>;
}

export interface LucySummaryOptions {
  days: number;
  now?: Date;
}

interface SaidRow {
  source: string;
  words: number;
  usedFallback: boolean;
  cached: boolean;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function saidStats(rows: SaidRow[]): LucySaidStats {
  const words = rows.map((r) => r.words);
  const fallback = rows.filter((r) => r.usedFallback).length;
  const cacheHits = rows.filter((r) => r.cached).length;
  return {
    count: rows.length,
    fromFallback: { count: fallback, share: ratio(fallback, rows.length) },
    cacheHits: { count: cacheHits, share: ratio(cacheHits, rows.length) },
    meanWords: rows.length ? round2(words.reduce((a, b) => a + b, 0) / rows.length) : 0,
    medianWords: median(words),
  };
}

/** Documented value, or `other`. Never returns an arbitrary client string. */
function bucket(value: unknown, allowed: readonly string[]): string {
  return typeof value === 'string' && allowed.includes(value) ? value : LUCY_OTHER;
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > TEXT_TRUNCATE_CHARS ? `${flat.slice(0, TEXT_TRUNCATE_CHARS - 1)}…` : flat;
}

export interface LucySummaryAccumulator {
  add(line: string): void;
  result(): LucyInteractionSummary;
}

export function createLucySummaryAccumulator(options: LucySummaryOptions): LucySummaryAccumulator {
  const now = options.now ?? new Date();
  const sinceMs = now.getTime() - options.days * DAY_MS;
  let corruptLines = 0;

  const saidRows: SaidRow[] = [];
  // Text for every `said` line seen, including ones older than the window: an
  // in-window stop can refer to a clip said just before the window opened.
  const textByClip = new Map<string, string>();

  const liveStartedClips = new Set<string>();
  const startedAnyClips = new Set<string>();
  const replayedClips = new Set<string>();
  const unheardClips = new Set<string>();
  let replays = 0;
  let clipsEnded = 0;
  let unheard = 0;
  const unheardByReason = new Map<string, number>();
  const panelActions = new Map<string, number>();
  const earlyStopClipIds: Array<string | undefined> = [];

  function handleUi(event: Record<string, unknown>): void {
    const clipId = typeof event.clipId === 'string' ? event.clipId : undefined;
    switch (event.type) {
      case 'lucy_clip_started':
        if (clipId) startedAnyClips.add(clipId);
        if (event.trigger === 'click' && clipId) liveStartedClips.add(clipId);
        if (event.trigger === 'replay') {
          replays++;
          if (clipId) replayedClips.add(clipId);
        }
        break;
      case 'lucy_clip_ended': {
        clipsEnded++;
        const played = Number(event.playedMs);
        const total = Number(event.totalMs);
        if (event.endedBy === 'user_stop' && total > 0 && Number.isFinite(played) && played / total < EARLY_STOP_FRACTION) {
          earlyStopClipIds.push(clipId);
        }
        break;
      }
      case 'lucy_clip_unheard': {
        if (clipId) {
          // Already played (a failed replay) or already counted: not a new unheard clip.
          if (startedAnyClips.has(clipId) || unheardClips.has(clipId)) break;
          unheardClips.add(clipId);
        }
        unheard++;
        increment(unheardByReason, bucket(event.reason, UNHEARD_REASONS));
        break;
      }
      case 'lucy_panel_action': {
        increment(panelActions, bucket(event.action, PANEL_ACTIONS));
        break;
      }
      default:
        break;
    }
  }

  return {
    add(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        corruptLines++;
        return;
      }
      if (!isRecord(parsed) || (parsed.kind !== 'said' && parsed.kind !== 'ui')) {
        corruptLines++;
        return;
      }
      const tsMs = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : NaN;
      if (parsed.kind === 'said') {
        if (typeof parsed.clipId === 'string' && typeof parsed.text === 'string') {
          textByClip.set(parsed.clipId, parsed.text);
        }
        if (!Number.isFinite(tsMs) || tsMs < sinceMs) return;
        const words = Number(parsed.words);
        saidRows.push({
          source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
          words: Number.isFinite(words) ? words : 0,
          usedFallback: parsed.usedFallback === true,
          cached: parsed.cached === true,
        });
        return;
      }
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) return;
      if (isRecord(parsed.event)) handleUi(parsed.event);
    },

    result() {
      const bySource = new Map<string, SaidRow[]>();
      for (const row of saidRows) {
        const rows = bySource.get(row.source);
        if (rows) rows.push(row);
        else bySource.set(row.source, [row]);
      }

      const earlyStopsByText = new Map<string, number>();
      let earlyStopsWithoutText = 0;
      for (const clipId of earlyStopClipIds) {
        const text = clipId ? textByClip.get(clipId) : undefined;
        if (text === undefined) {
          earlyStopsWithoutText++;
          continue;
        }
        const key = truncate(text);
        earlyStopsByText.set(key, (earlyStopsByText.get(key) ?? 0) + 1);
      }
      const topEarlyStopped = [...earlyStopsByText.entries()]
        .map(([text, earlyStops]) => ({ text, earlyStops }))
        .sort((a, b) => b.earlyStops - a.earlyStops || a.text.localeCompare(b.text))
        .slice(0, TOP_EARLY_STOPPED_LIMIT);

      const clipsStarted = liveStartedClips.size;
      return {
        schemaVersion: LUCY_SUMMARY_SCHEMA_VERSION,
        generatedAt: now.toISOString(),
        days: options.days,
        since: new Date(sinceMs).toISOString(),
        corruptLines,
        said: {
          ...saidStats(saidRows),
          bySource: Object.fromEntries([...bySource.entries()].map(([k, rows]) => [k, saidStats(rows)])),
        },
        ui: {
          clipsStarted,
          replays: { count: replays, clipsReplayed: replayedClips.size, rate: ratio(replayedClips.size, clipsStarted) },
          clipsEnded,
          earlyStops: { count: earlyStopClipIds.length, rate: ratio(earlyStopClipIds.length, clipsEnded) },
          unheard: { count: unheard, rate: ratio(unheard, unheard + clipsStarted), byReason: Object.fromEntries(unheardByReason) },
          panelActions: Object.fromEntries(panelActions),
        },
        earlyStopsWithoutText,
        topEarlyStopped,
      };
    },
  };
}

/** Pure convenience wrapper: summarise an in-memory list of JSONL lines. */
export function summarizeLucyInteractionLines(
  lines: Iterable<string>,
  options: LucySummaryOptions,
): LucyInteractionSummary {
  const acc = createLucySummaryAccumulator(options);
  for (const line of lines) acc.add(line);
  return acc.result();
}

/**
 * Stream the log generations (oldest first: `.3`, `.2`, `.1`, then the live
 * file) into one summary. Missing files are skipped; a read error on one file
 * does not discard the others.
 */
export async function summarizeLucyInteractionFiles(
  basePath: string,
  options: LucySummaryOptions & { rotatedGenerations?: number },
): Promise<LucyInteractionSummary & { filesRead: number }> {
  const generations = options.rotatedGenerations ?? 3;
  const paths = [
    ...Array.from({ length: generations }, (_, i) => `${basePath}.${generations - i}`),
    basePath,
  ];
  const acc = createLucySummaryAccumulator(options);
  let filesRead = 0;
  for (const path of paths) {
    try {
      const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of rl) acc.add(line);
      filesRead++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[lucy-log] summary could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { ...acc.result(), filesRead };
}
