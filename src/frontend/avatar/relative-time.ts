/**
 * How long ago a spoken message arrived, in the short form the avatar panel's
 * message list shows: "just now", "5 min ago", "3 h ago", "2 d ago".
 *
 * Each unit starts exactly at its boundary (60 s, 60 min, 24 h) and rounds down,
 * so a label never claims more time than has passed. A time in the future (clock
 * adjusted backwards) counts as "just now".
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRelativeTime(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}
