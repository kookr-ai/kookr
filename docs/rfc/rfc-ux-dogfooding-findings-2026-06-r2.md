# RFC: UX Dogfooding Findings — June 2026, Round 2

- **Status**: Draft (living document, updated during dogfooding session)
- **Author**: Claude (dogfooding session driven as a "classical user")
- **Date**: 2026-06-11
- **Method**: Second round of the UX dogfooding loop (prior art:
  `rfc-ux-dogfooding-findings-2026-06.md`, 21 findings). Drive the dashboard
  at `localhost:4800` through normal user workflows — script against the API,
  launch real tasks in the private projects via the Launch dialog, watch the
  live terminal, reply to a signaled-complete task, complete with a rating,
  and exercise at least one deliberate bad input. Every friction point, bug,
  data inconsistency, or wording problem is recorded as a finding with
  severity, evidence, and a suggested fix. Medium/high findings get a code
  root-cause (`file:line`) where possible.

## Summary

Round 2 confirms the r1 loop worked: 9 of the 10 r1 findings this session
could re-test are fixed and verified in production (launch error UX with
draft preservation, overview landing state, humanized durations, tooltip
coverage, single-task GET, id/taskId, message duplication/mojibake). The new
crop is smaller and shifts from "broken affordances" to **trust in derived
numbers**: the headline finding (F8, high) is that every "waiting Xm" age in
the triage surfaces is computed from the anomaly detector's re-armable
`detectedAt`, so a server restart silently resets days-old waits to minutes —
the queue's ordering cue, age badge, and escalation color all lie. The rest:
API fields whose names promise more than they deliver (F1 `tracked`,
F2 `openPrs`), residual list pollution (F3), silent truncations (F4 signal
notes), missing audit trail for bulk deletes (F9), and small wording/toast
nits (F6, F7), plus a test-hygiene leak (F5).

## Findings

### F1. `tracked` is `true` or `null`, never `false` (DX/data trust) — severity: medium

`GET /api/projects` returns `"tracked": true` for exactly one project
(knowledge-base-mcp-server) and `"tracked": null` for all 27 others —
including `github.com/kookr-ai/kookr` itself, which has 2 active agents and a
localPath. A scripter cannot distinguish "explicitly untracked" from "never
configured", and `null` (rather than `false` or field absence) suggests a
serialization accident rather than a tri-state design.

Root cause: `src/core/project-summary.ts:326` —
`tracked: config?.tracked === true ? true : undefined` collapses
false/undefined into `undefined`, which the JSON layer emits as `null`.

**Suggested fix**: emit a real boolean (`tracked: config?.tracked === true`),
or document the tri-state and emit `false` when a config exists with
`tracked: false`.

### F2. Three near-identical "open PRs" fields with different meanings (data trust) — severity: medium

One project object carries `openPrs: 0`, `repoHealth.openPullRequests: 2`,
and `openPrsTiedToActiveTasks: 0` side by side (evidence:
knowledge-base-mcp-server, 2026-06-11). `openPrs` actually counts **OSS
contribution attempts in state `pr_open`** (`src/core/project-summary.ts:278`)
— a completely different denominator from the repo's real open-PR count in
`repoHealth`. Anyone scripting (or any LLM agent reading the API) will treat
`openPrs` as "open PRs in this repo" and get 0 for a repo with 2.

**Suggested fix**: rename `openPrs` → `openContributionAttempts` (or nest it
under an `ossAttempts` object), and add a one-line doc comment per count
field in the contract.

### F3. Project list dominated by foreign OSS repos; `local/tmp` residue persists (list hygiene) — severity: medium

`GET /api/projects` returns 28 projects of which 19 are third-party repos
(microsoft/vscode, rust-lang/rust, kubernetes/kubernetes, tensorflow…) seeded
by the scanner/idea-scout, plus `local/tmp` (localPath `/tmp`) — the same
test-artifact residue reported as F3 in the June r1 RFC, still present.
There is no query parameter to filter to tracked/own projects; a scripter
must hand-roll `localPath != null` heuristics. The endpoint also serves
repoHealth for all 19 foreign repos (16k+ issues for vscode), implying the
scanner polls GitHub for repos the user has no tasks in.

