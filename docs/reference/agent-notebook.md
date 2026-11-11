# Agent Notebook (`nb`)

A bounded, voted, plain-text memory per kind of task. kookr calls one such
notebook a **shelf** (the grouping of lessons for one kind of task); the `nb` CLI
calls the same thing a `<role>`, so command syntax below keeps `<role>`. Shelves
let agents get better at a job across tasks without the memory ever growing
unbounded or rotting. Design rationale: [`docs/rfc/rfc-self-improving-agent-fleet.md`](../rfc/rfc-self-improving-agent-fleet.md).

**The one rule that makes it safe:** a shelf holds at most **50 lines**, each
a single lesson of at most **200 characters**, each with a vote **score**. Eviction
is recency-aware and a full shelf **always admits a newcomer**: when full, `nb add`
evicts the **lowest-scored** line (ties: stalest), then docks the stalest
survivor one point. There is no "rejected, notebook full" dead end. A shelf is tiny
by construction, so it is read **whole** — no retrieval, no embeddings. The cap,
the vote, and that eviction rule are the entire mechanism; `nb list` is the index
of shelves.

## Access the tool

`nb` is a local CLI (plain text, no network) — faster and more reliable than
`kb`, with no spool-degradation mode. kookr **dogfoods its own published tool**:
the `nb` command is the public [`agent-notebook`](https://www.npmjs.com/package/agent-notebook)
npm package (a spin-out of this very tool), consumed as a dependency rather than
a vendored fork. The kookr entrypoint `bin/nb.js` resolves that package and pins
the notebooks directory to `~/.kookr/notebooks` (the package default is
`~/.agent-notebook/notebooks`), so existing notebooks and the usage ring keep
their location. To change `nb` behavior, land the change in `agent-notebook` and
bump the dependency — kookr no longer carries a divergent copy.

```
nb list                                 the index: every shelf + lesson count + one-line description
nb search <kw>                          secondary keyword fallback across shelves
nb show   <role> [--json]               print the shelf (highest-scored first)
nb add    <role> "<lesson>"             add a lesson (dedup-skipped, capped; a full shelf evicts to admit it)
nb vote   <role> <id[,id…]|query> +1|-1 upvote/downvote entries you used (several ids at once is fine)
nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
nb rm     <role> <id|query>             delete an entry
nb describe <role> "<desc>"             set the shelf's one-line description (shown by nb list)
nb split  <role> <id> "<a>" "<b>"       split one overloaded entry into two (reverse of merge)
nb move   <from> <to> <id|query>        move an entry to another shelf, keeping its score (promotion)
nb path                                 print NB_DIR
nb stats  [<role>] [--since 7d]         usage analytics + anomaly flags
nb --help                               this help
nb --version                            print the tool name
```

- `add` / `merge` / `rm` / `split` / `describe` accept an optional `--reason <code>` (+ `--note`); `vote` does not.
- `<role>` is a shelf name like `patch-author`. For knowledge that is
  repo-specific, scope it: `patch-author@<owner>-<repo>` (the project layer; the unscoped name is the domain layer).
- `<id>` is the short **stable** token `nb show` prints at the start of each line
  (content-derived, so it does not shift when other lessons are added or
  reordered). Pass it — or a unique prefix of it — to `vote`/`rm`/`merge`. A
  unique text substring also selects an entry; an ambiguous one (0 or >1 match)
  is refused so a vote never lands on the wrong lesson.
- A lesson is flattened to a single line. One longer than 200 chars is
  **rejected** (`nb add` exits 1), never truncated — rewrite it shorter and
  retry, so you never store a cut-off, useless entry. A lesson that needs a
  paragraph is a *procedure* — put it in a `SKILL.md`, not the notebook.

### Where notebooks live

`$NB_DIR` or `~/.kookr/notebooks/<shelf>.md`. Plain text, one `+<score>\t<lesson>`
per line — human-readable, `git`-diffable, hand-editable. To fix a bad lesson,
downvote it, `nb rm` it, or just edit the file.

### Git-backed persistence (optional, mirrors the knowledge-bases backup)

The notebooks directory can be a **private git repo**, exactly like
`~/knowledge_bases`. When `~/.kookr/notebooks/.git` exists:

- **Every notebook mutation commits.** `bin/nb.js` runs `git add -A && git commit`
  after a successful `add` / `vote` / `merge` / `rm` / `split` / `move` / `describe`, so `main` carries one commit
  per change. Reads (`show` / `stats`) never commit. Fail-open: a git error never
  fails the `nb` call (the lesson is already on disk). Opt out with
  `NB_GIT_AUTOCOMMIT=0`.
- **A daily job pushes.** `scripts/nb-backup.sh` (run from cron) commits any
  straggler and pushes the accumulated commits to the private remote. Unlike the
  KB auto-backup it pushes even when the tree is clean, because per-change commits
  accumulate between daily runs. Idempotent, locked, `--force`-free.

To enable it (one-time host setup):

```sh
cd ~/.kookr/notebooks
git init && git branch -M main
printf '.nb-usage.log*\n.nb-backup.log*\n.retro-*\n.nb.lock\n*.tmp\n' > .gitignore
git add -A && git commit -m "init agent notebooks"
gh repo create <you>/agent-notebooks --private --source=. --remote=origin --push
# daily push at 03:10 (after the 03:00 KB backup). Adjust the script path to
# your kookr checkout (here: ~/git/kookr):
( crontab -l 2>/dev/null; echo "10 3 * * * NB_DIR=$HOME/.kookr/notebooks $HOME/git/kookr/scripts/nb-backup.sh" ) | crontab -
```

The `.gitignore` keeps the churny usage ring, backup log, and retro sentinels out
of history — only the `<shelf>.md` lesson files are versioned.

> **Only point `NB_DIR` at a dedicated notebooks directory.** The per-change
> `git add -A` commits everything in `NB_DIR`; aiming it at a real source repo
> would sweep unrelated working-tree changes into an `nb …` commit. The default
> `~/.kookr/notebooks` is safe.

## Read the analytics

`nb stats` turns the usage log into per-command health and flags anomalies:

```
nb stats                 # whole fleet, last 7 days
nb stats patch-author    # one shelf
nb stats --since 24h     # a tighter window
```

It reports, per command: calls, error rate, p50/p95 latency, last-used — and
three **anomaly flags**:

| Flag | Meaning | Likely cause |
|---|---|---|
| `loop` | an agent called one command many times in a tight window | the agent is stuck / looping |
| `went-silent` | a command used historically, 0 calls in the window | the command broke or was abandoned |
| `high-error-rate` | a command erroring on a large fraction of calls | broken, or not behaving as the agent expects |

Use these to decide whether the tool needs a fix or an agent needs attention.
Monitoring is itself bounded: every `nb` call appends **one line** to
`~/.kookr/notebooks/.nb-usage.log`, an oldest-dropped ring — there is no metrics
server or dashboard to run.

## The hooks (how the ritual is guaranteed)

The integration is **role-agnostic**: kookr does not pick a shelf for a session.
Two plugin hooks (registered in `plugin/hooks/hooks.json`, each a `.sh` wrapper
that runs its `.mjs`) run for every session:

- **SessionStart → `nb-inject.sh`** (runs `nb-inject.mjs`): injects the `nb list`
  index — every shelf, its lesson count, and its one-line "open me when…"
  description — into context. The agent reads the index and opens the shelves
  that fit its task; nothing picks one for it.
  The index is capped at 60 rows / 8 KB (richest shelves first, with a
  "N more shelves not shown" tail). If `nb list` times out or exits non-zero the
  hook prints a one-line `WARNING` on stdout, so a broken store is not mistaken
  for an empty one; a missing `nb` stays silent. It always exits 0.
- **Stop / SubagentStop → `nb-retro.sh`** (runs `nb-retro.mjs`): blocks the first
  stop of a session once (per-session sentinel file claimed atomically, so parallel
  subagent stops yield exactly one nudge; `stop_hook_active` lets a re-run
  through) and shows the maintenance checklist — vote up what helped and vote down
  what misled (several ids per call), **`nb rm --reason wrong|obsolete`** what proved
  incorrect, `nb merge`/`split` redundant or overloaded entries, and `nb add` at
  most one new lesson (aim ~150 characters; the text also carries the placement
  rule: `<situation>@<slug>` unless the lesson is true in another repo, never
  `fleet-global` directly) — then allows the stop. Sentinels older than
  `NB_RETRO_TTL_DAYS` (default 7) are pruned; an event with no `session_id`
  shares one sentinel, so it is nudged at most once per TTL window.
  No-op when `NB_RETRO_DISABLED` is set (operator opt-out).

**`KOOKR_REPO_SLUG`.** The launcher exposes the `<owner>-<repo>` slug, derived
from the repo's remote (`src/adapters/agent-launch-context.ts`) — e.g.
`github.com/kookr-ai/kookr` → `kookr-ai-kookr`. It is used only so repo-scoped
shelves, such as the reviewer fan-out's `code-review@<owner>-<repo>`, can be
addressed. Derivation is fail-open: when no safe slug forms, the variable is
unset and callers fall back to the unscoped shelf name.

**Placement advisories.** After a successful `nb add`, `bin/nb.js` prints a one-line
stderr advisory (never a refusal; the lesson is still written) when the shelf is
`fleet-global` (unless `KOOKR_NB_CURATOR` is set), or a `<situation>@<slug>` shelf
whose slug differs from `KOOKR_REPO_SLUG`. They make a lesson written to the wrong
layer, or into another repo's shelf, visible to the agent that wrote it. The slug
check is skipped when `KOOKR_REPO_SLUG` is unset.

Specialized subagents invoked via the `Agent` tool get no SessionStart
injection (they are subagents), so each agent definition carries the same
**Notebook Protocol** block and runs the steps itself. **Every specialized agent
that has a notebook section** (23 of the 25 `plugin/agents/*.md`; `product-owner`
and `user-test-simulator` have none and write nothing) opens both layers of its
shelf: `nb show <shelf>`, then `nb show <shelf>@$KOOKR_REPO_SLUG` when the slug is
set and the task works in the session's own repo (the project layer wins on
conflict). At the end it batch-votes by id, removes with
`nb rm … --reason wrong|obsolete`, and adds at most one lesson (about 150
characters) to the project shelf unless the lesson is true in another repo, then
to the unscoped shelf. It never writes `fleet-global`. This is the same placement
rule the retrospective nudge above states.

