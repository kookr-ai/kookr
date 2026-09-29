# RFC: UX Dogfooding Findings — September 2026

- **Status**: Draft (living document, updated during the dogfooding session)
- **Author**: Claude (Opus 4.8), dogfooding session driven as a "classical user"
- **Date**: 2026-09-30
- **Method**: Drive the live dashboard at `localhost:4800` through normal user
  workflows — inspect the API surface as a scripter would (`/api/projects`,
  `/api/tasks`, `/api/snapshot`), launch/monitor/complete real manual tasks in
  the allowed private projects (kookr, knowledge-base-mcp-server,
  reason-at-home) via the UI, exercise a deliberate bad-input path, and watch
  triage/rail behavior over time — recording every friction point, bug, data
  inconsistency, or wording problem as it is encountered. Prior art:
  `docs/rfc/rfc-ux-dogfooding-findings-2026-06.md` (21 findings).

## Summary

Kookr has matured markedly since the June run: **all of June's raw-count
data-trust findings are fixed** (tied-issue-count-exceeds-open no longer
reproduces; single-task GET works; `id`/`taskId` present and equal), the
launch-failure path now preserves the typed draft *and* surfaces a clear
error toast, and the "Loop Nms" dev-metric is now threshold-gated with a
tooltip. This run therefore found fewer, subtler issues (5 findings, 2 medium /
3 low), and three initially-suspected regressions dissolved on single-context
re-verification (draft loss, queued-task invisibility, always-on loop metric) —
all recorded on the keep-list.

The surviving findings cluster into two themes:

1. **Adjacent surfaces that disagree** (the June "data trust" bucket, now moved
   up a level from raw counts to *status/relationship* displays): a task shown
   as **HEALTHY** while carrying a **WORKTREE MISSING** error badge (F1); a
   **"No dependencies"** summary stacked directly above a **"Dependencies"**
   arrow for the same task (F5); two spend figures ($39,905 all-time vs $122
   live) side by side with only one labeled (F3). Each is a place where two
   components compute related things independently and render contradictory
   answers next to each other.
2. **Display hygiene** — absolute cwd paths leaking into task titles (F4) and
   the same physical repo listed under two project identities (F2).

## Findings

### F1. A "HEALTHY" task simultaneously shows a red "WORKTREE MISSING" error (data trust) — severity: medium

On the overview rail, the left "HEALTHY (10)" section contains a card
("Analyse le rapport généré pour l'enchere de bordeau…", encheres-vo) that
renders a red **WORKTREE MISSING** badge next to an "Awaiting ack" chip. A user
scanning for trouble sees an error-styled badge inside the section that is
supposed to mean "nothing to worry about here".

**Root cause**: the healthy/finding partition keys only on `agent.anomaly`:
`isHealthyRunning` (`src/shared/task-routing.ts:31`) returns true whenever
`agent.anomaly === null` (plus not snoozed/suppressed/terminal/pending) and
never consults `agent.worktreeHealth`. Meanwhile the same row renders a
worktree-health error badge whenever `agent.worktreeHealth !== 'ok'`
(`src/frontend/components/FindingsPanel/HealthyRow.tsx:102-104`). The two
predicates disagree, so a running task with a missing worktree but no anomaly
is both "healthy" and "worktree missing".

**Suggested fix**: make a non-`ok` `worktreeHealth` participate in bucketing —
either demote worktree-missing agents out of `healthy` (into `findings`), or,
if worktree-missing is intentionally non-blocking, downgrade the badge styling
in the Healthy section from error-red to an informational tone so the section's
color contract holds. The cleanest is to fold `worktreeHealth !== 'ok'` into
`isActiveFinding`/`isHealthyRunning` so the badge and the bucket agree.

### F2. Same physical repo listed under two project identities (list hygiene) — severity: low

`GET /api/projects` returns `/home/jean/git/encheres-vo` twice — once as
`project: "github.com/jeanibarz/encheres-vo"` (displayName `jeanibarz/encheres-vo`)
and once as `project: "local/encheres-vo"` (displayName `encheres-vo`). Same for
`/home/jean/git/lucy` (`github.com/jeanibarz/lucy` + `local/lucy`). Both copies
are `tracked: false`, so the sidebar impact is limited, but a scripter (or an
agent) that cross-references projects by `localPath` double-counts these repos,
and the Launch dialog's project picker can offer the same directory twice under
two names.

**Suggested fix**: when a `local/<name>` project resolves to the same
`localPath` as a `github.com/<owner>/<name>` project, collapse them (prefer the
GitHub identity) or at least de-duplicate by `localPath` in the
`/api/projects` response.

### F3. Two spend figures sit side by side, only one is labeled (polish) — severity: low

