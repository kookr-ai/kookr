# Agent Notebook (`nb`)

A bounded, voted, plain-text memory per agent **role**. It lets specialized
sub-agents get better at one job across tasks without the memory ever growing
unbounded or rotting. Design rationale: [`docs/rfc/rfc-self-improving-agent-fleet.md`](../rfc/rfc-self-improving-agent-fleet.md).

**The one rule that makes it safe:** a notebook holds at most **200 lines**, each
a single lesson of at most **200 characters**, each with a vote **score**. When a
new line would overflow, the **lowest-scored** line is evicted (ties: oldest).
The whole notebook is tiny by construction, so it is read **whole** at task start
— no retrieval, no embeddings, no ranking. The cap and the vote are the entire
mechanism.

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
nb show   <role>                        print the notebook (highest-scored first)
nb add    <role> "<lesson>"             add a lesson (dedup-skipped, capped, trimmed)
nb vote   <role> <id|query> +1|-1       upvote/downvote an entry you used
nb merge  <role> <idA> <idB> "<merged>" consolidate two entries into one
nb rm     <role> <id|query>             delete an entry
nb stats  [<role>] [--since 7d]         usage analytics + anomaly flags
nb --help                               this help
nb --version                            print the tool name
```

- `<role>` is a name like `patch-author`. For knowledge that is repo-specific,
  scope it: `patch-author@<owner>-<repo>`.
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

`$NB_DIR` or `~/.kookr/notebooks/<role>.md`. Plain text, one `+<score>\t<lesson>`
per line — human-readable, `git`-diffable, hand-editable. To fix a bad lesson,
downvote it, `nb rm` it, or just edit the file.

### Git-backed persistence (optional, mirrors the knowledge-bases backup)

The notebooks directory can be a **private git repo**, exactly like
`~/knowledge_bases`. When `~/.kookr/notebooks/.git` exists:

- **Every notebook mutation commits.** `bin/nb.js` runs `git add -A && git commit`
  after a successful `add` / `vote` / `merge` / `rm`, so `main` carries one commit
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
printf '.nb-usage.log\n.nb-usage.log.tmp\n.nb-backup.log*\n.retro-*\n.nb.lock\n*.tmp\n' > .gitignore
git add -A && git commit -m "init agent notebooks"
gh repo create <you>/agent-notebooks --private --source=. --remote=origin --push
# daily push at 03:10 (after the 03:00 KB backup). Adjust the script path to
# your kookr checkout (here: ~/git/kookr):
( crontab -l 2>/dev/null; echo "10 3 * * * NB_DIR=$HOME/.kookr/notebooks $HOME/git/kookr/scripts/nb-backup.sh" ) | crontab -
```

The `.gitignore` keeps the churny usage ring, backup log, and retro sentinels out
of history — only the `<role>.md` lesson files are versioned.

> **Only point `NB_DIR` at a dedicated notebooks directory.** The per-change
> `git add -A` commits everything in `NB_DIR`; aiming it at a real source repo
> would sweep unrelated working-tree changes into an `nb …` commit. The default
> `~/.kookr/notebooks` is safe.

## Read the analytics

`nb stats` turns the usage log into per-command health and flags anomalies:

```
nb stats                 # whole fleet, last 7 days
nb stats patch-author    # one role
nb stats --since 24h     # a tighter window
```

It reports, per command: calls, error rate, p50/p95 latency, last-used — and
three **anomaly flags**:

| Flag | Meaning | Likely cause |
|---|---|---|
| `loop` | a role called one command many times in a tight window | the agent is stuck / looping |
| `went-silent` | a command used historically, 0 calls in the window | the command broke or was abandoned |
| `high-error-rate` | a command erroring on a large fraction of calls | broken, or not behaving as the agent expects |

Use these to decide whether the tool needs a fix or a role needs attention.
Monitoring is itself bounded: every `nb` call appends **one line** to
`~/.kookr/notebooks/.nb-usage.log`, an oldest-dropped ring — there is no metrics
server or dashboard to run.

## The hooks (how the ritual is guaranteed)

Two plugin hooks make the start/end ritual automatic for a **role session** —
one whose environment sets `NB_ROLE=<role>`:

- **SessionStart → `nb-inject.sh`**: injects `nb show $NB_ROLE` into context, so
  the agent begins already knowing its lessons. No-op when `NB_ROLE` is unset.
- **Stop → `nb-retro.sh`**: blocks the first stop of the session once and
  instructs the **full maintenance cycle** — upvote the lessons that helped,
  downvote the ones that misled, **`nb rm` any that proved incorrect**, add at
  most one new lesson, and `nb merge` redundant entries when full — then allows
  the stop. Fires at most once per session. No-op when `NB_ROLE` is unset, or
  when `NB_RETRO_DISABLED` is set (operator opt-out).

**Who gets `NB_ROLE`.** Every kookr-launched top-level session is given a
per-repo orchestrator role — `NB_ROLE=orchestrator@<owner>-<repo>`, derived from
the repo's remote (`src/adapters/agent-launch-context.ts`). So the ritual fires
for every session: the session's own per-repo lessons are injected at start and
a retrospective is nudged at end. Derivation is fail-open — an unresolvable repo
simply omits `NB_ROLE` and the hooks no-op.

For an in-process sub-agent invoked via the `Agent` tool (which does not get its
own SessionStart/Stop, so no per-agent `NB_ROLE`), the agent definition instead
instructs the same `nb show` / vote / `rm` / `add` / `merge` steps explicitly —
the hooks and the agent bodies exercise the same `nb` CLI, so the behaviour holds
on both paths. **Every specialized agent** (not just the four task-role agents)
now carries a Notebook Protocol: review subagents keep a cross-repo methodology
notebook; task-role and repo-analysis agents scope theirs per repo.

## The role agents

The four **task-role** specialists each own a repo-scoped notebook:

| Agent (`NB_ROLE`) | Does one thing |
|---|---|
| `repo-cartographer` | maps a repo: where things live, build/test/lint commands |
| `repro-builder` | builds a minimal, deterministic failing reproduction |
| `patch-author` | writes a focused fix against a repro + acceptance |
| `change-verifier` | independently verifies a change meets acceptance |

The main agent stays the orchestrator: it delegates a unit of work to the role
that owns it, and composes the result.

Beyond these four, **every specialized review subagent also carries a notebook**
(see each `plugin/agents/*.md` Notebook Protocol). Review/critic agents
(`boundary-critic`, `design-minimalist`, `failure-mode-analyst`, …) keep a single
cross-repo **methodology** notebook; repo-analysis agents (`dependency-graph-analyzer`,
`architecture-drift-detector`, `api-surface-auditor`, `state-machine-verifier`,
`module-interface-auditor`, `architecture-smell-scanner`, `test-fixer`) scope
theirs per repo. The top-level session itself learns under
`orchestrator@<owner>-<repo>`.

## Tuning (env)

All optional; defaults match the RFC.

| Env | Default | Meaning |
|---|---|---|
| `NB_DIR` | `~/.kookr/notebooks` | notebooks directory |
| `NB_GIT_AUTOCOMMIT` | `1` (when `NB_DIR` is a git repo) | `0` disables the per-change commit in `bin/nb.js` |
| `NB_RETRO_DISABLED` | unset | set (non-`0`) to silence the Stop-hook retrospective nudge |
| `NB_MAX_LINES` | `200` | max entries per notebook (ceiling 5000) |
| `NB_MAX_CHARS` | `200` | hard cap per lesson (over-long adds are rejected, not truncated). Agents are *instructed* to keep new lessons ≤120 chars — a style floor well under this ceiling. |
| `NB_USAGE_RING` | `5000` | max lines in the usage log ring |
| `NB_LOOP_N` / `NB_LOOP_WINDOW_S` | `10` / `120` | loop anomaly: N calls within S seconds |
| `NB_SILENT_H` | `48` | went-silent anomaly: hours since last use |
| `NB_ERR_MIN` / `NB_ERR_RATE` | `5` / `0.3` | high-error-rate anomaly: min calls, rate |

Raise `NB_MAX_LINES`/`NB_MAX_CHARS` only if real notebooks show useful lessons
rejected (too long) or aged out too fast.
