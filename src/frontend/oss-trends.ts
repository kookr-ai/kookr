import type { ContributionAttempt, AttemptState } from '../core/oss-attempt-store.js';

export type TrendWindow = '7d' | '30d' | '90d' | 'all';

interface PeriodSummary {
  opened: number;
  merged: number;
  closed: number;
  openNow: number;
  /**
   * Count of "zombie" PRs within the window — PRs whose `state === 'pr_open'`
   * but whose `linkedIssue` has been verified as closed by a different PR.
   * Subtracted from `openNow` so the invariant
   * `opened === merged + closed + openNow + stale` holds within any window.
   */
  stale: number;
  mergeRate: number | null;
  totalDecided: number;
}

/**
 * Canonical zombie-PR predicate. Single source of truth — imported by the
 * productivity view, the per-repo row builder, the lifecycle feed, and
 * `summarizePeriod`.
 */
export function isStale(attempt: ContributionAttempt): boolean {
  if (attempt.state !== 'pr_open') return false;
  const li = attempt.linkedIssue ?? null;
  if (!li || li.state !== 'closed') return false;
  // Defensive: a PR whose own close cascade observes itself mid-transition
  // as both open and the closer is not stale.
  if (li.closingPrNumber != null && li.closingPrNumber === attempt.prNumber) return false;
  return true;
}

export interface WeeklyBar {
  weekStart: string;
  weekLabel: string;
  opened: number;
  merged: number;
}

interface TrendsResult {
  current: PeriodSummary;
  prior: PeriodSummary | null;
  weeklyBars: WeeklyBar[];
  nonEmptyWeeks: number;
}

const SPARSE_MIN_NON_EMPTY_WEEKS = 3;
const SPARSE_MIN_EVENTS = 5;

/**
 * A weekly-trend view is "sparse" when either the number of weeks carrying
 * any activity or the total events backing the chart are below the thresholds
 * at which visual trend reading becomes defensible. The chart still renders;
 * the caller labels the uncertainty.
 */
