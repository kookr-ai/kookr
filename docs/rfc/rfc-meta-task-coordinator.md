# RFC: Meta Task Coordinator — Cross-Project Attention Routing

**Status:** Draft v2 (post-variant exploration + critic panel)
**Date:** 2026-05-21
**Author:** Jean Ibarz (with Claude Opus 4.7)
**Implementation branch:** `rfc/meta-task-coordinator`
**Companion:** `meta-coordinator-variants.md` (variant comparison, critic synthesis, derivation of this design)

---

## Problem

Kookr's per-task surface scales gracefully to ~5 tasks in one repo. It does not scale gracefully to ~10 tasks across ~3 repos with latent dependencies between them. The user cannot answer "which of these needs me right now, and why?" without reading every transcript.

### Empirical grounding (live fleet, 2026-05-21)

Snapshot from `http://127.0.0.1:4800/api/tasks`:

```
9 in-flight tasks across 3 repos:

knowledge-base-mcp-server (4):
  4a203b2a  Implement kb research M1 evidence-packet CLI
  712e0a5f  Tighten KB Research M1 Planner Quality
  46cd2129  Dogfood KB research workflow report
  9e6bbcad  Assess KB research capabilities for agent docs

local-research-agent (4):
  b52496f7  Implement RFC 010 wisdom-backed scout issue 268
  75c0d0c8  (unnamed) — same effective prompt as b52496f7
  982143c7  Investigate recent workflow execution failures
  272cc313  post-deployment runtime health monitoring checks

kookr (1):
  efad1f31  RFC for centralized task coordination in Kookr
```

Three failure modes visible in this single snapshot:

1. **Latent critical-path bottleneck.** `712e0a5f`, `46cd2129`, `9e6bbcad` likely cannot meaningfully finish until `4a203b2a` (M1 CLI) ships. The dashboard treats all four KB tasks as equal-priority siblings.
2. **Likely cross-repo dependency.** `b52496f7` in `local-research-agent` plausibly consumes the same M1 capability being built in `knowledge-base-mcp-server`. No edge between them exists in Kookr's data model.
3. **Silent duplication.** `b52496f7` and `75c0d0c8` carry the same effective prompt. Spawn-time idempotent dedup missed them (likely a whitespace or wrapper-prompt difference).

The user's stated request — "I'm not sure which task requires my attention" — is the predictable consequence of running N tasks across M repos with no surface that aggregates state across repo boundaries.

### What Kookr already has

- **Per-task state store:** `~/.kookr/tasks.json` with `{id, name, prompt, cwd, agentType, status, sessions[], completionDigest, ...}`. Globally addressed (task IDs cross repos already).
- **Per-task event stream:** SessionStart / PreToolUse / PostToolUse / PermissionRequest / Stop hooks write `~/.kookr/audit.jsonl` and `~/.kookr/activity/`.
- **Per-task supervision policy:** `rfc-supervision-next-actions` introduced a `nextAction` read model and a "Follow-up" UI band. This is the foundation we build on.
- **Idempotent dedup:** `kookr-spawn` hashes the effective prompt. Used at spawn time only.
- **Parent/child task lineage:** the `Task` model already carries `parentTaskId` / `childTaskIds` (cited in `rfc-supervision-next-actions` empirical checkpoint).

### What's missing

- Any cross-task dependency model.
- Any per-task recommendation that *names a verb* (the existing `nextAction` chip is a classification, not an action).
- Any fleet-level aggregation that catches duplicates, orphan blockees, or batch-ready cohorts.
- Pre-spawn dedupe re-use of the prompt normalizer.

## Goals

- Surface cross-task relationships that already exist latently, without requiring exhaustive user declaration.
- Produce **per-task action recommendations** ("snooze 24h because X", "mark done because PR merged") attached to the row, not a single fleet-level focus banner.
- Detect and surface fleet-level pathologies the user cannot see per-task: duplicates, orphan blockers, batch-ready cohorts.
- Stay declarative for high-confidence cases; defer all inference indefinitely until manual declaration proves insufficient over 2+ weeks of real use.
- Make every destructive action verify against ground truth at click-time, not at render-time.
- Bound user attention cost: a false-positive recommendation must cost the user one click (`[✕ wrong]`) to suppress for 7 days.

