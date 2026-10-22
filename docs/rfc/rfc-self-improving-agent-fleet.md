# RFC: Specialized Sub-Agents with a Bounded, Voted Notebook

**Status:** Draft (v4 — agent-curated voting + hook-guaranteed rituals + KISS monitoring & docs; simplified design, supersedes v2)
**Date:** 2026-10-22
**Author:** Jean Ibarz (with Claude)

> v1–v2 (git history) proposed a measured-liability memory with a `kb demote` actuator, a janitor, an observability layer and a measurement phase — the author's verdict: **too complex.** v3 replaced it with a structurally-bounded one-line notebook; v4 adds the two things the author asked for: **the agent curates its own notebook (vote / consolidate / delete)**, and **hooks guarantee injection at task start and retrospective at task end**, with a fast local CLI. Research behind it: [`rfc-self-improving-agent-fleet-evidence.md`](./rfc-self-improving-agent-fleet-evidence.md). HTML rendering: `rfc-self-improving-agent-fleet.html`.

---

## Problem

Two gaps, one simple fix.

1. **Agents don't specialize.** A main agent does nearly everything itself; there's no focused role that gets sharp at a single kind of job.
2. **Agents don't learn.** They finish and keep nothing. Kookr's existing lesson store is the opposite extreme — *forced* to grow (1,319 `agent-task-lessons` notes and counting) with no bound, so it rots: noise, stale/contradictory entries, context that drowns the signal.

The trap: "add memory" usually means "add an unbounded store + a retrieval system + a pruning system." That spiral is what sank v2. **We make the bound structural**, let **the agent curate within it**, and **let hooks guarantee the ritual** — so none of that machinery is needed.

> **Design principle (explicit): be *malin* and KISS.** Solve the real need with the smallest honest mechanism; never add complexity to look clever. Every piece below earns its place against a concrete need — specialization, learning, bounded memory, guaranteed rituals, and self-monitoring — and nothing more.

## The idea

**A. A roster of specialized sub-agent roles** the main agent delegates to — each does one kind of job and gets better at it.

**B. A new memory type: the Notebook.** One per role, a plain-text file, deliberately tiny:

- **at most `MAX_LINES` entries** (default **200**, ceiling 300);
- **one entry = one line**, lesson text **≤ `MAX_CHARS` characters** (default **120**);
- each line carries a small **vote score** — on disk simply `<score>\t<lesson>`, e.g. `+3␉prefer execFileSync, array args (shell-safety)`.

**C. The agent curates it.** The cap isn't only blind eviction — the agent participates:

- **Vote (end of each task):** `+1` on entries that helped, `−1` on entries that misled or cost it time. A score is a running sum; it is the usefulness signal.
- **When the notebook is full, the agent chooses:** *consolidate* two related lines into one sharper line, or *delete* an entry it judges useless — before anything is evicted automatically.
- **Automatic fallback:** if the agent doesn't act and a write would exceed the cap, evict the **lowest-scored** line (ties → oldest). A line that keeps earning `−1` leaves on its own; a `+` line survives.

That is the whole bounding and curation story. No decay curves, no embeddings, no scoring engine — a signed integer the agent nudges, plus a hard cap.

### Why this stays simple AND safe

| Property | What it buys |
|---|---|
| **Whole notebook fits in context** | 200 × ~120 ≈ 24 KB (~6k tokens worst case). The role **reads the entire notebook** at task start — **no retrieval, no ranking, no injection scoring**. |
| **One line, few characters** | You can't paste a paragraph; the limit **forces distillation**. That's the quality filter, as a constraint not a gate. |
| **Vote + agent-chosen consolidate/delete** | Reinforcement and pruning are a human-legible integer and a judgment call the agent already makes — not an engine to build, tune, or watch. |
| **Lowest-score-out at the cap** | Auto-purge by construction, now *outcome-weighted*: harmful lines leave first, useful ones persist. Size and cost stay constant. |
| **Plain text, one file per role** | Human-readable, `git`-diffable, hand-editable. Open it to see exactly what a role "knows"; fix a bad line with a text editor. |

## Reliability by hooks (the part that makes it trustworthy)

A rule in a prompt is a suggestion; a **hook** is a guarantee the harness enforces. This is a Kookr strength (`plugin/hooks/hooks.json`, the hook-driven-workflow-enforcement pattern) and we lean on it so the ritual can't be skipped.

