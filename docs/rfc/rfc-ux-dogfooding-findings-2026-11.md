# RFC: UX Dogfooding Findings — November 2026

- **Status**: Draft (living document, updated during the dogfooding session)
- **Author**: Claude (Opus 4.8) — dogfooding session driven as a "classical user"
- **Date**: 2026-11-04
- **Base**: `origin/main` @ `1fdcd70a`
- **Method**: Drive the live dashboard at `localhost:4800` through normal user
  workflows — API surface as a scripter would hit it (`/api/projects`,
  `/api/tasks`, `/api/snapshot`), UI happy path (launch via dialog, watch the
  live terminal, reply to a signaled-complete task, complete with a rating), UI
  unhappy path (deliberate bad input), and rail/triage behavior over time.
  Launch real, useful tasks only in the private projects
  (`kookr`, `knowledge-base-mcp-server`, `reason-at-home`). Record every
  friction point, bug, data inconsistency, or wording problem as it is
  encountered, with severity + evidence + suggested fix. Root-cause every
  medium/high finding to a `file:line`.
- **Prior art**: `docs/rfc/rfc-ux-dogfooding-findings-2026-06.md` (21 findings).

## Summary

Running Kookr as a real user for one session surfaced **8 findings** and **14
things that already work well**. Encouragingly, **every June finding that was
re-tested is now fixed** — the single-task GET (K1), `id`/`taskId` naming (K2),
the tied-count contradiction (K3), the empty landing "black void" (K6), the
surprising Codex-CLI launch default (K7), and the "Flag FP" jargon (K9) are all
resolved. The product has clearly matured.

This session's findings cluster into four buckets:

- **Data trust / wording** — the biggest remaining gap. Three (really four)
  different spend figures share the screen and the `$49k` all-time header has no
  visible scope, and its own drill-down doesn't reconcile (F4).
- **List / queue hygiene** — junk `local/tmp` and null-path projects never get
  pruned (F1); a merged task lingers in the review queue under an alarming
  `WORKTREE MISSING` badge (F7); null tied-counts (F2) and a space-bearing
  project id (F3).
- **DX / developer-facing** — every `kookr`/`nb` CLI call prints a Node
  `MODULE_TYPELESS_PACKAGE_JSON` perf warning that pollutes agent transcripts
  (F8); the launch dialog does no inline cwd validation (F6).
- **Affordance clarity** — cryptic child-count micro-badges (`9c 1/8/0`) remain
  unglossed (F5).

The standout *positive*: the bad-cwd error path (K5) is genuinely
best-in-class — it names the problem, promises to preserve the draft, and keeps
that promise. That pattern should be the template for the product's other error
surfaces.

## Findings

### F1. Junk/empty-path `local/*` projects persist as first-class rows (list hygiene) — severity: medium

`GET /api/projects` still returns `local/tmp` (localPath `/tmp`) and
`local/ralph-verify-claude` (localPath `null`) as first-class project rows,
months after the first dogfood run flagged `local/tmp` (June F3). The June fix
added `filterDeadLocalProjects`, but it only removes a local project when its
path **fails** `access()`:

- `local/tmp` → `/tmp` always exists, so `access()` never throws and the row is
  never pruned. `/tmp` is a transient test cwd, not a project.
- `local/ralph-verify-claude` → `localPath` is `null`; the filter's guard
  `!summary.localPath` returns `keep: true` **unconditionally**, so a project
  pointing at nothing is kept (more dead than a vanished path, yet never pruned).

**Evidence**: `GET /api/projects` →
`{"project":"local/tmp","localPath":"/tmp",...}` and
`{"project":"local/ralph-verify-claude","localPath":null,...}` among 55 projects.

**Root cause**: `src/server/routes/project-routes.ts:225` (unconditional keep
when `!localPath`) and `:228-229` (`access(localPath)` only catches vanished
paths, not junk paths that always exist).

