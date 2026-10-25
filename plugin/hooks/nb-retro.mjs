#!/usr/bin/env node
// Stop hook for the Agent Notebook — guarantees the end-of-task retrospective.
//
// When the session is running as a specialized role (env NB_ROLE set), block
// the first Stop of the session (exit 2) and instruct the agent to run its
// notebook retrospective: vote +1/-1 on the lessons it used, add at most one
// new lesson, and consolidate/delete if the notebook is full. The stderr text
// is fed back to the agent as the reason it must continue (block-then-instruct,
// the same mechanism as the #1538 lesson gate).
//
// Fires at most ONCE per session (a per-session sentinel), so it nudges the
// retrospective without ever trapping the agent in a stop loop.
//
// Fail-open: NB_ROLE unset, unparseable event, or any fs error -> allow (exit 0).
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const role = process.env.NB_ROLE;
if (!role || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(role)) process.exit(0);

// Operator opt-out. The ritual now fires for every role session (including the
// per-repo top-level `orchestrator@<owner>-<repo>` role set by the launcher), so
// give operators a single switch to silence the retrospective nudge everywhere.
if (process.env.NB_RETRO_DISABLED && process.env.NB_RETRO_DISABLED !== '0') process.exit(0);

let event = {};
try {
  event = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  /* fall through with empty event */
}

const sid = String(event.session_id ?? event.sessionId ?? 'nosession').replace(/[^A-Za-z0-9._-]/g, '_');
const dir =
  process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? process.env.NB_DIR
    : join(homedir(), '.kookr', 'notebooks');
const sentinel = join(dir, `.retro-${sid}`);

// Already nudged this session — let the stop proceed.
if (existsSync(sentinel)) process.exit(0);

try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sentinel, new Date().toISOString());
} catch {
  // Can't record the sentinel -> don't risk a stop loop; allow.
  process.exit(0);
}

// Keep the sentinels bounded (the notebook's whole premise is boundedness):
// drop any `.retro-*` marker older than 24h. Best-effort; never fatal.
try {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('.retro-')) continue;
    try {
      if (statSync(join(dir, f)).mtimeMs < cutoff) unlinkSync(join(dir, f));
    } catch {
      /* skip a sentinel we can't stat/remove */
    }
  }
} catch {
  /* dir vanished — nothing to prune */
}

process.stderr.write(
  `Notebook retrospective (role: ${role}) before you finish — this keeps your memory honest.\n` +
    `Run the full maintenance cycle on the lessons you actually used this task:\n` +
    `  1. UPVOTE   nb vote ${role} "<id|query>" +1   each lesson that helped\n` +
    `  2. DOWNVOTE nb vote ${role} "<id|query>" -1   each lesson that misled or cost you time\n` +
    `  3. REMOVE   nb rm   ${role} "<id|query>"       any lesson you found to be incorrect or no longer true\n` +
    `  4. ADD      nb add  ${role} "<one lesson, <=120 chars>"   only if you learned something reusable\n` +
    `  5. MERGE    nb merge ${role} "<idA>" "<idB>" "<merged>"   if the notebook is full/redundant, consolidate\n` +
    `Then stop again. (This fires once per session.)\n`,
);
process.exit(2);