**Suggested fix**: add `?tracked=true` / `?mine=true` filtering to
`/api/projects` (`src/server/routes/project-routes.ts:9`), and an
auto-expiry for `local/*` projects whose `localPath` no longer warrants
tracking (r1-F3's suggested fixes still apply).

### F4. Completion-signal notes silently truncated at 280 chars mid-word (UX bug) — severity: medium

Task `a1c496c4` ("Improve Supervision Workflow Efficiency and Autonomy")
signaled completion-ready with a note that ends, verbatim:
"…converged at v4 in worktree /home/jean/git/kookr-rfc-supervision-v2 (branch
rfc/supervision-v2, uncommitted per workflow). Awaiting operator review
before" — exactly 280 characters. The agent's actual ask (review before
*what*?) is lost. The note is the primary human-handoff artifact; silently
chopping it defeats its purpose.

Root cause: `src/server/routes/task-routes.ts:333` —
`body.note.slice(0, MAX_AGENT_SIGNAL_NOTE_LENGTH)` (cap defined at
`src/shared/contracts/agent-signal.ts:26`), no ellipsis, no warning returned
to the signaling agent.

**Suggested fix**: either raise the cap (notes are stored JSON, not tweets),
or truncate at a word boundary with a visible `…` AND return
`{ truncated: true }` in the signal response so the agent can shorten and
re-signal.

### F5. Unit tests leak temp directories into `/tmp` (hygiene) — severity: low

163 directories matching `/tmp/kookr-disable-terminal-state-*` exist on the
dev machine (oldest 2026-06-09, newest today 12:18), each holding a
`session-sharing-recovery-audit.jsonl`. Source:
`src/server/routes/session-sharing-recovery-routes.test.ts` calls `mkdtemp`
11 times (e.g. line 155–156) with **no** `afterEach`/`afterAll` cleanup in
the file. Every vitest run (including `dev:watch` re-runs) leaks more. Other
test files may share the pattern — worth a sweep for `mkdtemp` without
matching `rm`.

**Suggested fix**: collect created dirs in an array and `rm -rf` them in
`afterEach`, or use a fixture helper that auto-cleans.

### F6. Launch dialog: "Use parent of server cwd" mislabels what it does (wording) — severity: low

When the server runs in a protected worktree (`~/git/kookr-prod`), the cwd
helper link reads `↩ Use parent of server cwd (/home/jean/git/kookr)`. The
filesystem parent of the server cwd is `/home/jean/git`; what the link
actually inserts is the **parent repo** derived by stripping the protected
suffix (`LaunchTaskDialog.tsx:292` → `deriveParentRepoFromProtected`). The
tooltip (line 421) says "parent repo" correctly — the visible label says
"parent of server cwd", which is a different path.

**Suggested fix**: label it `↩ Use main checkout (/home/jean/git/kookr)`.

### F7. Failed launch shows "Starting task:" toast first (UX) — severity: low

Launching with a nonexistent cwd shows an optimistic info toast
("Starting task: Dogfood unhappy-path probe…") immediately followed by the
error toast ("Error starting … Working directory does not exist …"). Two
contradictory toasts seconds apart; the info one is a lie. The optimistic
toast is emitted in `LaunchTaskDialog.tsx:253` before any server response.

**Suggested fix**: phrase the optimistic toast as in-progress
("Launching task…") or suppress/replace it when the launch error for the
same prompt arrives.

### F8. "waiting Xm" ages reset to minutes after detector re-arm; days-old waits show as fresh (data trust / triage) — severity: high

The WAITING ON YOU queue and the findings-rail age badges both showed
"waiting 9m–11m" for tasks whose `pendingSignal.raisedAt` timestamps were
**15 hours to 4 days old**:

| task | signal raisedAt (API) | UI at 18:57Z |
|---|---|---|
| 1479eacf | 2026-06-07T22:47Z (~4 days) | waiting 9m |
| a1c496c4 | 2026-06-10T18:28Z (~24 h) | waiting 10m |
| bff4f91b | 2026-06-11T03:37Z (~15 h) | waiting 10m |

Cause: the UI derives "waiting" from `anomaly.detectedAt`
(`src/frontend/components/OverviewEmptyState.tsx:79`,
`src/frontend/components/FindingsPanel.tsx:563-565`, also `DndPill.tsx:24`
and the urgency color via `ageColor`). All `needs_input` anomalies in the
snapshot carried `detectedAt` clustered in 2026-06-11T18:48:0x–18:49:0x —
the detectors re-stamped on a server restart/re-arm, so every wait age
collapsed to "minutes". (Restart confirmed: the process listening on :4800
started 2026-06-11 18:47 UTC — one minute before the `detectedAt` cluster.) The triage queue's ordering cue, the age badge, and
the escalation color all lie after every restart: the user cannot tell a
4-day-old handoff from a fresh one. The truthful timestamp
(`pendingSignal.raisedAt`, or last agent activity for `needs_input`) is
already in the API and ignored.