The top bar shows `$39905.23` with no visible label; the overview summary
directly below reads `Claude 13 · Grok 7 · $122.36 live spend`. A first-time
viewer sees `$39,905` and `$122.36` a few centimeters apart with a 300× gap and
no on-screen explanation of why they differ. The header figure *does* carry a
hover `title` ("All-time agent spend recorded by this Kookr server — includes
cleared and deleted tasks", `src/frontend/components/TopBar.tsx:558`), which
resolves the earlier "no scope" complaint (prior-art F21), but the scope is
invisible without hovering.

**Suggested fix**: add a tiny visible caption under the header figure
("all-time") so the two numbers are self-distinguishing without a hover; the
tooltip already has the long-form copy.

### F4. Task titles embed the absolute cwd path instead of the file the user typed (polish) — severity: low

Launching in `/home/jean/git/reason-at-home` with the prompt "Audit
**README.md** against the actual code…" produces a task whose name renders as
"Audit **/home/jean/git/reason-at-home/README.md** against the actual code in
this r…". The user typed a bare filename; the UI shows a long absolute path.

**Root cause**: `normalizePromptFileReferences` (`src/server/launch-service.ts:1315`)
rewrites relative file references to absolute paths and stores the result in
`userPrompt` — intentional, because dedup matches on absolute-pathed tokens
(`src/shared/launch-duplicate.ts:58`). But the human-facing display path does
not undo this: `displayPromptForTask` (`src/core/prompt-display.ts`) strips the
guardrail preamble yet has no cwd-path collapsing, and the task's fallback name
is a truncation of that normalized text (`launch-service.ts:1719`,
`name: opts.name` with the userPrompt-derived fallback). So every launch whose
prompt mentions a file under `cwd` gets an absolute path baked into its title.
Most visible in the pending/queued window before LLM auto-naming replaces the
title.

**Suggested fix**: in `displayPromptForTask` (or the name-derivation step),
collapse absolute paths that live under the task's `cwd` back to a
`cwd`-relative form (or basename) for display only. Keep `userPrompt` absolute
so dedup is unaffected; only the rendered title/description changes. Result:
"Audit README.md against the actual code…". (Note: the launch *toast* already
shows the readable "Audit README.md…" form, so the two surfaces disagree.)

### F5. "Relationships: No dependencies" sits directly above a "Dependencies" arrow for the same task (data trust / clarity) — severity: medium

Opening the detail panel of a coordinator-chained task (e.g. "Context Pack —
issue #78", a child of "Parallel Issue Batch") shows, stacked vertically:
a header **"Relationships — No dependencies"** with a **0** badge, and
immediately below it a section literally titled **"Dependencies"** drawing
**"Parallel Issue Batch → Context Pack — issue #78"**. One panel says the task
has no dependencies; the next panel draws one. A user cannot tell whether the
task is chained or not.

**Root cause**: three relationship surfaces are rendered adjacently in
`DetailPanel.tsx:1235-1237` — `CoordinatorChainStripView` (the coordinator
chain: "parent … / Mark prior N done"), `TaskDependencyEditor`, and
`TaskDependencyRail`. `TaskDependencyEditor` computes `relationCount` over the
**manually authored** dependency graph only and prints "No dependencies" when
that count is 0 (`src/frontend/components/TaskDependencyEditor.tsx:196-198`).
`TaskDependencyRail` independently derives an `upstream → this → downstream`
rail from the live agent/coordinator data and titles it "Dependencies"
(`src/frontend/components/TaskDependencyRail.tsx:55-56`). The two disagree
because they measure different things under the same word.

**Suggested fix**: unify the vocabulary. Either fold the derived/chain edges
into `TaskDependencyEditor`'s `relationCount` (so it never says "No
dependencies" while the rail shows one), or relabel the surfaces to distinguish
concepts — e.g. "Manual dependencies" for the editor and "Task chain" / "Flow"
for the derived rail — so "dependencies" is not used twice with contradictory
answers. The `TaskDependencyRail` header comment references "#601 follow-up",
suggesting the rail was added after the editor without reconciling the copy.

## Things that worked well (keep)

- **The "Loop Nms" status-bar metric (prior-art F21) is fixed.** It no longer
  shows unconditionally: the pill renders only when the server event-loop p95
  delay is high/critical (`StatusBar.tsx:200,221`), is color-coded by severity,
  and carries a tooltip "Server event-loop p95 delay". So a user sees it only
  during a real lag spike, as a warning, with an explanation on hover.

- **Three June data-trust findings are fixed.** Prior-art F1 (tied-issue count
  exceeding open-issue count) no longer reproduces: a sweep of `/api/projects`
  found no project where `openIssuesTiedToActiveTasks > openIssues` or
  `openPrsTiedToActiveTasks > openPullRequests`. Prior-art F5 (`GET
  /api/tasks/:id` 404) is fixed — a single-task GET now returns HTTP 200 with
  the full task object. Prior-art F4 (`id` vs `taskId`) is effectively resolved:
  every task object now carries both `id` and `taskId`, equal in all 21 tasks.
- **The header spend figure now has a scope tooltip** (prior-art F21 asked for
  this) — hovering `$39905.23` explains it is all-time server spend including
  cleared/deleted tasks.
- **Launch-failure UX (prior-art F12) is fixed and now handles the bad-cwd path
  well.** Submitting a launch with a nonexistent working directory: (a) the
  dialog closes and shows an info toast "Launching task: …", then within ~1s an
  error toast "Error starting \"…\": Working directory does not exist"; (b) no
  orphan task/agent is created (`/api/tasks` and `/api/snapshot` stay clean);
  (c) the typed prompt is preserved — reopening the Launch dialog restores the
  full draft (`LaunchTaskDialog.tsx:484-489` intentionally does not clear the
  draft until a matching task is visible). Verified in a single browser context.
  (Note: the transient optimistic "Launching…" info toast immediately preceding
  the error is slightly misleading but self-corrects and auto-dismisses.)
- **The Launch dialog's busy-directory guardrail is excellent**: launching into a
  cwd that already has live agents shows an inline banner ("This working
  directory already has 6 live agents: … Open one, or launch anyway") with
  "Open existing" and "Launch anyway" actions — prevents accidental duplicate
  agents without blocking intentional ones.
- **Overview stat tiles are internally consistent**: the RUNNING tile (10) equals
  the count of cards in the RUNNING list plus its "+N more in Healthy" tail, and
  the "HEALTHY (10)" rail section, and the `/api/snapshot` agent count (21 total
  across buckets). Numbers that appear together agree.

## Suggested priority order

1. **Cluster A — status/relationship truthfulness (F1 + F5)** — highest value.
   Kookr's core promise is to tell you which tasks are fine and how they relate;
   both findings are places where that display contradicts itself. Both have
   precise root causes:
   - F1: fold `worktreeHealth !== 'ok'` into `isHealthyRunning`/`isActiveFinding`
     (`src/shared/task-routing.ts`) so the bucket and the badge agree.
   - F5: reconcile the three relationship surfaces in `DetailPanel.tsx:1235-1237`
     — either include derived/chain edges in `TaskDependencyEditor`'s
     `relationCount`, or relabel "Dependencies" (rail) vs "Manual dependencies"
     (editor) vs "Task chain".
   Both are frontend/shared-only, well-scoped, and each wants a regression test.

2. **Cluster B — display hygiene (F4 + F3 + F2)** — cheap polish.
   - F4: collapse cwd-relative paths in `displayPromptForTask`
     (`src/core/prompt-display.ts`) for the rendered title/description only.
   - F3: add a small visible "all-time" caption under the header spend figure
     (`TopBar.tsx`).
   - F2: de-duplicate projects by `localPath` in `/api/projects` (prefer the
     GitHub identity over the `local/` one).

Ship A first (trust), then B (polish). All five are independent and can fan out
to two worktrees (one per cluster).

## Session log

- 2026-09-30 — session start; RFC worktree `kookr-dogfood-202609` created off
  `origin/main` (993af462); dashboard confirmed live; API smoke checks begun.
- 2026-09-30 — API surface swept (`/api/projects`, `/api/tasks`,
  `/api/snapshot`, `/api/tasks/:id`): prior-art F1/F4/F5 verified fixed
  (keep-list); F2 (duplicate project identities) and F3 (dual spend figures)
  recorded; list order confirmed stable (a suspected reorder was a probe error).
- 2026-09-30 — Playwright storageState persisted (onboarding skipped); overview
  screenshotted; traced the HEALTHY-vs-WORKTREE-MISSING contradiction to
  `isHealthyRunning` → F1.
- 2026-09-30 — UI unhappy path (nonexistent cwd) via the Launch dialog:
  first probe *looked* like prior-art F12 (draft lost) but single-context
  re-verification showed a clear error toast + full draft restoration → keep-list,
  not a finding. Busy-directory guardrail noted as a keep.
- 2026-09-30 — UI happy path: launched a real README-vs-code audit in
  reason-at-home (task `ab12070a`, queued behind the concurrency limit with a
  clear "Queued… will start when a slot opens" toast). Absolute-path-in-title →
  F4. Suspected "queued task invisible" dissolved: a "PENDING (2)" rail section
  + Ctrl+K search both surface it → keep-list.
- 2026-09-30 — opened a running task's detail panel (read-only): live
  terminal + activity feed + composer + complete/reflect actions all present;
  found the "No dependencies" vs "Dependencies"-arrow contradiction across the
  three stacked relationship surfaces → F5. Suspected always-on "Loop Nms"
  metric (prior F21) shown to be threshold-gated with a tooltip → keep-list.
- 2026-09-30 — RFC finalized (summary, priority clusters); committed in the
  worktree. implement=false → stopping to ask about push / implementation.

## Method note (for the next run of this playbook)

Three of the six phenomena that first looked like bugs this session were probe
or reading artifacts, all caught by the playbook's "re-verify in a single
browser context" rule and by reading the code before recording: (1) launch
draft "loss" was just the dialog closing — the draft restores on reopen;
(2) the queued task was not invisible — it lives in the "PENDING" rail section;
(3) the "Loop Nms" metric is threshold-gated, not always-on. Net: the re-verify
discipline is load-bearing; without it this RFC would have carried three false
regressions. Recommend the playbook keep emphasizing "read the code / re-verify
before recording", and add an explicit sub-rule: *a closed dialog is not proof
of lost state — reopen and check localStorage-backed restoration.*
