# RFC: Launch prompt recall — repeat a past manual prompt without a playbook

**Status:** Draft (v2 — post round-1 critic incorporation + consensus attack; converged)
**Date:** 2026-09-04
**Author:** Jean Ibarz (with Claude)

---

## Problem

A user frequently re-runs the *same manual prompt* on a *specific repository* —
"review the diff since origin/main", "bump the deps and run tests", a bespoke
refactor instruction they tuned over several launches. Today the only ways to
repeat a manual prompt are:

1. **Retype it** from memory. Lossy for anything longer than a sentence.
2. **Restore the single draft.** `LaunchTaskDialog` persists exactly one draft
   (`kookr:launchDialogDraft`, `launch-task-dialog-draft.ts`), overwritten by the
   next thing typed and cleared once a matching task appears. It recalls *the last
   unfinished thing*, not *a past sent prompt*.
3. **Relaunch a task** from the task list — but you must first *find* that task in
   the list. The task list is a task browser, not a prompt picker; there is no
   "the prompt I like" recall surfaced at the point of launch.
4. **Write a playbook.** The sanctioned way to make a prompt reusable, but
   heavyweight: a `.kookr/playbooks/*.md` file, parameters, scoping, review. For a
   one-off phrasing the user just wants to fire again, that is disproportionate.

The gap: **no lightweight recall of prompts already sent via the manual Launch
dialog, surfaced at the next launch.** The `cwd` field has this affordance —
`RecentPaths` (`recent-paths.ts`) is an MRU dropdown of working directories. The
prompt field has only three *static* sample chips (`SAMPLE_LAUNCH_PROMPTS`) and
the single overwritable draft.

### Key fact that shapes the design

**Every launched prompt is already durably persisted server-side.** Each `Task`
carries `userPrompt` (the original operator-authored prompt, pre-injection),
`cwd`, `createdAt`, and `provenance` — where `provenance.kind === 'manual'` marks
a plain UI/CLI/API/WS launch (`task-provenance.ts`). Live prompts are in the
SQLite task store; terminal tasks are archived (`task-archive.ts`, #2765)
**before** being pruned. The compact list (`GET /api/tasks?view=compact`)
deliberately strips prompt bodies for payload size (they totalled ~8.7 MB for
~213 tasks on prod), but the full prompt stays available via `GET /api/tasks/:id`.

This is decisive (see Alternatives). The user asked to "**recover historical
prompts already sent**". A purely client-side MRU built from scratch would start
**empty** and only capture launches made *after* the feature ships, *from this one
browser*. The server already holds the user's launch history — **in the live task
store**, which on a real instance is deep (prod was observed holding 200+ tasks;
the 1-day prune below only runs when the maintenance sweep is enabled, which is
off by default), plus a forward-only archive (see the population caveat under
Retention horizon).

### Retention horizon (stated honestly — round-1 findings F1/F6, ambition-crux)

Two horizons bound "already sent", and the design must be honest about both:

- **Live store: ~1 day.** `DEFAULT_TASK_RECORD_MAX_AGE_DAYS = 1`
  (`prune-aged-task-records.ts`) prunes terminal tasks from the hot store after a
  day when the maintenance sweep is enabled (which the ops docs advise). So a
  live-store-only recall degrades to "prompts from the last ~day" — it does **not**
  satisfy "already sent".
- **Archive: ~90 days.** `DEFAULT_TASK_ARCHIVE_RETENTION_DAYS = 90`. Every
  terminal task is archived before deletion, and `readArchivedTasks()` returns
  fully-normalized `Task[]` in the same shape.

**Therefore v1 unions the live store with a bounded archive read** (not deferred —
see round-1 resolution). Where the depth actually comes from:

- **The live store carries the launch-day backfill.** On an instance that has not
  enabled the aggressive 1-day prune (the default), `viewTasks()` already holds
  the user's recent manual launches going back a long way — this is what makes the
  Alt-1 rejection real *today*, not the archive.
- **Archive population caveat (consensus-attack finding, verified).** The archive
  *retains* 90 days, but archiving is **forward-only and began with #2765**
  (`task-archive.ts`, committed 2026-09-02 — the same lineage this work descends
  from); there is **no backfill migration**. So the archive's *depth* grows from
  its deploy date toward the 90-day ceiling rather than starting full. On a shallow
  live store (aggressive prune enabled), the recall window at launch is only as
  deep as the archive has been accumulating — maturing to the full 90 days over the
  following quarter.
- **Honest guarantee:** "any manual prompt still retained server-side — the full
  live store plus the archive since #2765." That is deep on a typical instance and
  matures to ~90 days of terminal history; it is **not** "literally ever", and on
  an instance that pruned aggressively *before* #2765 existed, pre-#2765 terminal
  prompts are unrecoverable (a client MRU would fare no better — it too starts
  empty).

- **Provenance horizon.** `provenance` shipped in #1583; tasks created before it
  default to `{ kind: 'unknown' }`. Recall filters `kind === 'manual'`, so
  pre-#1583 launches are **not** recalled. This is intentional (including
  `unknown` would surface old *autonomous/scheduled* prompts as if hand-typed).
  New launches all carry provenance; the `unknown` tail shrinks over time. Stated
  here so the horizon is a known decision, not a silent gap.