**Suggested fix**: for signaled tasks, compute the wait from
`pendingSignal.raisedAt`; for `needs_input`, from the last activity event
timestamp. Alternatively persist anomaly first-detection times across
restarts keyed by (task, anomaly type) so `detectedAt` survives re-arms.

### F9. Bulk destructive "clear completed" leaves no audit trail (operability) — severity: medium

During the session, 25 completed tasks disappeared between two API fetches
(26 completed → 1; 43 tasks → 19). Cause was two `clearCompleted` WebSocket
commands (21:06 and 21:13 local — `tasks.json.predelete.*` snapshots exist
for both, almost certainly the operator clearing from another browser tab).
The product behaved correctly — but **nothing records who/what/scope**:
`~/.kookr/server.log` has zero mentions of the clears, and
`~/.kookr/audit.jsonl` only carries relay lease heartbeats. An operator
asking "where did my 25 tasks go?" has no answer short of diffing
`tasks.json.predelete.*` files by hand. The handler
(`src/server/use-cases/task-lifecycle-commands.ts:178-187`) returns
`deletedTaskIds` but logs nothing.

**Suggested fix**: append a structured line to the audit log on every
`clearCompleted` / `deleteTask` (actor connection, project scope, count,
deleted ids), and surface "Cleared N tasks" in the activity feed.

## Things that worked well (keep)

- **r1-F4 fixed**: `/api/tasks` now returns both `id` and `taskId` on every
  task, always equal (verified across all 40 tasks).
- **r1-F5 fixed**: `GET /api/tasks/:id` exists and returns the full task.
- **Cross-source agent counts agree**: per-project `activeAgents` in
  `/api/projects` (6+4+1+2+1) sums exactly to the 14 `inProgress` tasks in
  `/api/tasks` — the kind of consistency r1 found broken elsewhere.
- **`pendingSignal` is rich and useful**: kind + note + timestamps make the
  waiting-on-you queue scriptable in one `jq` line.
- **r1-F8 fixed**: the landing view is now a real overview — running /
  needs-input / completed tiles, a "WAITING ON YOU" queue, a Launch button,
  and a keyboard-shortcut cheat sheet. Counts tie out exactly against
  `/api/tasks` (43 = 17 inProgress + 26 completed at observation time).
- **r1-F7 fixed**: stale-agent warnings now read "No activity for 10 min",
  not raw seconds.