## Non-Goals

- **No focus banner.** Per-task chips sort the dashboard; the top chip is the focus.
- **No LLM in PR 1.** Manual `blocks` / `blocked_by` field on tasks, with typeahead. Inference deferred indefinitely.
- **No `Terminate` verb in PR 1.** Without per-agent-type stale thresholds, a global default guarantees false positives on legit long-quiet work (playwright suites, big LLM passes). The user terminates from the existing task surface, not from a coordinator recommendation.
- **No score number shown to the user.** Internal sort key only.
- **No attention-inbox pane as the home view.** Findings pane is small, collapsed by default, badge in nav when items exist.
- **No "absence of signal" claims.** The coordinator never says "N tasks running normally — no attention needed." Silence is silence.
- **No new task lifecycle states** beyond what `rfc-supervision-next-actions` establishes.
- **No cross-machine federation.** Single-host (matches the rest of Kookr's assumptions).
- **No replacement of GitHub / Linear / project boards.**

## Requirements

### Detection (deterministic, no LLM)

- The system SHALL detect stale tasks: status `inProgress` with no PostToolUse event in N minutes (default 30, single global threshold in PR 1).
- The system SHALL detect duplicate-or-near-duplicate active tasks using the existing prompt normalizer from `kookr-spawn`.
- The system SHALL detect done-but-not-cleared tasks: status `completed` with a `completionDigest`, no follow-up flag, no anomaly.
- The system SHALL detect orphan blockers: a declared `blocked_by` edge pointing to a task that no longer exists or has completed.
- The system SHALL detect batch-ready chain cohorts: a parent task's children all in `completed` state with merged PRs.

### Declared edges (no inference)

- A task SHALL accept a `blocks: [task_id | "milestone:<free-text>"]` field, settable from the dashboard with typeahead over active tasks.
- A task SHALL accept a `blocked_by: [task_id | "milestone:<free-text>"]` field, symmetric to `blocks`.
- Declared edges SHALL persist in `tasks.json` and survive daemon restart.
- The system SHALL NOT infer edges in PR 1. (Deferred indefinitely.)

### Surfaces (three loci)

- **Task locus** — each task row that has an active detector OR a meaningful declared-edge state SHALL render exactly one chip with: one verb (first token), one glyph + count of evidence, and a `[✕ wrong]` affordance.
- **Relation locus** — when a task has `parentTaskId`/`childTaskIds` or a declared edge, the detail view SHALL render a chain/dependency strip with sibling status, PR links, and a re-verification-gated batch action.
- **Fleet locus** — a collapsible "Coordinator findings" pane SHALL list ownerless items (duplicate clusters, orphan blockers). The pane SHALL show a count badge in the nav when populated. The pane SHALL NOT carry destructive verbs (no auto-suggested `Terminate`).
- A pre-spawn dedupe interrupt SHALL run on the `kookr-spawn` path. If the normalized prompt matches an active task, spawn SHALL prompt for confirmation before proceeding.

### Safety properties

- Every destructive verb SHALL re-verify against ground truth at click-time, not at render-time. For `Mark done`: re-check PR status, worktree cleanliness, and post-merge CI before completing the action.
- Batch actions (e.g., "Mark prior 4 done") SHALL carry an optimistic-concurrency token. If any sibling regressed between render and click, the batch SHALL fail visibly and the strip SHALL re-render.
- `[✕ wrong]` SHALL suppress *this class* of recommendation for this task type for 7 days. Suppressions persist in `~/.kookr/coordinator-suppressions.json`.
- `Snooze` SHALL be reason-coded with exponential backoff. A snoozed recommendation SHALL NOT re-fire identically next tick; subsequent dismissals widen the backoff window.
- The coordinator SHALL NOT emit text claiming that any task is healthy or running normally — only that it currently exhibits no negative signal.

### Performance

- Detector evaluation SHALL complete in under 200ms for fleets up to 50 active tasks, so it can refresh on every snapshot tick without UI lag.
- Detectors SHALL read only `tasks.json`, the `audit.jsonl` tail, and the coordinator's own state files. No transcript reads in the hot path.
- All coordinator state SHALL be transmitted through the existing snapshot/update WebSocket channel (new message type: `coordinator.snapshot`). No new connection types.

## Design

The system has three loci, each with one UI surface and a shared data layer.

### 1. Locus map

| Locus    | Surface              | Verb examples            | Build cost | Examples (live fleet) |
|----------|----------------------|--------------------------|------------|-----------------------|
| Task     | Chip on row          | Mark done, Snooze, Nudge | medium     | S3, S4, S5 |
| Relation | Strip in detail view | Mark prior N done, Accept edge | medium | S1, S2 |
| Fleet    | Findings pane + spawn interrupt | Compare, Clear edge | low | S3 cluster, S2 orphan-once-M1-ships |

(S1–S5 are defined in `meta-coordinator-variants.md`.)

### 2. The task-locus chip (primary surface)

Each task row that has an active detector OR a meaningful declared-edge state renders exactly one chip:

```
[●] 4a203b2a Implement kb research M1 evidence-packet CLI    inProgress
    ▶ Nudge agent  ⛓ blocks 3   [✕]

[●] 712e0a5f Tighten KB Research M1 Planner Quality          inProgress
    ⏸ Snooze 24h   ⛓ blocked by 4a203b2a   [accept] [✕]

[●] 75c0d0c8 (unnamed)                                       inProgress
    ⚠ Compare with b52496f7  · identical prompt   [Compare] [✕]

[✓] bad5faa1 Implement GitHub issue #528                     completed
    ✅ Mark done   · PR #535 merged 3h ago, no follow-up    [✕]
```

Rules:

- **Verb-first.** First token is always the action verb. Never the noun.
- **One chip per task.** When multiple detectors fire on the same task, pick the highest-precedence chip (precedence: declared-edge resolution > stale > duplicate > done-not-cleared).
- **No score numbers.** Chip presence is the sort signal; tasks with chips float to the top of their repo group.
- **`[✕ wrong]` is mandatory.** One-click suppression of this recommendation *class* for this task *type* for 7 days. Persisted in `~/.kookr/coordinator-suppressions.json` keyed by `(detector_id, agent_type)`.
- **Evidence is glyph + count, never prose.** Sub-prose moves to a tooltip if necessary. (Failed test from the UX critic: "blocks 3" beats "blocks 3 KB tasks + 1 inferred in local-research-agent" for scan-ability.)

### 3. The relation-locus strip (chain/dependency detail)

Rendered above task detail only when `parentTaskId`/`childTaskIds` or a declared edge exists. Invisible otherwise.

```
┌─ CHAIN · RFC 010 wisdom-backed scout queue ────────────────────────┐
│  [✓] #266 → PR #531  · [✓] #267 → PR #532  · [✓] #268 → PR #533    │
│  [✓] #269 → PR #534  · [●] #270 (you are here)                      │
│  [Mark prior 4 done] ← re-verifies each PR at click-time            │
└─────────────────────────────────────────────────────────────────────┘
```

Batch action contract:

- `[Mark prior 4 done]` captures a list of `(task_id, last_seen_pr_state)` tuples at render time.
- On click, the action re-fetches GitHub state for each PR. If any state changed (revert, post-merge CI failure, new follow-up), the batch is rejected and the strip re-renders with the new state highlighted.
- The user sees the rejection ("PR #534 was reverted 4 min ago — re-rendered") and chooses again. No silent fallthrough.

### 4. The fleet-locus findings pane

Collapsible, badge in nav when populated. Lists items that have no single owning row.

```
COORDINATOR FINDINGS (2)
  ⚠ Duplicate cluster · b52496f7 & 75c0d0c8         [Compare]
  ⚠ Orphan blocker · 712e0a5f waits on 4a203b2a — upstream completed  [Clear edge]
```

- Verbs are non-destructive: `Compare`, `Clear edge`, `Open both`, `Acknowledge`.
- Never auto-suggests `Terminate`. The user makes destructive decisions from `Compare`, which opens both tasks side-by-side.
- Items have a `[✕]` to suppress this finding class for 7 days (matches the chip suppression mechanism).

### 5. Pre-spawn dedupe interrupt

On `kookr-spawn`, hash the normalized prompt and check against active tasks. If a match exists:

```
$ kookr-spawn --prompt "..."
WARN: prompt matches active task 75c0d0c8 (running 12 min, repo: local-research-agent)
Continue spawning a duplicate? [y/N/show diff]
```

This is the load-bearing addition. It prevents the duplicate at the door instead of catching it after both children are 15 minutes deep. The prompt normalizer already exists; reusing it on the spawn path is one function call.

Three behaviors based on response:
- `N` (default): abort spawn, exit code 5, no task created.
- `y`: spawn anyway, note `intent: keep_as_duplicate` in the new task's metadata (suppresses future duplicate-cluster findings between these two).
- `show diff`: print prompt diff, then re-prompt.

### 6. Data layer

Additive to `tasks.json` schema:

```jsonc
{
  "id": "...",
  "...": "existing fields",
  "blocks":     ["task:4a203b2a", "milestone:KB M1 ships"],   // user-declared, optional
  "blocked_by": ["task:4a203b2a", "milestone:..."],            // user-declared, optional
  "metadata": {
    "intent": "keep_as_duplicate"                              // optional, set by spawn override
  }
}
```

New file: `~/.kookr/coordinator-suppressions.json`:

```jsonc
{
  "version": 1,
  "suppressions": [
    {
      "key": "(stale, codex-cli)",
      "task_id": "ec77ab12",
      "expires_at": "2026-05-28T14:32:00Z"
    }
  ]
}
```

That's the whole schema delta. No new tables. No new daemons. No new IPC.

### 7. Placement in the runtime

Coordinator runs as a module inside the existing Kookr server process. It:

- Subscribes to the same in-memory snapshot store the WebSocket layer already uses.
- Reads `tasks.json` deltas and `audit.jsonl` tail.
- Recomputes detector outputs on every snapshot tick (debounced ≤ once / 500ms).
- Emits state on the existing WS channel as `coordinator.snapshot`.

Not a child agent. Not a Claude Code session. Plain TypeScript. Strong consistency for free.

## Worked example: the live fleet today

| Task | Detector fires | Chip on row | Strip in detail | Fleet finding |
|------|---|---|---|---|
| `4a203b2a` M1 CLI | declared-edge (if user adds `blocks: [712e0a5f, 46cd2129]`) | `▶ Nudge · ⛓ blocks 3` | dependents listed when opened | — |
| `712e0a5f` Tighten M1 | declared-edge (user adds `blocked_by: 4a203b2a`) | `⏸ Snooze 24h · ⛓ blocked by 4a203b2a` | upstream shown | — |
| `46cd2129` Dogfood | same | `⏸ Snooze 24h · ⛓ blocked by 4a203b2a` | upstream shown | — |
| `9e6bbcad` Assess capabilities | none | — | — | — |
| `b52496f7` + `75c0d0c8` | duplicate detector | `⚠ Compare with X · identical prompt` on each | — | duplicate cluster card |
| `bad5faa1` GH #528 | done-not-cleared | `✅ Mark done · PR #535 merged 3h ago` | — | — |
| `efad1f31` this RFC | none | — | — | — |

When the user adds the three `blocks` / `blocked_by` edges (typeahead, three clicks), the M1 task automatically sorts to the top of the KB group with `⛓ blocks 3` as evidence. The variants doc walks through the same example.

## Failure modes and mitigations

| Failure mode | Mitigation |
|---|---|
| "Mark done" hides uncommitted local work or post-merge CI failure | Click-time re-verification: PR status, worktree dirtiness, post-merge CI. Action fails visibly if any check fails. |
| Silent task crash with no Stop hook → frozen `inProgress`, no PostToolUse | Stale detector catches by PostToolUse-recency. Chip is `⏳ Stuck? · 45m silent` with `[Open transcript]` and `[Send "continue"]` — no `Terminate` in PR 1. |
| Duplicate detector false positive on intentional A/B run | No auto-suggested `Terminate`. Findings card has `[Compare]` only. After Compare, the user can mark `intent: keep_as_duplicate` to suppress future findings between this pair. |
| Stale threshold misclassifies long-quiet work (playwright, big LLM) | PR 1 verbs are non-destructive (`Open transcript`, `Send "continue"`). Per-agent-type thresholds in PR 2 once empirical data exists. |
| Snooze re-fires identical recommendation each tick (determinism trap) | Reason-coded suppression with exponential backoff; first snooze 30m, then 2h, then 24h, persisted. |
| Batch "Mark prior N done" applied to stale view (sibling regressed mid-render) | Optimistic-concurrency token: action re-verifies each sibling's PR state at click-time and rejects with re-rendered strip if anything changed. |
| Orphan blocker: task declares `blocked_by` pointing to a completed/missing task | Orphan detector surfaces as fleet finding with `[Clear edge]`. Never silently auto-clears. |
| Chain strip operates on cyclic / pruned children | Cap traversal depth to 3. Children missing from `tasks.json` shown as `[?]` with "task no longer present" tooltip. No batch action across orphan children. |
| User accepts a chip recommendation by reflex (banner fatigue) | `[✕ wrong]` is always available. After 3 dismissals of the same `(detector, task_type)` pair, the system widens suppression to 30 days and writes a `~/.kookr/coordinator-feedback.jsonl` entry for later review. |
| Coordinator asserts "task is healthy" | The coordinator never says this. Silence is silence. Fleet finding pane shows a count of findings, not a count of non-findings. |
| Server crash takes coordinator down | Same blast radius as today. State is recomputed from `tasks.json` + `audit.jsonl` on restart. Only novel durable state is `coordinator-suppressions.json` (recreatable from feedback log if lost). |

## Open questions

- **Default behavior when no edges are declared.** The system is most useful with a few declared edges, but most users won't declare any on day one. Should PR 1 ship a one-time onboarding nudge ("declare an edge between two tasks to see how this works") or rely on the cheap detectors (stale/duplicate/done-not-cleared) to carry value until the user discovers edge declaration?
- **Typeahead UX for declaring edges.** Probably a small modal: "Block this task on…" → typeahead over active tasks → confirm. Worth a low-fi mockup before PR 1.
- **Interaction with `rfc-running-task-snooze`.** That RFC has its own snooze semantics. Coordinator-induced snooze should likely write through the same mechanism rather than build a parallel one. Reconcile terminology before PR 1.
- **Pre-spawn dedupe and playbook-driven spawns.** Playbooks spawn many tasks programmatically. The interrupt's interactive `[y/N]` prompt doesn't fit a programmatic flow. Need a `--allow-duplicate` or `--dedupe=warn|block|skip` flag on `kookr-spawn` so playbooks can opt out cleanly.
- **Where does `[Compare]` open?** A new dashboard route showing both tasks side-by-side, or a modal? Probably a route — comparing transcripts is too large for a modal.

## Phasing

### PR 1 — Three detectors + manual edges + three surfaces

1. Stale detector, duplicate detector, done-not-cleared detector (deterministic, no LLM).
2. `blocks` / `blocked_by` fields on tasks; typeahead UI in task detail.
3. Task-locus chip rendering with `[✕ wrong]` and 7-day suppression in `~/.kookr/coordinator-suppressions.json`.
4. Relation-locus chain/dependency strip with click-time-verified batch action.
5. Fleet-locus findings pane (small, collapsible, non-destructive verbs only).
6. Pre-spawn dedupe interrupt with `--dedupe` flag on `kookr-spawn`.
7. Click-time re-verification for `Mark done` (PR status, worktree dirtiness, post-merge CI).
8. `coordinator.snapshot` WS message on the existing channel.
9. Sort: chip-bearing tasks float to top of repo group.

PR 1 explicitly does NOT include:
- Any LLM call.
- `Terminate` verb in any recommendation.
- Per-agent-type stale thresholds (single global default).
- Score numbers shown to user.
- Top-level focus banner.

### PR 2 — Empirical refinements (after 2+ weeks of PR 1 dogfooding)

1. Per-agent-type stale thresholds, learned from `audit.jsonl` activity distribution.
2. Add `Terminate` verb to the stale chip *if and only if* per-agent thresholds reduce false-positive rate below 5% on the user's real fleet.
3. GitHub-artifact-typed blockers (`gh:owner/repo#NN`) with auto-clearing from existing GH polling.
4. Coordinator-suggestion review tool: list recent `[✕ wrong]` dismissals to spot detectors that should be tuned.

### PR 3 (speculative — only if needed) — Inference

Revisit LLM-based edge inference only if 2+ weeks of dogfooding shows that:
- Users declare fewer than ~3 edges per active fleet on average.
- The duplicate detector misses ≥1 semantically-duplicate task per week (different prompts, same work).
- Fleet-finding diagnostic value is materially degraded by missing edges.

If those conditions hold, inference returns — but with provenance preserved end-to-end. An accepted-inferred edge is *not* indistinguishable from a declared edge; the schema carries `kind: "declared" | "accepted_inferred"` and original confidence, so wrong accepts are auditable and revertible. Until then, no inference.

## Empirical checkpoint (verify before writing PR 1)

1. The existing WS snapshot tick can absorb one extra structured object (`coordinator.snapshot`) per tick without measurable UI lag.
2. The prompt normalizer used by `kookr-spawn` is reachable from the coordinator module without circular imports.
3. The `audit.jsonl` tail is cheap to read per tick at typical sizes; rotation strategy is compatible with tail-reads.
4. `Task.parentTaskId` and `Task.childTaskIds` are populated reliably for self-continuing chains (cited as existing in `rfc-supervision-next-actions`; re-verify before relying on it).
5. GitHub PR state polling already covers the PRs referenced in `completionDigest` — and if not, what's the cost of adding click-time polling for `Mark done`'s re-verification round-trip.
6. The "Follow-up" surface from `rfc-supervision-next-actions` is the right place to graft the chip, vs. a new chip slot.

If (4) or (5) fail, scope adjusts. Others are standard restructuring.

## Why this design, and what changed from v1

V1 of this RFC proposed a three-tier trust model (Declared / Detected / Inferred edges), an LLM inference pass with quarantine and accept/reject UI, a top-level focus banner, and a coordinator panel — alongside the per-task surface. A four-critic panel (simulated user, senior UX designer, design minimalist, failure-mode analyst — see `meta-coordinator-variants.md` for full reports) converged on:

- **The locus is the right design dimension**, not the surface shape. You need *one of each* locus (task / relation / fleet), not one *instead of* the others.
- **Per-task chips are the primary surface.** The focus banner picks one winner when the real fleet has several small actions; the chip lives where the user looks and carries a verb.
- **The LLM inference pass is the inference pass justifying itself.** It exists to serve one scenario (cross-repo bottleneck) that manual edge declaration solves with a single typeahead. Cut indefinitely.
- **Destructive verbs need click-time re-verification.** The score is computed on cached state; the action must touch ground truth. This is a veto-level safety property.
- **`[✕ wrong]` is mandatory.** Every recommendation must survive being wrong without training the user to mute the feature.

The variants doc walks through how we got from v1 to here. This RFC is the converged contract.