**Suggested fix**: (a) at track time reject cwds under the OS temp dir
(`os.tmpdir()`, `/tmp`) from being registered as `local/*` projects; (b) in
`filterDeadLocalProjects`, treat empty/null `localPath` as *not keepable* (drop
it unless it has an active task) instead of unconditionally keeping it.

### F2. `openIssuesTiedToActiveTasks` / `openPrsTiedToActiveTasks` are `null` on every inactive project (DX / data consistency) — severity: low

The tied-count fields are populated only for the 5 projects with active agents;
all other 50 projects return `null` for both. A scripter cross-referencing
`openIssues` against `...TiedToActiveTasks` gets a type that flips between
`number` and `null` by row, with no documented contract for which. (Prior June
F1 — tied > open — is **fixed**; this is the residual shape wart.)

**Evidence**: active projects return e.g. `tiedIssues=1`; all inactive ones
return `tiedIssues=None`/`tiedPrs=None`.

**Suggested fix**: return `0` rather than `null` when a project has no active
tasks (the semantically-true count), so the field is always a number.

### F3. Project identifier may contain a raw space (`local/ferox capital`) (robustness) — severity: low

A tracked project id is `local/ferox capital` (localPath
`/home/jean/git/ferox capital`). A space inside a project identifier is a
latent hazard for any code that interpolates the id into a shell command, a URL
path, a filename, or a CSS/testid selector. No breakage observed this session,
but it is an un-sanitized identifier flowing through many surfaces.

**Suggested fix**: slugify `local/*` project ids (spaces → `-`) while keeping
`displayName` for presentation, or reject/warn on cwds whose basename contains
whitespace at track time.

### F4. Three unreconciled spend figures on one screen; the all-time header total carries no visible scope (data trust / wording) — severity: medium

The landing screen shows **three different dollar figures at once** with no
on-screen reconciliation:

- header `$49361.00`
- overview runtime mix: `Claude 52 · Codex 3 · $513.98 live spend`
- status bar: `$439.22 (24h)`

