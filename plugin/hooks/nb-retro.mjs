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
// NB_DIR with a leading `~` expanded the way agent-notebook and bin/nb.js expand it
// (only `~` and `~/…`; `~user/…` stays as it is). Set where no shell expands it
// (settings.json, systemd, cron), NB_DIR reaches the hook with the `~` still in it.
// A copy of `expandHomeDir` in bin/nb.js. Keep the two in step by hand: the plugin ships
// without the repository, so neither can import the other.
function expandHomeDir(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (process.platform === 'win32' && value.startsWith('~\\')) return join(homedir(), value.slice(2));
  return value;
}
const dir =
  process.env.NB_DIR && process.env.NB_DIR.trim() !== ''
    ? expandHomeDir(process.env.NB_DIR)
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
// that session a second time. NB_RETRO_TTL_DAYS=Infinity never prunes (an addition to
// upstream's recipe); `0`, a negative or a non-numeric value means 7, as upstream reads
// it. Best-effort; never fatal.
try {
  const ttlDays = Number(process.env.NB_RETRO_TTL_DAYS);
  const ttlMs = (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 7) * 86_400_000;
  const cutoff = ttlDays === Infinity ? -Infinity : Date.now() - ttlMs;
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
// Inside a Kookr task (issue #4141): the server treats any tool call other than
// `kookr signal` as resumed work and clears a pending completion signal. A task that
// signalled completion-ready and then stopped would have its signal cleared by the very
// nb votes this hook asks for, and would sit "in progress". So tell it to re-signal
// last. Outside a Kookr task there is no signal to lose and the text is unchanged.
const kookrTaskId = (process.env.KOOKR_TASK_ID ?? '').trim();
const resignalHint = kookrTaskId
  ? `Kookr task: if you had already run \`kookr signal completion-ready\` before this reminder, ` +
    `run it again (same --note) as your LAST call, after the retrospective: any other tool call, ` +
    `nb included, clears a pending completion signal.\n`
  : '';
// Inside a Kookr task (issue #4250): ideas for changing a tool, skill, doc or check go to
// the separate idea store (`kookr idea`, agent-notebook in ~/.kookr/ideas), where a repeat
// becomes a vote and the curator promotes the best-scored ones to issues. Only offered in
// a Kookr task, where the `kookr` command is on PATH.
const ideaHint = kookrTaskId
  ? `Ideas: if this task showed that a tool, skill, doc or check should change (a fix to make, ` +
    `not a lesson to remember), run \`kookr idea show\`, then vote for a matching idea ` +
    `(\`kookr idea vote <id> +1\`) or record at most one new one: ` +
    `\`kookr idea add "<what is wrong or missing> -> <proposed change>"\`, naming the file or ` +
    `command. Ideas have their own store; never put them on a notebook shelf.\n`
  : '';
process.stderr.write(
  `Before finishing, run the agent-notebook retrospective on the shelves you opened this task ` +
    `(one pass, then stop). Steps 1-4 apply only to shelves you opened; if you opened none, skip ` +
    `them, but step 5 still applies: a task that taught something a future agent would need may ` +
    `seed a first lesson. Put it on a shelf from the session index (\`nb list\` shows it) if one ` +
    `fits; create a new shelf (it is created on its first add) only if none does:\n` +
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
    `     Keep only what stays true at another commit and on another task: how to build, test or run ` +
    `the code, a convention, a tool or environment gotcha. Never what you just changed or how this ` +
    `task was fixed: the next task may start from a commit where that code does not exist.\n` +
    `     Placement: add to <situation>@<slug> (slug = $KOOKR_REPO_SLUG${slugHint}) unless the lesson ` +
    `would be true in another repo, then add it to the unscoped <situation> shelf instead. ` +
    `Never write fleet-global directly.\n` +
    `Do not pad to hit a quota: "nothing new worth storing" is a valid outcome. ` +
    `When done, finish as you normally would; this reminder won't repeat this session.\n` +
    ideaHint +
    resignalHint,
);
process.exit(2);
