/**
 * Profile-scoped notebook memory for opencode workers.
 *
 * The global `nb` index injected at SessionStart is intentionally global (it only lists shelf
 * names). The shelf CONTENT, however, is scoped to the profile: at launch we run `nb show <shelf>`
 * for each shelf the profile lists and append the result to the session's AGENTS.md, so a worker
 * starts with its own accumulated lessons and never another role's. Everything here is fail-open:
 * a missing `nb`, a missing shelf or a timeout just drops that shelf.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const SHELF_SHOW_TIMEOUT_MS = 4_000;
export const SHELF_MAX_BYTES = 6 * 1024;
export const SHELVES_TOTAL_MAX_BYTES = 16 * 1024;
export const SHELF_TRUNCATION_MARKER = '[... truncated: run `nb show <shelf>` for the rest ...]';

export type ShelfShowRunner = (shelf: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string>;

const defaultShow: ShelfShowRunner = async (shelf, env, timeoutMs) => {
  const { stdout } = await execFileAsync('nb', ['show', shelf], { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  return stdout;
};

function truncateBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  const nl = cut.lastIndexOf('\n');
  if (nl > 0) cut = cut.slice(0, nl);
  return `${cut}\n${SHELF_TRUNCATION_MARKER}`;
}

/** Share of the per-shelf cap reserved for the most recently added lessons. */
export const SHELF_NEWEST_SHARE = 0.35;

// `nb show` line: `<id>  [+3]  <text>`; shelf order is score-descending, ties in insertion order (newest last).
const LESSON_LINE_RE = /^([0-9a-f]{4,})\s+\[([+-]?\d+)\]\s/;

interface ParsedLesson { text: string; score: number; bytes: number }

const byteLen = (t: string): number => Buffer.byteLength(t, 'utf8');

/**
 * Cap a `nb show` listing at `maxBytes` keeping BOTH the highest-scored lessons (the head of the listing)
 * and the most recently added ones. A plain head cut dropped the newest lessons: new lessons start at the
 * bottom score, which sorts last, so on a big shelf they never reached the worker. Falls back to the plain
 * head cut when the text is not a recognisable lesson listing.
 */
export function capShelfListing(shelf: string, text: string, maxBytes: number): string {
  if (byteLen(text) <= maxBytes) return text;
  const lines = text.split('\n');
  const header: string[] = [];
  const lessons: ParsedLesson[] = [];
  for (const line of lines) {
    const m = LESSON_LINE_RE.exec(line);
    if (m) lessons.push({ text: line, score: Number(m[2]), bytes: byteLen(line) + 1 });
    else if (lessons.length === 0) header.push(line);
    else if (/^#/.test(line)) continue; // trailing usage hint; dropped when capping
    else {
      const last = lessons[lessons.length - 1];
      last.text += `\n${line}`;
      last.bytes += byteLen(line) + 1;
    }
  }
  if (lessons.length < 2) return truncateBytes(text, maxBytes);

  const marker = (omitted: number) =>
    `[... truncated: ${omitted} of ${lessons.length} lessons omitted (kept the highest-scored and the most recently added); run \`nb show ${shelf}\` for the rest ...]`;
  const headerBytes = header.reduce((n, l) => n + byteLen(l) + 1, 0);
  const budget = maxBytes - headerBytes - byteLen(marker(lessons.length)) - 1;
  if (budget <= 0) return truncateBytes(text, maxBytes);

  const keep = new Set<number>();
  let used = 0;
  const topBudget = Math.floor(budget * (1 - SHELF_NEWEST_SHARE));
  for (let i = 0; i < lessons.length; i += 1) {
    if (used + lessons[i].bytes > topBudget) break;
    keep.add(i);
    used += lessons[i].bytes;
  }
  // Newest: walk back from the end of the listing, skipping downvoted/zero-score lessons (they sort last
  // but are not "new", they are disfavoured) and anything already kept.
  for (let i = lessons.length - 1; i >= 0; i -= 1) {
    if (keep.has(i) || lessons[i].score <= 0) continue;
    if (used + lessons[i].bytes > budget) continue;
    keep.add(i);
    used += lessons[i].bytes;
  }
  const kept = [...keep].sort((a, b) => a - b).map((i) => lessons[i].text);
  return [...header, ...kept, marker(lessons.length - keep.size)].join('\n');
}

export interface ShelfLessonsOptions {
  env?: NodeJS.ProcessEnv;
  show?: ShelfShowRunner;
  timeoutMs?: number;
  perShelfMaxBytes?: number;
  totalMaxBytes?: number;
  warn?: (msg: string) => void;
}

/** The `## Lessons from your shelves` section, or '' when no shelf yielded content. */
export async function buildShelfLessonsSection(shelves: readonly string[], opts: ShelfLessonsOptions = {}): Promise<string> {
  if (shelves.length === 0) return '';
  const show = opts.show ?? defaultShow;
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? (() => {});
  const perShelf = opts.perShelfMaxBytes ?? SHELF_MAX_BYTES;
  let budget = opts.totalMaxBytes ?? SHELVES_TOTAL_MAX_BYTES;
  const blocks: string[] = [];
  for (const shelf of shelves) {
    let out: string;
    try {
      out = (await show(shelf, env, opts.timeoutMs ?? SHELF_SHOW_TIMEOUT_MS)).trim();
    } catch (err) {
      warn(`[opencode-shelf-memory] nb show ${shelf} failed (${(err as Error).message}); skipping`);
      continue;
    }
    if (!out) continue;
    if (budget <= 0) {
      blocks.push(`### ${shelf}\n${SHELF_TRUNCATION_MARKER}`);
      continue;
    }
    const body = capShelfListing(shelf, out, Math.min(perShelf, budget));
    budget -= Buffer.byteLength(body, 'utf8');
    blocks.push(`### ${shelf}\n${body}`);
  }
  if (blocks.length === 0) return '';
  return [
    '## Lessons from your shelves',
    'These lessons come from the notebook shelves of your role (highest-scored first, preloaded; a long shelf keeps its highest-scored and its newest lessons). Apply them; `nb show <shelf>` gives the full, current list, and at the retrospective vote on the ones you used.',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}
