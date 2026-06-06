/**
 * Scheduled quiet-hours (Do-Not-Disturb) windows.
 *
 * A window silences audible chimes and desktop notifications while local
 * wall-clock time falls inside it. Times are local "HH:MM" (24h) — quiet hours
 * are a human, time-of-day concept, so they intentionally track the operator's
 * local clock (and therefore DST) rather than a fixed UTC offset.
 *
 * Shared by the server settings validator ({@link ../../core/settings-store})
 * and the frontend DND hook so the window schema and the window math have a
 * single source of truth.
 */

export interface QuietHoursWindow {
  /** Inclusive start, local time, "HH:MM" 24h. */
  start: string;
  /** Exclusive end, local time, "HH:MM" 24h. May be < start to wrap past midnight. */
  end: string;
  /**
   * Days of week the window *starts* on (0 = Sunday … 6 = Saturday). Omitted or
   * empty means every day. For a window that wraps past midnight the day refers
   * to the start day, so `{ start: '22:00', end: '08:00', days: [5] }` covers
   * Friday 22:00 → Saturday 08:00.
   */
  days?: number[];
}

/** Upper bound on stored windows so a hand-edited settings file can't unbound the UI/loop. */
export const MAX_QUIET_HOURS_WINDOWS = 20;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse "HH:MM" (24h) to minutes since local midnight, or null when malformed. */
export function parseHhMm(value: string): number | null {
  const match = HH_MM.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function normalizeDays(raw: unknown): { days?: number[]; warning?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) return { warning: 'quietHours window "days" must be an array of 0-6; ignoring' };
  const seen = new Set<number>();
  let dropped = false;
  for (const entry of raw) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 6) {
      seen.add(entry);
    } else {
      dropped = true;
    }
  }
  // An empty (or fully-invalid) days list means "every day"; encode that as
  // omitted rather than an empty array so consumers have one canonical form.
  const days = seen.size === 7 || seen.size === 0 ? undefined : [...seen].sort((a, b) => a - b);
  return { days, ...(dropped ? { warning: 'quietHours window "days" had invalid entries; dropped' } : {}) };
}

export interface QuietHoursValidationResult {
  windows: QuietHoursWindow[];
  warnings: string[];
}

/**
 * Validate and normalize a raw `quietHours` value into a clean window list.
 * Invalid windows are dropped (never throw) and each drop adds a warning so the
 * settings UI can surface what was ignored. Equal start/end is rejected — it is
 * ambiguous between "never" and "all day".
 */
export function validateQuietHours(raw: unknown): QuietHoursValidationResult {
  if (raw === undefined) return { windows: [], warnings: [] };
  if (!Array.isArray(raw)) {
    return { windows: [], warnings: ['quietHours must be an array of windows; ignoring'] };
  }

  const windows: QuietHoursWindow[] = [];
  const warnings: string[] = [];

  for (const entry of raw) {
    if (windows.length >= MAX_QUIET_HOURS_WINDOWS) {
      warnings.push(`quietHours capped at ${MAX_QUIET_HOURS_WINDOWS} windows; extra windows ignored`);
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      warnings.push('quietHours window must be an object; ignoring');
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const start = typeof candidate.start === 'string' ? candidate.start : '';
    const end = typeof candidate.end === 'string' ? candidate.end : '';
    if (parseHhMm(start) === null || parseHhMm(end) === null) {
      warnings.push(`quietHours window has invalid time(s) ${JSON.stringify({ start: candidate.start, end: candidate.end })}; ignoring`);
      continue;
    }
    if (start === end) {
      warnings.push(`quietHours window start equals end (${start}); ignoring ambiguous window`);
      continue;
    }
    const { days, warning } = normalizeDays(candidate.days);
    if (warning) warnings.push(warning);
    windows.push(days ? { start, end, days } : { start, end });
  }

  return { windows, warnings };
}

function dayMatches(window: QuietHoursWindow, day: number): boolean {
  return window.days === undefined || window.days.length === 0 || window.days.includes(day);
}

/**
 * Is `now` (local time) inside any quiet-hours window?
 *
 * Same-day windows (`start < end`) are active on a matching day between
 * `[start, end)`. Wrap windows (`start > end`) split across midnight: the
 * evening half `[start, 24:00)` is gated on the start day, and the morning half
 * `[00:00, end)` is gated on the *previous* day (the day the window started).
 */
export function isWithinQuietHours(windows: readonly QuietHoursWindow[], now: Date): boolean {
  if (windows.length === 0) return false;
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const prevDay = (day + 6) % 7;

  for (const window of windows) {
    const start = parseHhMm(window.start);
    const end = parseHhMm(window.end);
    if (start === null || end === null || start === end) continue;

    if (start < end) {
      if (minutes >= start && minutes < end && dayMatches(window, day)) return true;
    } else {
      // Wraps midnight.
      if (minutes >= start && dayMatches(window, day)) return true;
      if (minutes < end && dayMatches(window, prevDay)) return true;
    }
  }
  return false;
}