- **r1-F12 fixed and verified end-to-end**: launching into a nonexistent cwd
  yields an explicit error toast naming the bad path, with recovery advice —
  and the typed prompt IS restored as a draft when the dialog reopens
  (verified in a single browser context; an earlier failed probe was this
  session's automation bug, not the product). No ghost task is created.
- **r1-F13 substantially fixed**: cwd defaults now prefer MRU + tracked
  project checkouts; the server's own runtime checkout is the last resort,
  and protected worktrees (`kookr-prod`) are redirected to the parent repo
  (modulo the F6 label nit).
- **Launch feedback**: a "Starting task: <excerpt>" toast confirms the
  submission, and the task auto-names itself sensibly ("README vs code
  consistency audit for MCP server").
- **Permissions banner**: "PERMISSIONS BYPASSED — New agent launches are
  running without permission prompts" is impossible to miss.
- **"Not a real issue" / "Missed a real issue"** finding buttons replaced
  r1-F9's "Flag FP" jargon with plain language.
- **Completion-signal banner** on the task detail is excellent: agent's note
  verbatim, "ready for review — complete this task?" framing, and the
  composer placeholder adapts ("Signaled complete — review or send a
  follow-up…") with Send / Send & Next / Skip / Snooze affordances.
- **Search (Ctrl+K) → task navigation** works smoothly; typing a partial
  task name and Enter lands on the task detail.
- **Playbooks tab** shows source chips (plugin/user), param counts, a
  "Running in:" header with Change…, and playbook-pinned cwd is explicitly
  flagged ("ⓘ overridden by playbook") — the cwd-resolution ambiguity is
  handled (`PlaybookBrowser.tsx:200-233`, dedicated resolved-cwd tests).
- **`tasks.json.predelete.*` snapshots** before every bulk delete — the
  25-task clear during this session was fully recoverable evidence.
- **r1-F15/F16 fixed on the reply path**: follow-up message appeared exactly
  once in the activity feed, non-ASCII (em-dash) intact.
- **API input validation**: `POST /api/tasks` returns structured 400s with a
  machine-readable `code` (`invalid_cwd`) and the offending path in the
  message.
- **Complete-with-rating flow** is clean end-to-end: header Complete button
  (`data-testid="action-complete"`) → confirm dialog with optional 👍/👎
  ("skip to complete without rating"), Enter/Esc hints — and the rating
  persists (`completionFeedback: {"rating":"up"}` via `GET /api/tasks/:id`)
  alongside a `completionDigest` (files changed, branch, verification
  commands).
- **The whole supervised loop worked**: launch via dialog → watch live
  terminal → completion signal with note → follow-up reply → agent honored
  it and re-signaled with an updated note → complete with rating. Zero
  dropped messages, zero stuck states. The product's core promise held up
  under real use.

## Suggested priority order

Grouped into shippable clusters:

1. **Cluster A — truthful waiting ages (F8)** — high, single coherent change:
   derive wait ages from `pendingSignal.raisedAt` / last-activity instead of
   `anomaly.detectedAt` in `OverviewEmptyState.tsx`, `FindingsPanel.tsx`,
   `DndPill.tsx` + `ageColor`; or persist first-detection times across
   restarts. Regression test: anomaly re-arm must not reset displayed age.
2. **Cluster B — API contract honesty (F1, F2, F4)** — one PR touching
   `project-summary.ts` (real boolean `tracked`, rename/namespace `openPrs`)
   and `task-routes.ts` (word-boundary truncation + `truncated: true` in the
   signal response, or raise the 280 cap).
3. **Cluster C — operability (F9 + F3)** — audit-log entries for
   `clearCompleted`/`deleteTask`; `?tracked=true` filter on `/api/projects`
   and auto-expiry of dead `local/*` projects.
4. **Cluster D — polish (F5, F6, F7)** — temp-dir cleanup in the recovery
   route tests, cwd-helper label, optimistic-toast wording. Low risk,
   batchable.

## Session log

- 2026-06-11 — Session start. Dashboard confirmed live at `localhost:4800`;
  RFC worktree `kookr-dogfood-202606-r2` created from `origin/main` (782e0f1d).
- 2026-06-11 — API pass: `/api/projects`, `/api/tasks`, `/api/snapshot`
  cross-checked → F1–F4; `/tmp` listing surfaced F5. Verified r1-F4/F5 fixed.
- 2026-06-11 — UI happy path: landing overview (r1-F8 fixed, counts tie out),
  launch dialog inspected (F6), real read-only audit task launched into
  knowledge-base-mcp-server via dialog (task `c74cb3f1`, claude-code,
  auto-named). Live terminal streams with per-step token counts.
- 2026-06-11 — UI unhappy path: nonexistent cwd → explicit error toast with
  recovery advice; prompt draft restored on reopen (r1-F12 verified fixed);
  no ghost task. Residual nit: optimistic "Starting task" toast precedes the
  failure (F7). API probes: structured 400s with `code` field (keep).
- 2026-06-11 — Tooltip sweep: r1-F9's cryptic badges (spend, `1c 0/0/1`,
  Nudge, FOLLOW/DND, 5h/7d quota pills) all have explanatory tooltips now.
- 2026-06-11 — Signal-age cross-check: WAITING ON YOU ages contradict
  `pendingSignal.raisedAt` by up to 4 days → F8 (high), root cause confirmed
  (server restart 18:47 UTC re-stamped all anomaly `detectedAt`).
- 2026-06-11 — Audit task signaled completion-ready (8 real discrepancies in
  kb-mcp-server docs). Mid-session, 25 completed tasks vanished — traced to
  two operator `clearCompleted` commands (predelete snapshots verified) → F9
  (no audit trail). Replied to the signaled task via the adaptive composer;
  message delivered once, em-dash intact (r1-F15/F16 fixed on this path).
- 2026-06-11 — Agent honored the follow-up (executive summary prepended to
  the report) and re-signaled. Completed the task via the confirm dialog
  with a 👍 rating; verified `completionFeedback` and `completionDigest`
  persisted via the API. Two suspected regressions this session turned out
  to be probe artifacts (fresh-context localStorage loss; monitor start-time
  cutoff) — automation lessons folded back into the playbook.
- 2026-06-11 — Session end. 9 findings (1 high, 5 medium, 3 low), all
  medium/high root-caused to `file:line`; 20 keep-list entries; deliverable
  audit report at `/tmp/kb-readme-audit-2026-06-11.md` (8 real doc
  discrepancies in knowledge-base-mcp-server).
