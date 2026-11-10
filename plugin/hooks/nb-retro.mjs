#!/usr/bin/env node
// Stop / SubagentStop hook for the Agent Notebook — nudge the end-of-task
// retrospective once per session.
//
// Role-agnostic (follows the published agent-notebook recipe,
// examples/hooks/claude-code/nb-retrospective.sh): it does not guess a shelf.
// The agent already knows which shelves it opened this task (from the injected
// index) and votes/adds to those. Block the first Stop of the session (exit 2)
// with the retrospective checklist as the reason (the same block-then-instruct
// pattern as the lesson gate, issue #1538), then allow subsequent stops.
//
// Fires at most ONCE per session (a per-session sentinel file, claimed atomically).
// Because SubagentStop fires with the PARENT session id, the first stop in a
// session — a subagent's or the main agent's — claims the sentinel and later stops
// are let through: one nudge per whole session, not one per subagent.
//
// Fail-open: unparseable event, already-nudged, or any fs error -> allow (exit 0).
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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

// Claim this session's sentinel atomically. `wx` makes create-if-absent one OS step,
// so when parallel subagents stop at the same moment (all carry the parent's
// session id) exactly one write wins and the others get EEXIST: another agent
// already nudged, so exit silently. A check-then-write (existsSync + writeFile)
// would let two racers both pass the check and both nudge.
//
// Any OTHER failure to record the sentinel (unwritable dir, no space) also allows the
// stop. Deliberate: a store we cannot write is one the agent cannot add lessons to
// either, so the retrospective would be pointless, and without a sentinel the nudge
// would repeat at every stop.
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sentinel, new Date().toISOString(), { flag: 'wx' });
} catch {
  process.exit(0);
}

// Keep the sentinels bounded (the notebook's whole premise is boundedness): drop any
// `.retro-*` sentinel older than the TTL. The TTL (days, default 7, override with
// NB_RETRO_TTL_DAYS, matching upstream's recipe) must stay well above any plausible
// session length: a sentinel pruned while its session is still running would nudge
// that session a second time. Best-effort; never fatal.
try {
  const ttlDays = Number(process.env.NB_RETRO_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7) * 86_400_000;
  const cutoff = Date.now() - ttlMs;
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

// Text follows upstream's retrospective (examples/hooks/claude-code/nb-retrospective.sh):
// batch vote by id, valid --reason codes, "aim ~150 chars". The placement rule is in
// THIS text, not only in the SessionStart index, because the first agent to stop —
// often a subagent that never saw that index — receives the one nudge.
const slug = (process.env.KOOKR_REPO_SLUG ?? '').trim();
const slugHint = slug ? ` (here: ${slug})` : '';
process.stderr.write(
  `Before finishing, run the agent-notebook retrospective on the shelves you opened this task ` +
    `(one pass, then stop; skip it entirely if you opened none):\n` +
    `  1. nb vote <shelf> <id1,id2,…> +1   the lessons that actually helped ` +
    `(an <id> is the short token at the start of each \`nb show\` line; several ids at once is fine)\n` +
    `  2. nb vote <shelf> <id1,id2,…> -1   the lessons that misled you or wasted your time ` +
    `(vote takes no --reason)\n` +
    `  3. nb rm   <shelf> <id> --reason wrong|obsolete   a lesson that is incorrect (wrong) ` +
    `or was true but no longer applies (obsolete)\n` +
    `  4. nb merge <shelf> <idA> <idB> "<merged lesson>"  or  nb split <shelf> <id> "<a>" "<b>"   ` +
    `only if lessons repeat or one line holds two\n` +
    `  5. nb add  <shelf> "<lesson>"   at MOST one new, non-obvious lesson, or none. ` +
    `Aim for ~150 characters, one clause, no preamble.\n` +
    `     Placement: add to <situation>@<slug> (slug = $KOOKR_REPO_SLUG${slugHint}) unless the lesson ` +
    `would be true in another repo, then add it to the unscoped <situation> shelf instead. ` +
    `Never write fleet-global directly.\n` +
    `Do not pad to hit a quota: "nothing new worth storing" is a valid outcome. ` +
    `When done, finish as you normally would; this reminder won't repeat this session.\n`,
);
process.exit(2);