| Hook | Fires | Guarantees | Reuses |
|---|---|---|---|
| **Start-of-task injection** | `SessionStart` (role known) | the role's notebook is read and placed in context **before** it works — `nb show <role>` | the exact pattern of the read-time injector `src/core/kb-context-injection.ts` |
| **End-of-task retrospective** | `Stop` | the task **cannot close** until the agent has voted on the entries it used and recorded any add/consolidate/delete — *block-then-instruct* | the existing forced-lesson gate (#1538 returns 409 until a decision is recorded) — same mechanism, pointed at the notebook |

The retrospective gate is the symmetric partner the old lesson gate never had: #1538 forces a write *in*; this hook forces a *vote and a curation pass* in the same breath, so the notebook is kept honest on every task instead of only growing.

### A fast, reliable local CLI — `nb` (kb-cli-shaped)

The agent interacts with its notebook through one small command, the way it uses `kb` — but because a notebook is **local plain text** (no FAISS, no embeddings, no Ollama, no network), it is **faster and more reliable than `kb`** and has no spool-degradation failure mode (`kb-spool-shim` exists precisely because `kb` can be slow/degraded — `nb` sidesteps that entirely).

```
nb show   <role>                      # print the notebook  (used by the start hook)
nb add    <role> "<lesson>"           # dedup-skip, score +1, write, trim (lowest-score out)
nb vote   <role> <id|query> +1|-1     # adjust an entry's score  (used by the end hook)
nb merge  <role> <idA> <idB> "<merged>"  # consolidate two entries into one
nb rm     <role> <id|query>           # delete an entry the agent judges useless
nb stats  [<role>] [--since 7d]       # usage analytics + anomaly flags (see Monitoring)
nb --help                             # how to use the tool (the documented entry point)
```

All operations are O(≤300 lines) over one file with a lock → millisecond, deterministic, offline. Dedup on `add` is a **normalized string compare** (no embeddings). That is the reliability + speed the design depends on.

### Monitored and documented — the KISS way

The tool watches itself with the same dumb-but-sufficient trick as the notebook. **Every `nb` call appends one line** to a capped usage log (`~/.kookr/notebooks/.nb-usage.log`, an oldest-dropped ring so monitoring itself can't grow unbounded — reusing the `KOOKR_RELAY_METADATA_AUDIT_CAP` pattern): `ts  role  command  ok|err  ms`. Then **`nb stats`** reads that log and reports:

- per-command **call counts, error rate, p50/p95 latency, last-used**;
- **the anomalies the author named**:
  - a command **called repeatedly in a tight window** by one role → the agent is looping or stuck;
  - a command whose **usage dropped to zero** after being used → it likely broke or stopped behaving as expected;
  - a command with a **high error rate** → broken, or not doing what the agent expects.

This is monitoring without a monitoring system: no metrics server, no dashboard to stand up — one log line per call and one reader. Access and analytics are documented in **one short page, `docs/reference/agent-notebook.md`**: how to call the tool (`nb --help`), how to read its analytics (`nb stats`), and how to read each anomaly flag. That page is the single source for operating and improving the tool.

### The learning loop

```
start hook injects notebook  →  role does the task  →  Stop hook blocks until:
      · vote +1/-1 on entries used        (nb vote)
      · add at most one new line          (nb add  → dedup, trim)
      · if full: consolidate or delete    (nb merge / nb rm)
```

## The roles

A small starter set (capability-shaped, not human job titles); it grows as needs appear. Each owns its notebook.

| Role | Does one thing | A line it might learn |
|---|---|---|
| **Cartographer** | maps a repo: where things live, build/test commands | `+4  tests: pnpm vitest run <file>` |
| **Reproducer** | builds a minimal failing repro / test harness | `+2  flaky WS: await toBeVisible before counting` |
| **Patcher** | writes the fix against repro + acceptance | `+3  this repo: execFileSync, array args` |
| **Verifier** | checks the change against acceptance | `+5  run pnpm lint before done — gates merge` |

The main agent stays the orchestrator: pick the role, hand a short brief, get a result back, compose. Delegation already exists in Kookr (the `Agent` tool / child-task spawn) — reused as-is.

## What we build (small)

1. **The `nb` CLI + notebook file format** — the commands above over `<role>.md` files (`~/.kookr/notebooks/<role>.md`, or `.kookr/notebooks/<role>.md` for repo-local roles), plus the one-line-per-call usage log and `nb stats`. ~1 small module, plain text + file lock.
2. **Two hooks in `plugin/hooks/hooks.json`** — the SessionStart injector and the Stop retrospective-gate (block-then-instruct).
3. **A few `plugin/agents/<role>.md`** role definitions, each told to vote/curate in its retrospective.
4. **One short reference page** `docs/reference/agent-notebook.md` — how to access the tool and its analytics, and how to read the anomaly flags.
5. **One line in the orchestrator's instructions:** prefer delegating a unit to the role that owns it.

## What we deliberately do NOT build

- ❌ No embeddings / FAISS / semantic retrieval — the notebook is read whole.
- ❌ No decay scoring, recency×importance, bi-temporal invalidation — just the agent's vote.
- ❌ No `kb demote` actuator, no janitor playbook, no scheduled purge — eviction is inline, curation is the agent's.
- ❌ No metrics server, dashboard, or measurement phase — monitoring is one log line per `nb` call plus `nb stats`, nothing to stand up.

If a real need shows up later (notebooks grow big enough that reading them whole hurts), we revisit — but we start with the dumbest thing that is correct.

## Edge cases

- **A line is wrong/harmful:** it collects `−1` votes and is evicted first; or the agent `nb rm`s it; or an operator deletes the line by hand.
- **A lesson needs more than one line:** that's a signal it belongs in a `SKILL.md` (a procedure), not the notebook (a reminder). Keep the two separate.
- **Agent skips the retrospective:** it can't — the Stop hook blocks completion until the vote/curation decision is recorded (like #1538).
- **`nb` unavailable / file locked:** operations are local and atomic under a lock; on contention, retry briefly then fail loud (no silent spool — unlike `kb`).
- **Vote gaming / thrash:** scores are bounded in effect by the hard line cap; a runaway `−1` just removes a line, a runaway `+1` just keeps a short line. Worst case is one stale 120-char line, not unbounded growth.

## Open questions

1. **Vote → eviction curve:** pure lowest-score-then-oldest (simplest) is the default. Do we need a floor (never auto-evict a line scored ≥ k)? Start without; add only if useful lines are lost.
2. **Scope:** one notebook per role (default) vs. per role × per repo for repo-specific roles (e.g. Cartographer). Start per-role; add a `<role>@<repo>` suffix where clearly needed.
3. **The numbers:** 200 lines / 120 chars to start. Tune only if real notebooks show useful lessons truncated or aged out too fast.
4. **Shared vs private:** notebooks are per-role and fleet-owned (not the human `kb` commons), so `nb rm`/`merge` never touch anything a human relies on. Confirm that boundary is enforced by `nb` refusing any path outside the notebooks dir.
