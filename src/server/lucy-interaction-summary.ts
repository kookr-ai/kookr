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
 *  - clipsStarted: distinct `clipId`s with a LIVE `lucy_clip_started` event:
 *    `trigger:"click"` (a speaker button) or `trigger:"ask"` (Lucy read out a
 *    question a task asked). Replays reuse the clipId, so they never add to it.
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
 *  - lucyActions (issue #4184): Lucy's confirmed actions on existing tasks,
 *    `kind:"action"` lines with `event:"done"`, counted per `action` (answer /
 *    reply / close, anything else `other`). Lucy-only: dashboard replies and
 *    closes are not attributed per channel yet, so there is no share here.
 *
 * `operatorLaunches` (issue #4184) is not read from the log: see
 * {@link summarizeOperatorLaunches}, which the route composes in from the task
 * store and the task archive.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { LUCY_EVENT_ENUMS, LUCY_OTHER } from './lucy-interaction-log.js';
import { LUCY_OPERATOR_ACTOR_ID } from '../shared/contracts/lucy-launch.js';
import type { TaskLaunchSource } from '../shared/contracts/task.js';
import type { Task } from '../core/tasks.js';

const UNHEARD_REASONS: readonly string[] = LUCY_EVENT_ENUMS.reason;
const PANEL_ACTIONS: readonly string[] = LUCY_EVENT_ENUMS.action;
/** The `action` values of a Lucy action line (lucy-interaction-log.ts `LucyActionRecordInput`). */
const LUCY_ACTION_KINDS: readonly string[] = ['answer', 'reply', 'close'];

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
  /**
   * Lucy's confirmed actions (`event:"done"`) in the window, per `action`.
   * Lucy-only: the dashboard's replies and closes are not attributed per channel yet.
   */
  lucyActions: { scope: 'lucy-only'; total: number; byAction: Record<string, number> };
  /** Present when the server injects a task source (store + archive); see {@link summarizeOperatorLaunches}. */
  operatorLaunches?: OperatorLaunchSummary;
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
  const lucyActions = new Map<string, number>();
  let lucyActionsTotal = 0;

  function handleUi(event: Record<string, unknown>): void {
    const clipId = typeof event.clipId === 'string' ? event.clipId : undefined;
    switch (event.type) {
      case 'lucy_clip_started':
        if (clipId) startedAnyClips.add(clipId);
        // A first play: the operator pressed a speaker button, or Lucy read out a question by herself.
        if ((event.trigger === 'click' || event.trigger === 'ask') && clipId) liveStartedClips.add(clipId);
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
      if (!isRecord(parsed)) {
        corruptLines++;
        return;
      }
      // Conversation turns are valid lines that this summary does not aggregate; they are not corrupt.
      // So are launch proposals (Lucy's launches are counted from task records, not from this log).
      if (parsed.kind === 'live_turn' || parsed.kind === 'operator_turn' || parsed.kind === 'launch') return;
      if (parsed.kind !== 'said' && parsed.kind !== 'ui' && parsed.kind !== 'action') {
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
      if (parsed.kind === 'action') {
        if (parsed.event === 'done') {
          lucyActionsTotal++;
          increment(lucyActions, bucket(parsed.action, LUCY_ACTION_KINDS));
        }
        return;
      }
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
        lucyActions: { scope: 'lucy-only', total: lucyActionsTotal, byAction: Object.fromEntries(lucyActions) },
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

// ---------------------------------------------------------------------------
// Operator launches by channel (issue #4184)
// ---------------------------------------------------------------------------

/**
 * Which channel a task's launch came through. Precedence, first match wins:
 *  1. `lucy`: `metadata.launchActorId === 'lucy-operator'` (her launches are `api`).
 *  2. `agentOrAutomation`: spawned by another task (`provenance.kind === 'parent'`,
 *     whatever its `launchSource`; child tasks arrive over `api` or `cli`).
 *  3. by `metadata.launchSource`: `websocket` (Launch dialog, relaunch) and `ui`
 *     (playbook launches over HTTP) → `dashboard`; `remote-chat-telegram` →
 *     `telegram`; `cli` → `cli`; `api` → `apiOther`; `schedule`, `chain`,
 *     `supervision`, `idle-refinery`, `post-recovery`, `resource-watchdog`,
 *     `remote-relay` → `agentOrAutomation`.
 *  4. `unknown`: no `launchSource` (legacy records), or a value this build does not know.
 */
export type OperatorLaunchChannel =
  | 'lucy'
  | 'dashboard'
  | 'telegram'
  | 'cli'
  | 'apiOther'
  | 'agentOrAutomation'
  | 'unknown';

export const OPERATOR_LAUNCH_CHANNELS: readonly OperatorLaunchChannel[] = [
  'lucy',
  'dashboard',
  'telegram',
  'cli',
  'apiOther',
  'agentOrAutomation',
  'unknown',
];

/** The few task fields the launch summary needs; projected while reading so 90 days of tasks are never held whole. */
export interface LaunchTaskFacts {
  id: string;
  createdAtMs: number;
  launchSource?: string;
  launchActorId?: string;
  provenanceKind?: string;
}

export function launchTaskFacts(task: Task): LaunchTaskFacts {
  const created = task.createdAt instanceof Date ? task.createdAt.getTime() : Date.parse(String(task.createdAt));
  return {
    id: task.id,
    createdAtMs: created,
    ...(typeof task.metadata?.launchSource === 'string' ? { launchSource: task.metadata.launchSource } : {}),
    ...(typeof task.metadata?.launchActorId === 'string' ? { launchActorId: task.metadata.launchActorId } : {}),
    ...(typeof task.provenance?.kind === 'string' ? { provenanceKind: task.provenance.kind } : {}),
  };
}

function channelForSource(source: TaskLaunchSource): OperatorLaunchChannel {
  switch (source) {
    case 'websocket':
    case 'ui':
      return 'dashboard';
    case 'remote-chat-telegram':
      return 'telegram';
    case 'cli':
      return 'cli';
    case 'api':
      return 'apiOther';
    case 'schedule':
    case 'chain':
    case 'supervision':
    case 'idle-refinery':
    case 'post-recovery':
    case 'resource-watchdog':
    case 'remote-relay':
      return 'agentOrAutomation';
    default: {
      // A new TaskLaunchSource must be given a channel here (compile error);
      // an unknown string read from an old or newer record lands in `unknown`.
      const unhandled: never = source;
      void unhandled;
      return 'unknown';
    }
  }
}

export function classifyLaunchChannel(task: LaunchTaskFacts): OperatorLaunchChannel {
  if (task.launchActorId === LUCY_OPERATOR_ACTOR_ID) return 'lucy';
  if (task.provenanceKind === 'parent') return 'agentOrAutomation';
  if (task.launchSource === undefined) return 'unknown';
  return channelForSource(task.launchSource as TaskLaunchSource);
}

export type OperatorLaunchCounts = Record<OperatorLaunchChannel, number>;

export interface OperatorLaunchWeek {
  /** ISO 8601 week in UTC, e.g. `2026-W47` (the ISO week-year can differ from the calendar year). */
  week: string;
  /** Monday 00:00 UTC that starts the week. */
  start: string;
  /** True when the window covers only part of the week: the first week, and the current one still running. */
  partial: boolean;
  counts: OperatorLaunchCounts;
  lucyShare: number | null;
}

export interface OperatorLaunchSummary {
  /** Tasks created in the window, de-duplicated by id across the live store and the archive. */
  total: number;
  counts: OperatorLaunchCounts;
  /**
   * lucy / (lucy + dashboard + telegram): the operator's interactive channels.
   * `cli` and `apiOther` are reported but left out, because supervisors and
   * agents use them too. Null when no interactive launch happened.
   */
  lucyShare: number | null;
  /** One entry per ISO week touched by the window, oldest first, including weeks with no launch. */
  weeks: OperatorLaunchWeek[];
  /**
   * Earliest `archivedAt` in the task archive. Terminal tasks pruned from the
   * store before this instant are gone, so a window that starts earlier may
   * undercount. Null when the archive is empty or not read.
   */
  archiveOldestAt: string | null;
  /** From the live store / from the archive only (not in the store). */
  sources: { store: number; archive: number };
}

export interface OperatorLaunchInput {
  liveTasks: Iterable<LaunchTaskFacts>;
  archivedTasks: Iterable<LaunchTaskFacts>;
  archiveOldestAt: string | null;
  days: number;
  now?: Date;
}

function emptyCounts(): OperatorLaunchCounts {
  return { lucy: 0, dashboard: 0, telegram: 0, cli: 0, apiOther: 0, agentOrAutomation: 0, unknown: 0 };
}

function lucyShareOf(counts: OperatorLaunchCounts): number | null {
  const interactive = counts.lucy + counts.dashboard + counts.telegram;
  return interactive > 0 ? ratio(counts.lucy, interactive) : null;
}

const WEEK_MS = 7 * DAY_MS;

/** Monday 00:00 UTC of the ISO week holding `ms`. */
function isoWeekStartMs(ms: number): number {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (new Date(dayStart).getUTCDay() + 6) % 7;
  return dayStart - sinceMonday * DAY_MS;
}

/** `YYYY-Www` for the ISO week starting at `mondayMs` (the week-year is the year of its Thursday). */
export function isoWeekLabel(mondayMs: number): string {
  const year = new Date(mondayMs + 3 * DAY_MS).getUTCFullYear();
  const week1Monday = isoWeekStartMs(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((mondayMs - week1Monday) / WEEK_MS);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Count the tasks created in the last `days` by launch channel, overall and per
 * UTC ISO week. A task present in both inputs is counted once (the live copy
 * wins); duplicate ids within one input are counted once too.
 */
export function summarizeOperatorLaunches(input: OperatorLaunchInput): OperatorLaunchSummary {
  const nowMs = (input.now ?? new Date()).getTime();
  const sinceMs = nowMs - input.days * DAY_MS;

  const firstMonday = isoWeekStartMs(sinceMs);
  const weekCounts: OperatorLaunchCounts[] = [];
  for (let m = firstMonday; m <= nowMs; m += WEEK_MS) weekCounts.push(emptyCounts());

  const counts = emptyCounts();
  const seen = new Set<string>();
  const sources = { store: 0, archive: 0 };
  const take = (tasks: Iterable<LaunchTaskFacts>, from: 'store' | 'archive'): void => {
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (!Number.isFinite(task.createdAtMs) || task.createdAtMs < sinceMs || task.createdAtMs > nowMs) continue;
      const channel = classifyLaunchChannel(task);
      counts[channel]++;
      sources[from]++;
      const weekIndex = Math.floor((task.createdAtMs - firstMonday) / WEEK_MS);
      weekCounts[weekIndex][channel]++;
    }
  };
  take(input.liveTasks, 'store');
  take(input.archivedTasks, 'archive');

  const weeks = weekCounts.map((c, i) => {
    const start = firstMonday + i * WEEK_MS;
    return {
      week: isoWeekLabel(start),
      start: new Date(start).toISOString(),
      partial: start < sinceMs || start + WEEK_MS > nowMs,
      counts: c,
      lucyShare: lucyShareOf(c),
    };
  });

  return {
    total: sources.store + sources.archive,
    counts,
    lucyShare: lucyShareOf(counts),
    weeks,
    archiveOldestAt: input.archiveOldestAt,
    sources,
  };
}