The header is ~96× the "live spend". Its only scope cue is a hover `title`
("All-time agent spend recorded by this Kookr server — includes cleared and
deleted tasks"); nothing visible distinguishes it from the current burn. June
F9 flagged this exact header (`$17072.37` then) as "cumulative spend with no
period or scope label" — still unresolved, and the number has since tripled.

**Evidence**: all three figures captured simultaneously on the landing view
(`/tmp/kookr-ux-shots/01-landing.png`).

**Root cause**: `src/frontend/components/TopBar.tsx:557-558` renders
`formatCost(totalSpendUsd)` with the scope only in the `title` attribute. The
"live spend" is the overview runtime-mix sum
(`src/frontend/components/OverviewEmptyState.tsx` ~L231-241) and the 24h figure
is the status-bar pill (`src/frontend/components/StatusBar.tsx`) — three
independent sums presented without labels tying them to a scope.

**Suggested fix**: give the header spend a short *visible* scope label (a muted
"all-time" suffix or caption) so it no longer reads as the current/live number
sitting next to two smaller scoped figures.

**Aggravating factor**: the header spend is a button that opens the Cost
Comparison panel — the natural "explain this number" affordance — but that panel
defaults to a **7-day** window and leads with a *fourth* figure (`$1520.18`
Claude aggregate), with nothing tying it back to the `$49361.00` the user
clicked. The drill-down deepens the confusion instead of resolving it. A header
labeled "all-time" plus a panel that opens on (or at least surfaces) the
matching all-time total would close the loop.

### F5. Cryptic child-count micro-badges persist on task cards (wording / affordance) — severity: low

Task cards still show opaque badges — `9c 1/8/0` (Parallel Issue Batch), `3/7`
(rail header), `1c` — with no glanceable meaning or discoverable tooltip. June
F9 flagged `1c 1/0/0` / `Nudge ⏱ 40`; the child-count badges remain unglossed.

**Evidence**: rail card "Parallel Issue Batch" shows `9c 1/8/0`; the agent's own
message clarifies it means "9 children, wave complete 4/4 merged" — i.e. the
badge encodes child counts a user cannot decode from the glyphs.

**Suggested fix**: add `title`/tooltip text (e.g. "9 child tasks · 1 running /
8 merged / 0 failed") or a one-line legend near the first such badge.

### F6. Launch dialog does not validate working-directory existence client-side (DX) — severity: low

Entering a nonexistent working directory leaves the **Launch button enabled**
with no inline warning; the "does not exist" error only surfaces after submit
(server-side). Impact is bounded to one wasted round-trip because the
post-submit error and draft-restore are excellent (see K5), so this is low
priority.

**Evidence**: cwd `/home/jean/git/nonexistent-dogfood-probe` accepted with no
inline validation; error appeared only after clicking Launch.

**Suggested fix** (optional): a debounced existence probe on blur could
pre-empt the failed launch, but given the strong error path this is a nicety,
not a defect.

### F7. A merged task lingers in the review queue as "SIGNALED COMPLETE / WORKTREE MISSING" (triage / data trust) — severity: medium

Completing the audit task auto-advanced the dashboard to task `c51e4f00`
("Improve the application … increase the gain", `world-locked-binaural-surround`),
which sits in **Waiting on you** as *Signaled complete* with a red
**WORKTREE MISSING** badge — even though its own terminal reports the work is
already shipped: *"PR #254 is MERGED to main (commit 2ac4d50); remote branch
deleted, local main fast-forwarded, worktree removed."*

**Evidence**: `/api/tasks` → `status: inProgress`, `finishedAt: null`;
`/api/snapshot` → `turnState: completed_turn`, `anomaly.type: needs_input`.
UI: red `WORKTREE MISSING` badge in the task header and a card in *Waiting on
you*.

Two coupled problems:
- **(a)** A task whose PR is already merged still demands a manual *Complete* —
  merge is not wired to auto-close (or relabel) the task, so merged work piles
  up in the human queue.
- **(b)** The red `WORKTREE MISSING` badge alarms on an **expected**
  post-delivery cleanup (the agent removed its own worktree after merging), so
  a normal end-state looks like a fault.

**Suggested fix**: when a signaled-complete task's PR is detected merged (or the
agent reports "worktree removed after merge"), auto-transition it to a
*merged/done* state instead of leaving it in *Waiting on you*; and distinguish
"worktree cleaned up (expected after merge)" from "worktree missing
(unexpected)" so the badge only alarms on the latter.

### F8. CLI bins emit a Node `MODULE_TYPELESS_PACKAGE_JSON` perf warning on every invocation (DX) — severity: medium

While running `kookr signal completion-ready`, the audit agent's live terminal
printed (twice) a Node warning that then lands in the agent transcript:

> `[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///…/bin/kb-spool-shim.js is not specified and it doesn't parse as CommonJS. Reparsing as ES module because module syntax was detected. This incurs a performance overhead.`

**Evidence / repro** (on `origin/main`; the prod runtime HEAD `1fdcd70a` **is**
`origin/main`): `node bin/kb-spool-shim.js --help` emits the warning verbatim,
ending with *"add `\"type\": \"module\"` to …/package.json"*.

**Root cause**: `package.json` has no `"type"` field (defaults to CommonJS), but
`bin/kb-spool-shim.js:16`, `bin/kookr-spawn.js:14`, `bin/import-maybe-ts.js:10`,
and `bin/nb.js` use ESM `import`/`export`. Node reparses each as ESM and warns —
a per-call performance overhead **and** console noise that pollutes every agent
transcript that shells out to the CLI. (`nb add --help` emits it too, so the
`nb` notebook CLI is affected on every invocation, not just `kookr`.)

**Suggested fix**: rename the ESM-only bins to `.mjs` (updating the `bin` map in
`package.json` and any importers), or add `"type": "module"` and migrate the
CommonJS bins. Either removes the warning and the reparse overhead.

## Things that worked well (keep-list)

- **K1. `GET /api/tasks/:id` now returns 200** (June F5 was "no single-task
  GET" — table stakes for scripters, now shipped).
- **K2. `id`/`taskId` naming reconciled** — `/api/tasks` now exposes **both**
  `id` and `taskId`, equal on all 55 tasks, matching `/api/snapshot` and
  `/api/projects.recentTasks[]` which key on `taskId` (June F4 fixed via alias).
- **K3. Tied-count contradiction gone** — no project returns
  `tiedIssues > openIssues` or `tiedPrs > openPrs` anymore (June F1 fixed; tied
  counts are now a true subset of open counts where populated).
- **K4. Dead-path local projects are pruned** — `filterDeadLocalProjects`
  removes `local/*` rows whose path has vanished (June F3 partially addressed;
  see F1 for the `/tmp` / null-path gap that remains).
- **K5. Bad-cwd launch error is exemplary, and the draft is restored** (verified
  in a single browser context). Submitting a nonexistent cwd produced: *"Working
  directory does not exist: &lt;path&gt;. The working directory was not found on
  this machine — nothing was launched. • Create the directory, or reopen the
  Launch dialog and pick an existing checkout. • If you typed the prompt in the
  Launch dialog, it is preserved and restored when the dialog reopens."*
  Reopening showed a **"Restored your last draft"** banner with the description
  **and** cwd intact. Names the problem, reassures nothing launched, gives
  recovery steps, and keeps its promise. This is the gold standard for the
  product's error surfaces.
- **K6. Landing overview is populated** (June F8 "black void" fixed) — RUNNING /
  NEEDS INPUT / COMPLETED tiles plus Waiting-on-you / Running / Recently
  completed / Next scheduled sections and a runtime mix line.
- **K7. Launch agent default is now Claude Code** (June F6 fixed — was a
  surprising Codex CLI default) with a one-line description of what it is.
- **K8. Working-directory collision guard** — the dialog warns when the chosen
  cwd already has N live agents, naming them, and offers *Open existing* /
  *Launch anyway*; a *Use main checkout* revert link appears once the cwd
  diverges from the default.
- **K9. Finding controls read clearer** — "Not a real issue" / "Missed a real
  issue — report" replace June F9's supervisor jargon ("Flag FP / Flag missed").
- **K10. Live terminal mirror** — the task detail view streams the agent's
  real-time terminal output (observed the audit task reading files and running
  `sed`/`grep` live).
- **K11. Cost Comparison panel is transparent about its own blind spots** — it
  names the exact unpriced model (`gpt-6-luna → add a row to pricing-tables.ts`),
  flags stale pricing (`claude-opus-4-8 last verified 2026-07-15`), counts
  unbound Codex rollouts (46), and offers per-playbook averages + CSV export.
  Caveating *why* Codex shows `$0.00` (unbound/unpriced) instead of silently
  showing a wrong number is exactly right. (See F4 for the one gap: it doesn't
  reconcile with the header figure that opens it.)
- **K12. Signaled-complete lifecycle is smooth** — launch → live-terminal watch
  → follow-up reply (agent re-ran a quick turn and re-signaled) → Complete with
  an optional 👍/👎 rating + a free-text "what worked" note + an optional
  "create reflection task" checkbox. Verified end-to-end on the audit task.
- **K13. Auto-advance on completion** — completing a waiting task immediately
  advances the view to the next item in *Waiting on you*, so a reviewer can
  clear the queue without hunting for the next card.
- **K14. Agents enforce their own worktree discipline** — the injected task
  context tells the agent *"you are in the main checkout … do NOT commit to
  main … create a fresh `git worktree` … fetch origin main first"*, and the
  audit agent obeyed (did a read-only audit, opened no PR, touched no files).

## Suggested priority order

Grouped into shippable clusters, each independently implementable in its own
worktree:

1. **Cluster A — CLI module-type warning (F8)** · *DX, high-confidence, low-risk.*
   Rename the ESM-only bins (`bin/kb-spool-shim.js`, `bin/kookr-spawn.js`,
   `bin/import-maybe-ts.js`, `bin/nb.js`) to `.mjs` (+ update the `bin` map and
   importers), or add `"type": "module"` and migrate the CommonJS bins.
   Acceptance: `node bin/<each>.js --help` emits no `MODULE_TYPELESS` warning.
   Ship first — it's pure upside and removes noise from every future transcript.

2. **Cluster B — project list hygiene (F1, F2, F3)** · *backend, self-contained.*
   In `src/server/routes/project-routes.ts`: drop `local/*` projects whose path
   is empty/null or resolves under the OS temp dir; return `0` (not `null`) for
   tied-counts on inactive projects; slugify/space-guard `local/*` ids.
   Acceptance: `GET /api/projects` no longer lists `local/tmp` or
   `local/ralph-verify-claude`; tied-counts are always numbers.

3. **Cluster C — cost figure clarity (F4)** · *frontend, high user-visible value.*
   Add a visible scope label to the header spend (`TopBar.tsx`) and have the Cost
   Comparison panel surface the matching all-time total.
   Acceptance: the header no longer reads as the live number; the drill-down
   reconciles.

4. **Cluster D — badge legibility (F5)** · *frontend, small.* Add `title`
   tooltips / a legend to the child-count micro-badges.

5. **Cluster E — merged-task triage (F7)** · *backend + frontend, needs design.*
   Wire merge-detection (or agent-reported "worktree removed after merge") to
   auto-close or relabel the task, and split "worktree cleaned up (expected)"
   from "worktree missing (unexpected)". Highest user value but largest blast
   radius — stage it carefully, after A–D.

**F6** (inline cwd validation) is a low-priority nicety given the excellent
post-submit error (K5); fold it in only if Cluster C touches the launch dialog.

## Session log

- **2026-11-04 ~20:45Z** — Phase 1 setup: dashboard live (`/api/snapshot` ok);
  RFC worktree `kookr-dogfood-202611` off `origin/main@1fdcd70a`; RFC seeded.
- **2026-11-04 ~20:50Z** — API scripter pass over `/api/tasks`, `/api/projects`,
  `/api/snapshot`. Re-tested June API findings: F4/F5/F1 confirmed fixed
  (→ K1-K3). New: junk/empty local projects (F1), null tied-counts (F2),
  spaced project id (F3). Root-caused F1 to `project-routes.ts:225,228-229`.
- **2026-11-04 ~21:10Z** — UI pass via Claude-in-Chrome. Landing overview now
  populated (→ K6). Cost figures don't reconcile ($49k/$514/$439) → F4,
  root-caused to `TopBar.tsx:557-558`. Launch dialog: agent default now Claude
  Code (→ K7), collision guard (→ K8), no inline cwd validation (F6). Unhappy
  path (bad cwd) → exemplary error + draft restore, re-verified single-context
  (→ K5). Launched a real README-vs-code audit into knowledge-base-mcp-server
  (task `44bee49e`), watched the live terminal stream (→ K10). Cryptic badges
  persist → F5. Awaiting the audit's signaled-complete to drive reply + rating.
- **2026-11-04 ~21:35Z** — Audit signaled completion-ready (found a real
  user-affecting doc bug: `README.md:254 knowledge_base → knowledge_base_name`,
  silently ignored). Drove the full lifecycle: follow-up reply → agent
  re-signalled → Complete with 👍 + "what worked" note (→ K12/K13). Completion
  auto-advanced to the next waiting item (→ K13), which was the merged-but-
  lingering task `c51e4f00` → F7. The `kookr signal` call exposed a reproducible
  CLI `MODULE_TYPELESS` warning → F8 (root-caused + reproduced on origin/main).
  Cost drill-down adds a 4th figure → F4 aggravating factor; Cost Comparison
  transparency → K11. RFC finalized with Summary + priority clusters A–E.
- **2026-11-04 ~21:40Z** — Per user request, recorded the dogfood approach for
  next time: added a lesson to the `ux-dogfood-loop` notebook shelf and folded a
  "gather context (recent merged PRs + completed tasks) and prioritise
  self-improvement repos" step into this playbook's Phase 2.
