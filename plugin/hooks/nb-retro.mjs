#!/usr/bin/env node
// Stop / SubagentStop hook for the Agent Notebook — nudge the end-of-task
// retrospective once per session.
//
// Role-agnostic (follows the published agent-notebook recipe,
// examples/hooks/claude-code/nb-retrospective.sh): it does not guess a shelf.
// The agent already knows which shelves it opened this task (from the injected
// index) and votes/adds to those. Block the first Stop of the session (exit 2)
// with the retrospective checklist as the reason (block-then-instruct, the same
// mechanism as the #1538 lesson gate), then allow subsequent stops.
//
// Fires at most ONCE per session (a per-session sentinel). Because SubagentStop
// fires with the PARENT session id, the first stop in a session — a subagent's
// or the main agent's — claims the sentinel and later stops are let through:
// one nudge per whole session, not one per subagent.
//
// Fail-open: unparseable event, already-nudged, or any fs error -> allow (exit 0).
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Operator opt-out: one switch silences the retrospective nudge everywhere.
if (process.env.NB_RETRO_DISABLED && process.env.NB_RETRO_DISABLED !== '0') process.exit(0);

let event = {};
try {
  event = JSON.parse(readFileSync(0, 'utf-8'));
} catch {
  /* fall through with empty event */
}

// Claude Code sets stop_hook_active once it is re-running after a block; never
// block twice in a row, so the agent can always finish.
if (event.stop_hook_active) process.exit(0);

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
  `Agent-notebook retrospective before you finish — this keeps your memory honest.\n` +
    `Run the maintenance cycle on the shelves you actually opened this task (one pass, then stop):\n` +
    `  1. UPVOTE   nb vote <shelf> "<id|query>" +1   each lesson that helped\n` +
    `  2. DOWNVOTE nb vote <shelf> "<id|query>" -1   each lesson that misled or cost you time\n` +
    `  3. REMOVE   nb rm   <shelf> "<id|query>" --reason obsolete   anything incorrect / no longer true\n` +
    `  4. MERGE/SPLIT nb merge|split <shelf> …   only if a shelf is cluttered or redundant\n` +
    `  5. ADD      nb add  <shelf> "<=200-char lesson"   at MOST one new, non-obvious lesson (or none)\n` +
    `Do not pad to hit a quota — "nothing new worth storing" is a valid outcome. A full shelf now always ` +
    `admits a newcomer (it evicts its lowest-scored line), so never skip a worthwhile lesson. Then stop again. ` +
    `(This fires once per session.)\n`,
);
process.exit(2);