export function isSparseTrend(
  nonEmptyWeeks: number,
  chartEvents: number,
): boolean {
  return (
    nonEmptyWeeks < SPARSE_MIN_NON_EMPTY_WEEKS ||
    chartEvents < SPARSE_MIN_EVENTS
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function windowDays(tw: TrendWindow): number | null {
  if (tw === '7d') return 7;
  if (tw === '30d') return 30;
  if (tw === '90d') return 90;
  return null;
}

function earliestHistoryAt(
  attempt: ContributionAttempt,
  state: AttemptState,
): string | null {
  let earliest: string | null = null;
  for (const obs of attempt.history) {
    if (obs.state !== state) continue;
    if (earliest === null || obs.at < earliest) earliest = obs.at;
  }
  return earliest;
}

/**
 * Canonical "opened" timestamp for productivity tracking.
 * Prefers the first pr_open observation. Falls back to attempt.createdAt
 * for PRs whose first observation was already merged/closed (refresh-backfilled).
 * Returns null only for scouted-only records.
 */
function openedAt(attempt: ContributionAttempt): string | null {
  if (attempt.state === 'scouted') return null;
  const firstOpen = earliestHistoryAt(attempt, 'pr_open');
  if (firstOpen) return firstOpen;
  return attempt.createdAt ?? null;
}

/** Canonical "merged" / "closed" timestamps — strict, no fallback. */
function terminalAt(
  attempt: ContributionAttempt,
  state: 'merged' | 'closed',
): string | null {
  return earliestHistoryAt(attempt, state);
}

function summarizePeriod(
  prRecords: ContributionAttempt[],
  rangeStart: number,
  rangeEnd: number,
): PeriodSummary {
  let opened = 0;
  let merged = 0;
  let closed = 0;
  let openNow = 0;
  let stale = 0;

  for (const a of prRecords) {
    const openedTs = openedAt(a);
    const mergedTs = terminalAt(a, 'merged');
    const closedTs = terminalAt(a, 'closed');

    const openedMs = openedTs ? Date.parse(openedTs) : NaN;
    const mergedMs = mergedTs ? Date.parse(mergedTs) : NaN;
    const closedMs = closedTs ? Date.parse(closedTs) : NaN;

    if (!Number.isNaN(openedMs) && openedMs >= rangeStart && openedMs < rangeEnd) {
      opened += 1;
    }
    if (!Number.isNaN(mergedMs) && mergedMs >= rangeStart && mergedMs < rangeEnd) {
      merged += 1;
    }
    if (!Number.isNaN(closedMs) && closedMs >= rangeStart && closedMs < rangeEnd) {
      closed += 1;
    }

    // "Open now" at rangeEnd: opened before rangeEnd AND not yet terminal by rangeEnd.
    // Zombie PRs are subtracted from openNow and counted separately under `stale`
    // so the invariant `opened === merged + closed + openNow + stale` holds.
    if (!Number.isNaN(openedMs) && openedMs < rangeEnd) {
      const mergedByEnd = !Number.isNaN(mergedMs) && mergedMs < rangeEnd;
      const closedByEnd = !Number.isNaN(closedMs) && closedMs < rangeEnd;
      if (!mergedByEnd && !closedByEnd) {
        if (isStale(a)) {
          stale += 1;
        } else {
          openNow += 1;
        }
      }
    }
  }

  const totalDecided = merged + closed;
  const mergeRate = totalDecided > 0 ? merged / totalDecided : null;

  return { opened, merged, closed, openNow, stale, mergeRate, totalDecided };
}

/** Return UTC-Monday-00:00 timestamp (ms) containing the given instant. */
function utcMondayStart(ms: number): number {
  const d = new Date(ms);
  const dow = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysBack = dow === 0 ? 6 : dow - 1;
  const monday = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - daysBack,
  );
  return monday;
}

function formatWeekLabel(weekStartMs: number): string {
  const d = new Date(weekStartMs);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = d.getUTCDate();
  return `${month} ${day}`;
}

function formatIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function computeWeeklyBars(
  prRecords: ContributionAttempt[],
  rangeStart: number,
  rangeEnd: number,
): WeeklyBar[] {
  const weekStart = utcMondayStart(rangeStart);
  const weekEnd = utcMondayStart(rangeEnd - 1) + WEEK_MS;
  const buckets = new Map<number, { opened: number; merged: number }>();
  for (let w = weekStart; w < weekEnd; w += WEEK_MS) {
    buckets.set(w, { opened: 0, merged: 0 });
  }

  for (const a of prRecords) {
    const openedTs = openedAt(a);
    const mergedTs = terminalAt(a, 'merged');

    if (openedTs) {
      const ms = Date.parse(openedTs);
      if (!Number.isNaN(ms) && ms >= rangeStart && ms < rangeEnd) {
        const bucket = utcMondayStart(ms);
        const b = buckets.get(bucket);
        if (b) b.opened += 1;
      }
    }
    if (mergedTs) {
      const ms = Date.parse(mergedTs);
      if (!Number.isNaN(ms) && ms >= rangeStart && ms < rangeEnd) {
        const bucket = utcMondayStart(ms);
        const b = buckets.get(bucket);
        if (b) b.merged += 1;
      }
    }
  }

  const bars: WeeklyBar[] = [];
  for (const [weekStartMs, counts] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    bars.push({
      weekStart: formatIsoDate(weekStartMs),
      weekLabel: formatWeekLabel(weekStartMs),
      opened: counts.opened,
      merged: counts.merged,
    });
  }
  return bars;
}

/** Exclude scouted-only records — productivity is measured in PRs, not scouts. */
function prRecords(attempts: ContributionAttempt[]): ContributionAttempt[] {
  return attempts.filter((a) => a.state !== 'scouted');
}

function earliestOpenedMs(prs: ContributionAttempt[]): number | null {
  let earliest: number | null = null;
  for (const a of prs) {
    const ts = openedAt(a);
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
}

/**
 * Compute growth trend summary + weekly bars for the OSS productivity view.
 * Pure: does not touch window.*, Date.now(), or any mutable state.
 * `nowMs` is injected so tests can pin the clock.
 */
export function computeOssTrends(
  attempts: ContributionAttempt[],
  trendWindow: TrendWindow,
  nowMs: number,
): TrendsResult {
  const prs = prRecords(attempts);
  const days = windowDays(trendWindow);

  let currentStart: number;
  let currentEnd: number = nowMs;
  let prior: PeriodSummary | null;

  if (days === null) {
    // "all" — from earliest opened PR (or nowMs if none) to now; no prior period.
    currentStart = earliestOpenedMs(prs) ?? nowMs;
    prior = null;
  } else {
    currentStart = nowMs - days * DAY_MS;
    const priorStart = nowMs - 2 * days * DAY_MS;
    prior = summarizePeriod(prs, priorStart, currentStart);
  }

  const current = summarizePeriod(prs, currentStart, currentEnd);
  const weeklyBars = computeWeeklyBars(prs, currentStart, currentEnd);
  const nonEmptyWeeks = weeklyBars.filter((b) => b.opened > 0 || b.merged > 0).length;

  return { current, prior, weeklyBars, nonEmptyWeeks };
}

/** Delta display helpers — kept here so the view stays declarative. */
type DeltaDirection = 'up' | 'down' | 'flat';

export interface DeltaDisplay {
  direction: DeltaDirection;
  label: string;
}

const PRIOR_MIN_OPENED = 3;
const PRIOR_MIN_DECIDED = 3;

/**
 * Integer count delta. Returns null when delta shouldn't be shown
 * (no prior period, or prior period too sparse to be meaningful).
 *
 * Gates on prior.opened: if fewer than N PRs originated in the prior period,
 * any count delta is dominated by noise rather than trend.
 */
export function countDelta(
  current: number,
  prior: PeriodSummary | null,
  priorValue: number,
): DeltaDisplay | null {
  if (!prior) return null;
  if (prior.opened < PRIOR_MIN_OPENED) return null;
  const diff = current - priorValue;
  if (diff === 0) return { direction: 'flat', label: '─ no change' };
  const sign = diff > 0 ? '+' : '';
  return {
    direction: diff > 0 ? 'up' : 'down',
    label: `${diff > 0 ? '▲' : '▼'} ${sign}${diff}`,
  };
}

/**
 * Percentage-point delta for merge rate (null when either side unavailable).
 * Gates on prior.totalDecided because a rate computed from <3 decided PRs
 * is noise, independent of how many were opened.
 */
export function mergeRateDelta(
  current: number | null,
  prior: PeriodSummary | null,
): DeltaDisplay | null {
  if (!prior) return null;
  if (prior.mergeRate === null || current === null) return null;
  if (prior.totalDecided < PRIOR_MIN_DECIDED) return null;
  const pp = Math.round((current - prior.mergeRate) * 100);
  if (pp === 0) return { direction: 'flat', label: '─ 0pp' };
  const sign = pp > 0 ? '+' : '';
  return {
    direction: pp > 0 ? 'up' : 'down',
    label: `${pp > 0 ? '▲' : '▼'} ${sign}${pp}pp`,
  };
}

export function priorWindowLabel(window: TrendWindow): string {
  if (window === 'all') return '';
  return `vs prev ${window}`;
}
