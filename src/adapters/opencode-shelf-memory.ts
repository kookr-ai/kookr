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
    const body = truncateBytes(out, Math.min(perShelf, budget));
    budget -= Buffer.byteLength(body, 'utf8');
    blocks.push(`### ${shelf}\n${body}`);
  }
  if (blocks.length === 0) return '';
  return [
    '## Lessons from your shelves',
    'These lessons come from the notebook shelves of your role (highest-scored first, preloaded). Apply them; `nb show <shelf>` gives the full, current list, and at the retrospective vote on the ones you used.',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n');
}
