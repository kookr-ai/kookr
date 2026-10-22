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
`kb`, with no spool-degradation mode.

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
- `<id>` is the line number printed by `nb show`; `<query>` selects an entry by
  case-insensitive substring (errors if it matches 0 or >1 entries).
- A lesson is flattened to a single line. One longer than 200 chars is
  **rejected** (`nb add` exits 1), never truncated — rewrite it shorter and
  retry, so you never store a cut-off, useless entry. A lesson that needs a
  paragraph is a *procedure* — put it in a `SKILL.md`, not the notebook.

### Where notebooks live

`$NB_DIR` or `~/.kookr/notebooks/<role>.md`. Plain text, one `+<score>\t<lesson>`
per line — human-readable, `git`-diffable, hand-editable. To fix a bad lesson,
downvote it, `nb rm` it, or just edit the file.

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
one whose environment sets `NB_ROLE=<role>` (e.g. a task launched for that role):

- **SessionStart → `nb-inject.sh`**: injects `nb show $NB_ROLE` into context, so
  the agent begins already knowing its lessons. No-op when `NB_ROLE` is unset.
- **Stop → `nb-retro.sh`**: blocks the first stop of the session once and
  instructs the retrospective (vote the lessons you used, add at most one, merge/
  rm if full), then allows the stop. Fires at most once per session. No-op when
  `NB_ROLE` is unset.

For an in-process sub-agent invoked via the `Agent` tool (where per-agent
`NB_ROLE` is not set), the role's agent definition instead instructs the same
`nb show` / vote / `nb add` steps explicitly — the hooks and the agent bodies
exercise the same `nb` CLI, so the behaviour holds on both paths.

## The role agents

Capability-shaped specialists, each owning its own notebook:

| Agent (`NB_ROLE`) | Does one thing |
|---|---|
| `repo-cartographer` | maps a repo: where things live, build/test/lint commands |
| `repro-builder` | builds a minimal, deterministic failing reproduction |
| `patch-author` | writes a focused fix against a repro + acceptance |
| `change-verifier` | independently verifies a change meets acceptance |

The main agent stays the orchestrator: it delegates a unit of work to the role
that owns it, and composes the result. New roles are added as needs appear — a
capability earns its own role only when it needs its own memory scope or its own
tool boundary; otherwise it is a prompt.

## Tuning (env)

All optional; defaults match the RFC.

| Env | Default | Meaning |
|---|---|---|
| `NB_DIR` | `~/.kookr/notebooks` | notebooks directory |
| `NB_MAX_LINES` | `200` | max entries per notebook (ceiling 5000) |
| `NB_MAX_CHARS` | `200` | max characters per lesson (over-long adds are rejected, not truncated) |
| `NB_USAGE_RING` | `5000` | max lines in the usage log ring |
| `NB_LOOP_N` / `NB_LOOP_WINDOW_S` | `10` / `120` | loop anomaly: N calls within S seconds |
| `NB_SILENT_H` | `48` | went-silent anomaly: hours since last use |
| `NB_ERR_MIN` / `NB_ERR_RATE` | `5` / `0.3` | high-error-rate anomaly: min calls, rate |

Raise `NB_MAX_LINES`/`NB_MAX_CHARS` only if real notebooks show useful lessons
rejected (too long) or aged out too fast.