### Scope note

Covers the **manual** Launch tab of `LaunchTaskDialog` only. Explicitly deferred
(named per round-1): `QuickLaunch.tsx` (the lighter launcher — same protocol, same
`recentPaths.add`; the surface-agnostic hook/projection make it a cheap follow-on,
but v1 scopes to the primary dialog). Playbook launches (own relaunch path), voice,
paste, and sample chips are untouched.

## Goals

- **G1** — At the next launch, one or two interactions to refill the Task
  description with a manual prompt previously *sent* (within archive retention),
  including prompts sent before this feature shipped and on a fresh browser.
- **G2** — Bias recall toward the **current working directory**: prompts *ever*
  launched against the current cwd rank first (round-1 F3: "ever", not "most
  recently"). This is the "repeat a prompt on a *specific* repository" half.
- **G3** — Reuse what exists: the persisted task store, the `GET /api/tasks/*`
  route family, `readArchivedTasks`, `canonicalizeCwd`, `displayPromptForTask`,
  and the dialog's `setPrompt` fill path. No new persistence substrate.
- **G4** — Non-destructive and never surprising: recall only *fills the prompt
  field* (like the sample chips). Never auto-submits, never changes cwd/agent,
  never overwrites a non-empty prompt except as the direct result of an explicit
  selection, and degrades to an invisible no-op with no history or on fetch
  failure.

## Non-goals

- **NG1** — Not a replacement for playbooks: no parameters, templating, or
  substitution. A recalled prompt is verbatim text.
- **NG2** — Not a full task-history browser (the task list / relaunch owns that).
- **NG3** — No mutation. The route is strictly read-only; nothing is deleted or
  edited.
- **NG4** — No new realtime/WS message. Recall is a plain HTTP GET fetched on
  demand when the recall panel is opened — never pushed in the snapshot (keeping
  the snapshot compact and prompt-free).
- **NG5** — Recall fills the **prompt only**. It does not restore cwd, criteria,
  or agent type (that is the task-list Relaunch's job — round-1 F11; conflating
  "fill a field" with "resume a task" is out of scope).

## Success criteria (P1 must)

- A user who sent a manual prompt against repo X **within archive retention
  (~90 days)** can, at the next Launch, refill that exact prompt in ≤2
  interactions without retyping — even on a fresh browser.
- A prompt *ever* launched against the current (canonicalized) cwd ranks above
  prompts never launched there — even when its most recent launch was elsewhere.
- The recall query adds **zero** bytes to the snapshot / compact list and is
  fetched only when the recall panel is opened.
- A failed or empty recall fetch never blocks a launch and shows no dead
  affordance.
- No regression to the existing sample chips, draft restore, cwd MRU, keyboard
  submit, or duplicate/quota banners.

## Requirements

### Server

- **R1** — New read-only route `GET /api/tasks/recent-prompts` returns the most
  recent *distinct* manual-launch prompts. Params: `cwd` (optional string, the
  working directory to prioritize) and `limit` (optional; **default 20**, clamped
  to **[1, 50]**; non-numeric/absent → default; empty `cwd` treated as absent —
  round-1 F12).
- **R2** — It SHALL be **registered before `GET /api/tasks/:id`** in
  `task-routes.ts` (Hono matches in registration order; after `:id` the literal
  path would be captured as an id). A route test SHALL assert it is not shadowed
  (round-1 boundary finding).
- **R3** — Source = the **live store unioned with a bounded archive read**:
  `taskStore.viewTasks()` (the **non-cloning** read — `listTasks()` deep-clones
  every task and is a documented event-loop hazard; the projection is read-only
  and never retains task refs — round-1 F5) concatenated with
  `readArchivedTasks(<kookrDir>/task-archive, { limit: 500 }).records.map(r =>
  r.task)`. When `kookrDir` is unwired (test/minimal), archive is empty (mirrors
  the `archive` route).
- **R4** — Selection includes only tasks with `provenance?.kind === 'manual'` and
  a non-empty display prompt. The prompt text SHALL be
  `displayPromptForTask(task)` (prefers `userPrompt`, strips the worktree-guardrail
  preamble, falls back to legacy `prompt`) — so legacy and new records converge
  and no injected guidance is ever surfaced (round-1 F10).
- **R5** — **Ranking then dedup** (round-1 F3, F4): normalize every cwd with an
  injected canonicalizer (the route supplies `canonicalizeCwd`, **memoized per
  distinct cwd string** so `realpathSync` runs a handful of times, not once per
  task). A prompt's `cwdMatch` is true iff **any** occurrence's canonical cwd
  equals the canonical query cwd. Dedup on trimmed display text keeps the
  most-recent occurrence for display (`cwd`, `at`). Partition `cwdMatch` first,
  each partition most-recent-first, then cap at `limit`.
- **R6** — No new auth/exposure surface: it lives in the existing `task-routes.ts`
  family and inherits its middleware. It returns prompt bodies the same-origin
  dashboard already obtains via `GET /api/tasks?view=full` (the real precedent —
  round-1 F: `view=full` already bulk-returns all prompt bodies; `:id` returns
  one). No credentials, no cross-origin.

### Frontend

- **R7** — Recall data is fetched **once when the manual tab is shown** (the hook's
  `enabled = tab === 'manual' && !isRelaunch`), with the dialog's current cwd —
  fetch-on-mount like `useLaunchTaskCwds`, so the picker can *hide itself* when
  there is no history (R8/R10 no-dead-affordance) rather than showing an empty
  toggle. There is **no keystroke-debounced refetch** (round-1 F2/F5/F9,
  design-minimalist, boundary: the "mirrors playbooks refetch-on-cwd-change" claim
  in the v1 draft was false — the playbooks catalog fetches on mount/tab-switch,
  never per keystroke; a debounce/abort machine has no precedent and creates the
  clone-storm and panel-remount failure modes). Ranking reflects the cwd at
  fetch time; changing cwd afterward does not refetch (re-ranking on cwd change is
  a noted deferral). The fetch is abortable on unmount.
- **R8** — A **recall control** (a "Recent prompts" toggle) in the manual tab's
  `launch-prompt-field`, beside the sample-prompt chips. Opening it reveals a
  panel listing entries: display-prompt excerpt + relative time + a small "in
  *repo-basename*" tag when the entry did not match the current cwd. Selecting an
  entry fills the Task description (`setPrompt` + focus) and closes the panel —
  same effect as a sample chip; it MUST NOT overwrite a non-empty prompt except as
  the direct result of that selection (G4).
- **R9** — The panel offers a **substring filter** over the fetched set,
  case-insensitive, labeled honestly as filtering the *shown* prompts (round-1 F8
  — it searches the fetched top-N, not the whole store; server-side search is a
  noted deferral). The panel stays mounted across the fetch lifecycle so filter
  text/focus survive a reload (round-1 F9). **No per-entry dismiss** (round-1
  design-minimalist/consensus: a session hide gives no confidentiality — the same
  body is one click away via task detail — so it is UI weight with no safety
  property; the substring filter is enough to scroll past an entry).
- **R10** — All fetch/parse failures fail closed: non-2xx, aborted, or malformed
  body → "no recall available", the control does not render, launch unaffected.
- **R11** — Recall SHALL NOT render on the relaunch path (`isRelaunch`), which
  drives the form from props and owns its state (as the draft is suppressed there).

## Design

### Module structure

| Path | Responsibility |
|------|----------------|
| `src/core/recent-manual-prompts.ts` | **Pure** projection `selectRecentManualPrompts(tasks, { cwd?, limit, normalizeCwd? })`. Uses core's `displayPromptForTask`. `normalizeCwd` defaults to a trivial trim+strip-trailing-slash so core stays pure and testable without the server; the route injects the real `canonicalizeCwd`. No I/O, no Hono, no server import (enforced by `layer-boundary.test.ts`; precedent: `task-provenance.ts` does provenance selection in core). |
| `src/core/recent-manual-prompts.test.ts` | Dedup, cwdMatch-over-all-occurrences-before-cap (F3), normalizeCwd trailing-slash/`~` (F4), legacy `displayPromptForTask` convergence (F10), provenance filter incl. `unknown` exclusion horizon (F1), limit clamp (F12), empty. |
| `src/shared/contracts/recent-prompts.ts` | `RecentPromptEntry` type + `parseRecentPromptsResponse` guard (matches the ~80 existing per-endpoint contract files). |
| `src/server/routes/task-routes.ts` (edit) | `GET /api/tasks/recent-prompts` registered **before** `:id`: parse params, read `viewTasks()` ∪ bounded archive, memoized `canonicalizeCwd`, call the pure projection, `c.json`. |
| `src/server/routes/task-routes.recent-prompts.test.ts` | Param/limit clamp, provenance filter, archive union, **no-shadow ordering assertion** (F/boundary). |
| `src/frontend/api/tasks.ts` (edit) | `getRecentPrompts(cwd, signal): Promise<RecentPromptEntry[]>` — fails closed to `[]`. |
| `src/frontend/hooks/useRecentPrompts.ts` | Owns the fetch lifecycle only: given `{ enabled, cwd }`, fetch once when `enabled` turns true, abort on unmount; returns `{ entries, loading }`. Modeled on `useLaunchTaskCwds` (fetch-once + `active` flag), **not** a debounce. |
| `src/frontend/components/RecentPromptsPicker.tsx` | Presentational + local filter-text state only (ownership stated explicitly — round-1 boundary): renders `entries`, owns the substring filter input, emits `onSelect(prompt)`. No fetch, no dismiss. |
| `src/frontend/components/RecentPromptsPicker.test.tsx` | Render, filter, select-emits, empty-state, filter-survives-reload. |
| `src/frontend/components/LaunchTaskDialog.tsx` (edit) | Mount hook+picker in the manual tab (`!isRelaunch`); `onSelect = setPrompt`+focus. |
| `src/shared/contracts/telemetry.ts` (edit) | Add `launch_prompt_recall_used`. |

### Data shape

```ts
// src/shared/contracts/recent-prompts.ts
export interface RecentPromptEntry {
  prompt: string;    // displayPromptForTask(task): guardrail-stripped, trimmed
  cwd: string;       // most-recent occurrence's cwd (drives the "in <repo>" tag)
  at: number;        // most-recent occurrence createdAt, epoch ms
  cwdMatch: boolean; // any occurrence launched against the (canonical) query cwd
}
```

`agentType` and `taskId` are deliberately **omitted** in v1 (round-1 F11 /
design-minimalist YAGNI): recall fills only the prompt, so a displayed agent would
imply a fidelity the fill does not deliver, and no consumer needs a task id yet.

### Projection (pure)

`selectRecentManualPrompts(tasks, { cwd, limit, normalizeCwd })`:
1. keep `t.provenance?.kind === 'manual'` with a non-empty
   `displayPromptForTask(t)`,
2. sort by `createdAt` desc,
3. `qn = cwd ? normalizeCwd(cwd) : undefined`; walk in order, group by display
   text; per group keep the first (most-recent) occurrence for `cwd`/`at`, and set
   `cwdMatch ||= qn !== undefined && normalizeCwd(t.cwd) === qn` across **all** its
   occurrences,
4. stable-partition groups `cwdMatch` first,
5. take `min(limit, 50)`.

### Fetch lifecycle

Fetch-on-manual-tab-shown (R7). When the manual tab mounts, the hook fetches once
with the current cwd → the server canonicalizes and ranks → the picker renders its
toggle only if entries exist, and filters client-side once expanded. This is the
fetch-on-mount pattern of `useLaunchTaskCwds`, chosen over a lazy fetch-on-toggle
so the empty case hides the toggle entirely (no dead affordance). One bounded GET
of a few kilobytes per manual-tab open; no keystroke machinery.

### Telemetry

`launch_prompt_recall_used` on select, carrying `cwdMatch` and the rank index — no
recall-opened/dwell events (the existing `launch_dialog_*` events bound the funnel).

## Files to change

- **new** `src/core/recent-manual-prompts.ts` (+ test)
- **new** `src/shared/contracts/recent-prompts.ts`
- **new** `src/frontend/hooks/useRecentPrompts.ts`
- **new** `src/frontend/components/RecentPromptsPicker.tsx` (+ test)
- **edit** `src/server/routes/task-routes.ts` (+ recent-prompts route test)
- **edit** `src/frontend/api/tasks.ts` — `getRecentPrompts`
- **edit** `src/frontend/components/LaunchTaskDialog.tsx` (+ its test)
- **edit** `src/shared/contracts/telemetry.ts` — new event
- **edit** `docs/features.md` / `docs/user-guide.md`

## Edge cases

- **Live/archive overlap.** A task could appear in both `viewTasks()` and the
  archive page (archived-then-not-yet-pruned). Dedup-on-text collapses it; the
  most-recent occurrence wins, so no double entry.
- **`realpathSync` cost.** `canonicalizeCwd` hits the fs. Memoized per distinct
  cwd string within the request, and run once per panel-open (never per keystroke),
  so it is a handful of `stat`s, not hundreds.
- **cwd never launched against.** No exact canonical match → `cwdMatch:false` for
  all → global recency order, no error.
- **Legacy tasks / injected guidance.** `displayPromptForTask` strips the
  guardrail preamble and prefers `userPrompt`, so a legacy `prompt` and its
  re-launched `userPrompt` converge and dedup merges them (F10).
- **Pre-#1583 (`unknown`) history.** Not recalled by design (stated horizon).
- **Prompt with secrets.** The body already lives server-side and is already
  retrievable same-origin via `view=full`/`:id`; recall exposes nothing new. There
  is no dismiss fig-leaf pretending otherwise (R9). A durable redaction/delete is a
  broader concern than this RFC.
- **Filter finds nothing.** The filter searches the fetched top-N; its label says
  so. Server-side search over the whole store is a noted deferral (F8).

## Alternatives considered

### Alt 1 — Client-side localStorage MRU (`RecentPrompts`, mirroring `RecentPaths`)

A ~49-line MRU class recording each manual submit to localStorage. Self-contained,
no server, no endpoint.

**Rejected as v1 primary** — it fails the actual ask ("recover prompts *already
sent*"): it starts **empty** and only accretes future launches from *this* browser;
the user's existing history stays invisible until each prompt is re-sent once
(the very retyping the feature removes). It is per-profile and duplicates
authoritative server state. Kept as the explicit fallback if the route proves
undesirable, not a dead end. (Confirmed by design-minimalist: `userPrompt`/
`provenance` are real persisted fields; localStorage genuinely starts empty.)

**Sharpened by the consensus attack:** the server's day-one advantage over Alt 1 is
the **populated live store** (deep on a typical instance), *not* a pre-filled
archive — the archive backfills forward from #2765 (see Retention horizon). The
rejection therefore holds on any instance whose live store still carries the user's
history (the common case); on an instance that aggressively pruned before #2765,
neither Alt 1 nor this design can recover the lost pre-#2765 terminal prompts, so
the server design is never *worse* than Alt 1 and is strictly better wherever
history is retained (and adds cross-browser reach). This is why v1 stays
server-backed rather than reverting to Alt 1.

### Alt 2 — Reuse `GET /api/tasks?view=full` and dedup client-side

Rejected: `view=full` ships ~8.7 MB for ~213 tasks — the exact reason the compact
projection exists. A dedicated projection returns kilobytes of distinct capped
strings and puts dedup/rank in one tested place.

### Alt 3 — Push recent prompts in the snapshot / a WS message

Rejected (NG4): recall is needed on demand, by one user, when the panel opens.
Pushing prompt bodies re-fattens the payload the compact projection slimmed.

### Alt 4 — Key recall entries on prompt+cwd (one per repo)

Rejected: multiplies entries for the same wording across repos, defeating the cap.
Dedup-on-text + `cwdMatch`-over-all-occurrences (R5) gives the "repeat on this
repo" outcome with a smaller list.

### Alt 5 — Extend the single draft into an N-slot ring

Rejected: the draft's submit-reconciliation semantics (`submittedAt`,
clear-on-confirm) are a different lifecycle from "prompts I reuse".

### Alt 6 — Just add a search box to the task list feeding existing Relaunch

Raised by the socratic critic: Relaunch already prefills prompt+cwd+criteria+agent
from any past task, so the gap may be *discoverability*, and a task-list filter is
cheaper. Considered and **not chosen** because (a) the user's ask is recall *at the
point of composing a launch*, in the dialog, not a detour to the task list and
back; (b) Relaunch is anchored to a *task* and its lineage — recall is anchored to
*prompt text* the user wants to fire fresh; (c) after 1-day live pruning, most
recall targets are archived and never in the task list at all. The two coexist:
Relaunch resumes a specific task; recall re-fires a phrasing. A telemetry read on
`launch_prompt_recall_used` vs Relaunch usage will show whether recall earns its
place.

## Open questions (closed for v1)

- **Union the archive?** **Yes, in v1** (moved up from the v1-draft's deferral —
  round-1 crux). Without it, "already sent" means "sent in the last day".
- **Recall on `QuickLaunch` too?** Deferred, now named explicitly. The
  hook/projection are surface-agnostic; a compact picker in `QuickLaunch.tsx` is a
  cheap follow-on once the primary surface ships and telemetry justifies it.
- **Narrow to dashboard-only launches?** No. `provenance.kind === 'manual'` keeps
  UI/CLI/API/WS. Note (round-1 F7): dashboard launches are stamped
  `sourceId: 'websocket'` (the WS `launch` path), **not** `'ui'` — `'ui'` is only
  the HTTP `X-Kookr-Launch-Source: ui` header path. So any future narrowing must
  target `{'websocket', 'ui', 'cli'}`, not `'ui'` alone (which would exclude the
  dashboard).
- **Include pre-#1583 `unknown` tasks?** No — would surface autonomous/scheduled
  prompts as hand-typed. Horizon documented instead.
- **Server-side substring search (`q` param)?** Deferred; v1 filters the fetched
  top-N with an honest label.
- **Also set cwd on select?** No by default (G4). An opt-in click on the "in
  *repo*" tag is a possible refinement.

## Implementation plan (after approval)

1. `src/shared/contracts/recent-prompts.ts` (type + guard) and
   `src/core/recent-manual-prompts.ts` (pure projection) + tests.
2. `GET /api/tasks/recent-prompts` route (before `:id`; live ∪ archive; memoized
   canonicalizer) + route test incl. no-shadow assertion.
3. `getRecentPrompts` client fn + `useRecentPrompts` hook.
4. `RecentPromptsPicker` component + tests.
5. Wire into `LaunchTaskDialog` (mount hook+picker, fill-on-select) + dialog test;
   telemetry event; docs.

Single PR — cohesive, behind an additive affordance invisible until the user has
manual-launch history (which, server-backed, they very likely already do).

## Critic feedback incorporated

### Shared evidence pack

A pipeline map (LaunchTaskDialog/recent-paths/task-routes/tasks/task-provenance/
relaunch-from-agent/telemetry) plus the ~8.7 MB-for-213-tasks measurement and
source pointers were assembled once and pasted into all five critic prompts.

### Round 1 (2026-09-04) — panel: boundary-critic, failure-mode-analyst, design-minimalist, ambition-amplifier, socratic-challenger (5, at the cap)

**Incorporated:**
- **Archive union into v1** (ambition-crux, socratic #3, failure-mode F6). Live-store
  retention is 1 day; the feature's promise needs the 90-day archive.
  `readArchivedTasks` already returns normalized `Task[]`.
- **Fetch-once-on-panel-open; drop the debounced cwd-refetch** (design-minimalist,
  boundary, failure-mode F2/F5/F9). The cited "playbooks refetch on cwd change"
  precedent does not exist; the invented debounce machine caused the clone-storm
  (F5) and panel-remount (F9) failure modes.
- **Non-cloning `viewTasks()` read** (failure-mode F5) — `listTasks()` deep-clones
  every task and is a documented event-loop hazard.
- **Rank-by-ever-matched-cwd before dedup, with canonicalization** (failure-mode
  F3/F4) — dedup-most-recent-wins would have homed a cross-repo prompt at the wrong
  cwd and evicted it; raw string cwd compare would silently miss `~`/trailing-slash/
  symlink variants. Inject memoized `canonicalizeCwd`.
- **`displayPromptForTask` for the text** (failure-mode F10) — strips injected
  guidance, converges legacy `prompt` with new `userPrompt`.
- **Drop per-entry dismiss; keep substring filter** (design-minimalist) — a session
  hide gives no confidentiality (same body one click away).
- **Drop `agentType`/`taskId` from the entry** (failure-mode F11, design-minimalist
  YAGNI) — recall fills only the prompt; a shown agent implies unfulfilled fidelity.
- **Route registered before `:id` + no-shadow test** (boundary).
- **Corrected rationales** (boundary): core placement is justified by
  `layer-boundary.test.ts` + `task-provenance.ts`, not "mirrors the compact-list
  handler" (`toCompactApiTask` lives in `task-routes.ts`, server layer). Exposure
  precedent is `view=full`, not `:id`.
- **Explicit hook/component ownership** (boundary): hook owns fetch `{entries,
  loading}`; component owns filter text; no split ambiguity.
- **Stated retention + provenance horizons** honestly (F1/F6); reworded the "ever
  sent" success criterion to "within ~90-day archive retention".
- **Param-edge spec** (F12): default 20, clamp [1,50], empty cwd → absent.
- **Fixed the `sourceId: 'ui'` open-question error** (F7): dashboard launches are
  `'websocket'`.

**Rejected (with reason):**
- **Include `unknown`-provenance tasks with heuristics** (failure-mode F1
  suggestion) — would surface autonomous/scheduled prompts as hand-typed. Documented
  horizon instead.
- **Durable per-entry dismiss** (ambition) — dismiss is cut entirely; its
  confidentiality rationale does not hold.
- **Recall in `QuickLaunch` in v1** (ambition) — deferred but now named as a
  scoping decision.
- **Task-list-search-instead-of-picker** (socratic Alt 6) — kept as Alt 6 with the
  reason recall is a launch-time, prompt-anchored surface distinct from Relaunch.

**Adversarial pair — ambition-amplifier vs design-minimalist:** on the **archive
union** I sided with *ambition* — it is load-bearing for the feature's own promise
and cheap via the existing `readArchivedTasks` + archive-agnostic pure projection,
so it is not gold-plating. On **per-entry dismiss** I sided with *design-minimalist*
— cut it; the confidentiality rationale is a fig leaf. On the **cwd server param** I
took the middle both verified: kept the param (failure-mode F3/F4 prove client-only
ranking is incorrect without server canonicalization) but dropped the *per-keystroke
refetch* design-minimalist rightly objected to (fetch once on panel open).

**Empirical checkpoint (mandatory, post-round-1):** the load-bearing claim "live
store prunes after ~1 day; archive keeps 90" was verified directly against source
— `DEFAULT_TASK_RECORD_MAX_AGE_DAYS = 1` (`prune-aged-task-records.ts`) wired at
`index.ts` with archive-before-prune (#2765), and `DEFAULT_TASK_ARCHIVE_RETENTION_DAYS
= 90` (`task-archive.ts`). This confirmed the ambition-crux and drove the
archive-union-in-v1 decision. `viewTasks()` (non-cloning) and `canonicalizeCwd`
(realpathSync) were likewise verified to exist as used.

**Invocation log:** ambition-amplifier 2026-09-04: novel finding (archive union is
load-bearing, not deferrable — the crux of v2).

**Intent-preservation check:** the original ask — "repeat a prompt on a specific
repository without writing a playbook; recover prompts already sent via manual
launch" — has two load-bearing motivations: (1) *already sent* (backfill) and (2)
*specific repository*. v2 honors both: the live-store∪archive union delivers
backfill; cwd-first ranking (fixed to "ever matched") delivers the repository bias.
No rejected alternative was silently adopted.

### Consensus attack (2026-09-04)

`general-purpose 2026-09-04: consensus-attack — finding.` The panel verified the
archive's 90-day *retention ceiling* but every critic inherited the framed claim
"the server already holds the history" and none questioned the archive's *population*
at ship time. Verified: `task-archive.ts` was added in #2765 (2026-09-02) and
archives **forward-only on prune with no backfill**, so at launch the archive holds
only the days since its deploy, not 90 days. **Triaged: incorporated (framing
correction, one revision).** The design is unchanged — live∪archive was already the
right mechanism — but the RFC's claims were corrected: (a) the day-one backfill
comes from the **live store** (deep on a typical instance), not the archive; (b) the
archive's depth **matures** from #2765's deploy toward 90 days; (c) the honest
guarantee is "history the server still retains", with the explicit gap that an
instance which aggressively pruned before #2765 cannot recover those lost prompts
(where a client MRU would fare no better). The Alt-1 rejection survives on the
corrected basis (populated live store), so no design pivot follows. No further round
(consensus-attack bound: one call, one revision).

### Convergence

Converged after round 1 (all findings incorporated with no unresolved conflicts;
the one contested point — archive union — was settled by the verified prune
horizon). Round 2 skipped as diminishing returns on a small, tightened design; the
mandatory empirical checkpoint and the one-time consensus attack both ran.

### Pre-PR specialist review (2026-09-04) — correctness, lint-like, test, a11y

Run on the implementation diff before opening the PR. No blocking correctness,
convention, deadcode, or test findings. Incorporated:
- **a11y (3 blocking, one fix):** the recall list used `role="listbox"`/`"option"`/
  `aria-selected` without any listbox keyboard model (no arrow-key nav, no
  `aria-activedescendant`) — a false promise, since selecting a row merely fills
  the field. Demoted to a plain `<ul>`/`<li>` wrapping the native buttons; added
  `aria-controls` on the toggle. (The affordance is a list of buttons, like the
  sample-prompt chips, not a select widget.)
- **correctness:** the first implementation wired the live `cwd` field into the
  hook's effect deps, so every cwd keystroke refetched (each doing an archive
  read) — contradicting the fetch-once intent. Fixed: the hook reads cwd from a ref
  and depends only on `enabled`, so it fetches once and never per keystroke. Also
  trimmed the server-side `cwd` query param before canonicalization.
- **lint-like/deadcode:** dropped the unused `loading` from the hook (returns the
  entries array directly, matching `useLaunchTaskCwds`); threaded the promised
  `cwdMatch`/`rank` dimensions into the `launch_prompt_recall_used` event; added the
  `R4b.13` requirements row.
- **test:** added the missing client-layer coverage (`parseRecentPromptsResponse`
  unit test; `getRecentPrompts` fail-closed tests) and strengthened the
  archive-union assertion and the cwd-tag suppression case.