Two limits are accepted. (1) A subagent inherits its parent's `KOOKR_REPO_SLUG`
even when its task is in another repo, so the block tells it to use the slug only
when the task works in the session's own repo. (2) The block reads the literal
name `<shelf>@$KOOKR_REPO_SLUG`, so a shelf written earlier under a different
spelling of the repo's slug (a legacy slug) is not read until it is migrated to
the current slug. Opening a project shelf that does not exist is harmless: `nb show`
exits 0 and creates nothing, though `nb stats` may list it as shown but never voted.

The block has one source, `plugin/skills/notebook-role-reuse/references/notebook-protocol.md`.
`node scripts/apply-notebook-protocol.mjs` copies it into each agent doc (with the
agent's own shelf name), and `src/plugin/notebook-protocol.test.ts` fails when a
doc differs from the source, hardcodes a bare shelf with no project line, or
restates `nb`'s own limits. Edit the source and rerun the script; do not edit the
block inside an agent doc.

## Memory layers and the store tooling

Lessons live at three layers, and the layer is read from the shelf **name**
alone (nothing is stored inside the shelf file). A *project* shelf is
`<situation>@<slug>`: true only in one repo, where the slug is `KOOKR_REPO_SLUG`
(`owner-repo`). A *domain* shelf is a bare `<situation>`: true in any repo. The
*global* layer is the single shelf `fleet-global`: facts about this host that hold
for every agent, written by convention only by promotion (an agent that `nb add`s
there directly gets a warning, not a refusal). The narrowest true layer wins on
conflict (project over domain over global). The design and its evidence are in
[rfc-notebook-memory-layers.md](../rfc/rfc-notebook-memory-layers.md).

Three pieces of tooling keep the store in line with that decision. In what follows, a shelf's *base* is the part of its name before the slug (`code-review` in `code-review@kookr-ai-kookr`), and the *shim* is `bin/nb.js`, the wrapper around `nb` that pins the notebooks directory and commits every change. Run them from
the Kookr checkout; they read the store through `nb` (honoring `NB_DIR`) and write
only through `nb`, never by editing a shelf file.

- **`plugin/hooks/lib/notebook-layers.mjs`** is the one place that classifies a
  shelf name: it splits on the **last** `@`, compares the slug case-insensitively
  after trimming, and resolves legacy slugs through
  `plugin/notebooks/slug-aliases.json` (`{"agent-notebook": "jeanibarz-agent-notebook"}`,
  a legacy slug on the left, the slug `KOOKR_REPO_SLUG` produces on the right).
  `a@b@c` is the project shelf `a@b` of repo `c`; `a@@c` is `a@` of repo `c`.
- **`scripts/apply-shelf-descriptions.mjs`** seeds the one-line "open me when..."
  descriptions that the `nb list` index shows (`--dry-run` previews). An entry
  with no `@slug` in `plugin/notebooks/shelves.json` (a *trigger*: the situation in
  which to open the shelf) also describes every existing project shelf of that
  base as `<trigger> (only in <slug>)`, so a new base needs one trigger, not one
  per repo. It never creates a shelf, never overwrites a human description,
  and skips legacy-slug shelves (the migration empties them, and `nb` keeps an
  emptied *described* shelf as a 0-lesson row forever) and 0-byte files.
- **`scripts/migrate-notebook-slugs.mjs`** folds legacy-slug shelves into the
  canonical ones; **`scripts/promote-notebook-lessons.mjs`** finds lessons that
  several repos' project shelves share. Both are **dry-run by default**; `--apply`
  first tags the store's git repo (`pre-slug-migration`, and a fresh `pre-lesson-promotion-<time>` per promotion run)
  and refuses if the store is not a git repository. Only a person runs `--apply`; agents (the reflection playbook) run the dry-run only.

### Slug migration

```
node scripts/migrate-notebook-slugs.mjs            # print the plan (dry-run)
node scripts/migrate-notebook-slugs.mjs --apply    # tag, move, clean up, describe
```

`nb move` keeps a lesson's score and always admits it. When the target shelf is
full (`NB_MAX_LINES`, default 50) `nb` evicts the target's **lowest-scored**
lesson and lowers by one point the score of the remaining lesson touched least
recently (`nb` calls this aging), so moving a weak lesson into a
full shelf destroys a better one. The script therefore simulates the moves one at
a time (highest score first), prints every eviction and point it would cost, and
refuses a move whose lesson does not score strictly **above** a **full** target's
lowest lesson unless `--force-low` is given (an equal swap would only trade one
lesson for another that is no better, and equal-scored lessons would push each
other out one by one). A target already holding more than the cap would lose
several lessons at once, so that is refused too. It also predicts the cases `nb` refuses: a lesson the
target already holds is left on its legacy shelf and listed for a manual decision
(`nb move` prints "skipped" and exits 0, so the script reads the `--json` result,
never the exit code), and a target name over 128 characters is reported before
anything runs. The script never removes a lesson.

On `nb` 0.7.0 moving a shelf's last lesson leaves a 0-byte file that `nb list`
hides but disk keeps; the script deletes exactly those files (size 0, legacy
shelves only) and commits each deletion, re-runs the description seed for the
migrated repo's shelves, and confirms every legacy shelf is gone from disk and
from `nb list --json`, listing any that remain. Re-running resumes: every move
re-reads the store, and a run after completion changes nothing.

Rollback: each `nb move` is its own commit in the store (the shim commits every
change), and so is each 0-byte deletion. Run the migration while no tasks are
running, because agents' own `nb add` and `nb vote` commits land in the same
history. If `git log pre-slug-migration..HEAD` shows only the script's commits,
undo with `git revert --no-edit pre-slug-migration..HEAD` in the notebooks
directory. If agent commits are mixed in, revert only the script's own commits
(subjects starting `nb move`, `nb describe`, `slug migration:`), newest first, so
the agents' lessons survive. Never use `git reset --hard`. A revert can conflict on
a shelf an agent touched afterwards; resolve those by hand, keeping both sides'
lessons. `--apply` refuses to run with `NB_GIT_AUTOCOMMIT=0`, because then the
moves would not be commits at all.

### Lesson promotion

```
node scripts/promote-notebook-lessons.mjs                          # report only
node scripts/promote-notebook-lessons.mjs --apply                  # exact groups
node scripts/promote-notebook-lessons.mjs --apply --only c-1a2b3c  # chosen groups
```

A lesson found in the project shelves of two or more different repos (legacy
slugs resolve first, so `@agent-notebook` and `@jeanibarz-agent-notebook` count as
one repo) is a candidate for the domain shelf. Two tiers, with different powers:

- An **exact group** has equal text after trimming, collapsing whitespace and
  case-folding. `--apply` moves the highest-scored copy to the domain shelf, and
  only after that move succeeded runs `nb rm ... --reason obsolete --note duplicate`
  on the other copies (and only if the domain shelf is re-read and really holds the
  lesson).
- A **candidate group** is a paraphrase: word-set overlap at or above
  `--threshold` (default 0.6, printed). It is **report only**. `--apply --only <id>`
  moves the highest-scored copy up and removes nothing; the paraphrases stay in
  their project shelves. Fuzzy matching never deletes, because a lesson and its
  negation can look alike, and paraphrases can differ in a detail only one copy keeps.

Two more safeguards apply to promotion. Groups are applied highest-scored first,
and promotion runs all its moves first and its removals after, removing a copy only
while the destination demonstrably still holds the lesson (a later move into the
same full shelf could otherwise push the lesson out). Its rollback is the same as
the migration's, from the run's own tag, reverting the commits whose subject starts
`nb move`, `nb rm` or `lesson promotion:`. Like the migration, it deletes the
0-byte leftover of a shelf it moved the last lesson out of.

A value flag with no value (for example `--only "$IDS"` with `IDS` unset) is refused with exit 2 rather than widened to "apply everything". If a promotion stops between an exact group's move and its removals, the leftover project copies are listed as "PROJECT COPIES of a lesson that the domain shelf already holds" with the `nb rm` to run by hand; they are never removed on the strength of a different run. Group ids are stable between runs. Re-running an `--apply --only <ids>` command that already finished is a reported no-op (exit 0, naming the groups that exist now so a typo is obvious); if only some of the ids are gone, the rest are still applied.

A group goes to `fleet-global` only when the reviewer names it in
`--to-global <id>`; the default is always the bare domain shelf. Measured on the
live store on 2026-11-11 (368 project lessons in 24 project shelves) there were **0 exact groups**,
so the first pass yields candidates a person chooses from: the script cannot fill
`fleet-global` unattended. The reflection playbook
(`.kookr/playbooks/agent-notebook-reflection.md`) runs the report; the operator
(or a curator task started with `--apply`) applies it.

`KOOKR_NB_CURATOR` only silences the shim's warning for an `nb add` to
`fleet-global` (the one printed when an agent writes the global shelf outside a
curator run). The scripts above use `nb move` and `nb rm`, which never print
that advisory, so they work with or without it.

## The task-specialist agents

The four **task specialists** each own a shelf, read at both layers:

| Agent (shelf) | Does one thing |
|---|---|
| `repo-cartographer` | maps a repo: where things live, build/test/lint commands |
| `repro-builder` | builds a minimal, deterministic failing reproduction |
| `patch-author` | writes a focused fix against a repro + acceptance |
| `change-verifier` | independently verifies a change meets acceptance |

The main agent stays the orchestrator: it delegates a unit of work to the
specialist that owns it, and composes the result.

Beyond these four, **every specialized review subagent also carries a shelf**
(see each `plugin/agents/*.md` Notebook Protocol). All of them use the same two
layers: the domain shelf named after the agent (`boundary-critic`,
`design-minimalist`, `failure-mode-analyst`, …) for cross-repo methodology, and the
project shelf `<agent>@$KOOKR_REPO_SLUG` for facts true only in one repo
(`dependency-graph-analyzer`, `architecture-drift-detector`, `test-fixer`, … mostly
write the project layer). The top-level session reads the `nb list` index and opens
whichever shelves fit its task.

## Tuning (env)

All optional; defaults match the RFC.

| Env | Default | Meaning |
|---|---|---|
| `NB_DIR` | `~/.kookr/notebooks` | notebooks directory |
| `NB_GIT_AUTOCOMMIT` | `1` (when `NB_DIR` is a git repo) | `0` disables the per-change commit in `bin/nb.js` |
| `KOOKR_NB_CURATOR` | unset | read by `bin/nb.js` only: set (non-empty) by the curator/promotion run so an `nb add` to `fleet-global` prints no stderr advisory. It has no effect on `nb move`/`nb rm`, which the promotion scripts use. Never set it for ordinary tasks. |
| `NB_RETRO_DISABLED` | unset | set (non-`0`) to silence the Stop/SubagentStop retrospective nudge |
| `NB_RETRO_TTL_DAYS` | `7` | age in days after which `nb-retro.mjs` prunes a `.retro-*` sentinel; keep it above your longest session |
| `NB_MAX_LINES` | `50` | max entries per notebook (ceiling 5000); a full notebook evicts to admit a newcomer |
| `NB_MAX_CHARS` | `200` | hard cap per lesson (over-long adds are rejected, not truncated). Agents are *instructed* to aim for about 150 characters — a style target under this ceiling. |
| `NB_USAGE_RING` | `5000` | max lines in the usage log ring |
| `NB_LOOP_N` / `NB_LOOP_WINDOW_S` | `10` / `120` | loop anomaly: N calls within S seconds |
| `NB_SILENT_H` | `48` | went-silent anomaly: hours since last use |
| `NB_ERR_MIN` / `NB_ERR_RATE` | `5` / `0.3` | high-error-rate anomaly: min calls, rate |

Raise `NB_MAX_LINES`/`NB_MAX_CHARS` only if real notebooks show useful lessons
rejected (too long) or evicted too fast.
