#!/usr/bin/env node
// SessionStart injector for the Agent Notebook — inject the notebook INDEX so
// the agent starts a task already seeing what experience exists, without
// spending a call.
//
// This follows the published agent-notebook harness recipe
// (examples/hooks/claude-code/nb-session-start.sh): inject `nb list` — the index
// of every notebook (shelf) with its one-line "open me when…" description — and
// let the agent open the shelves that fit its task. It is deliberately
// role-agnostic: there is no NB_ROLE and nothing guesses a per-repo shelf. The
// same injection runs for every session, so a lesson the agent would never
// think to search for still reaches it by meeting a shelf's trigger in the index.
//
// The index is small by construction (one line per shelf), so we inject it directly
// — no retrieval needed (a size bound, below, covers a store that outgrows that).
// Output goes to stdout, which Claude Code adds to
// the session context for a SessionStart hook.
//
// Fail-open everywhere: a session start is never blocked and the exit code is always
// 0. Two failure shapes are told apart, because a broken store must not look empty:
//   - `nb` is not installed (spawn ENOENT): stay silent — hosts without it must not
//     get noise in every session.
//   - `nb` is present but times out or exits non-zero: print a one-line WARNING on
//     STDOUT. Only stdout reaches the agent; stderr from a SessionStart hook never does.
// The injected index is bounded (60 rows / 8 KB) so a large store cannot overflow the
// session context; the rest stays one `nb list` away.
import { execFileSync } from 'node:child_process';

const TIMEOUT_MS = 4000;
const MAX_ROWS = 60;
const MAX_BYTES = 8 * 1024;
const TAIL_RESERVE = 96; // bytes kept free for the "N more" line

let index = '';
try {
  // `nb list` shows 50 rows by default; ask for more so the cap applied below is ours.
  index = execFileSync('nb', ['list', '--limit', '1000'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
} catch (err) {
  const e = /** @type {{ code?: string, status?: number | null, signal?: string | null, stderr?: unknown }} */ (err ?? {});
  if (e.code === 'ENOENT') process.exit(0); // nb not installed — nothing to say
  const why =
    e.code === 'ETIMEDOUT'
      ? `timed out after ${TIMEOUT_MS / 1000}s`
      : e.status != null
        ? `exited with status ${e.status}`
        : e.signal
          ? `was killed by ${e.signal}`
          : `could not run (${e.code ?? 'unknown error'})`;
  const detail = String(e.stderr ?? '').trim().split('\n')[0].slice(0, 200);
  process.stdout.write(
    `## Your agent-notebook index\n` +
      `WARNING: \`nb list\` ${why}${detail ? `: ${detail}` : ''}. The notebook index is ` +
      `unavailable this session; that is not the same as an empty store. ` +
      `Run \`nb list\` yourself to see the error.\n`,
  );
  process.exit(0);
}

// Empty store → `nb list` leaves stdout empty (its "no notebooks yet" notice
// goes to stderr). Nothing to surface → stay silent.
if (!index) process.exit(0);

index = boundIndex(index);

/**
 * Keep the header line plus at most MAX_ROWS rows and MAX_BYTES bytes (whole rows
 * only; rows arrive richest-first, so the ones dropped are the thinnest). Adds a
 * "N more" tail when anything was dropped.
 */
function boundIndex(text) {
  const lines = text.split('\n');
  const hasHeader = !/^\s/.test(lines[0]); // rows are indented; the header is not
  const header = hasHeader ? lines[0] : '';
  const rows = (hasHeader ? lines.slice(1) : lines).filter((l) => l.trim() !== '');
  // The header may itself say "50 of 75": nb knows the true total even if our
  // --limit cut the listing short.
  const totalFromHeader = Number(/ — (?:\d+ of )?(\d+) in /.exec(header)?.[1]);
  const total = Number.isFinite(totalFromHeader) && totalFromHeader >= rows.length ? totalFromHeader : rows.length;

  let used = Buffer.byteLength(header) + 1;
  const kept = [];
  for (const row of rows) {
    const cost = Buffer.byteLength(row) + 1;
    if (kept.length >= MAX_ROWS || used + cost > MAX_BYTES - TAIL_RESERVE) break;
    kept.push(row);
    used += cost;
  }
  const out = (header ? [header] : []).concat(kept);
  if (kept.length < total) {
    const left = total - kept.length;
    out.push(`… ${left} more shel${left === 1 ? 'f' : 'ves'} not shown: run \`nb list --limit 1000\` (or \`nb list <prefix>\`) to see them`);
  }
  return out.join('\n');
}

process.stdout.write(
  `## Your agent-notebook index\n` +
    `Below is an index of your notebooks. Each one is a "shelf": a short, bounded list of ` +
    `one-line lessons for one kind of task, written by you and other agents on past tasks. ` +
    `Each line shows the shelf name, how many lessons it holds, and when to open it.\n` +
    `Open the shelves that fit this task with \`nb show <shelf>\` (the shelf name is the first ` +
    `column) and apply what they say. If the work turns up a new kind of problem, check the ` +
    `index again and open another shelf.\n` +
    `At the end you will be asked for a short retrospective on the shelves you opened — vote the ` +
    `lessons that helped, \`nb rm\` any that were wrong, and \`nb add\` at most one new lesson (or none). ` +
    `Vote by the \`<id>\` \`nb show\` prints at the start of each line, not a fuzzy text query (a ` +
    `non-unique query errors; the tool then prints the candidate ids). A new lesson is one line, ≤200 ` +
    `characters — an over-length \`nb add\` is rejected, not truncated.\n\n` +
    index +
    '\n',
);
process.exit(0);
