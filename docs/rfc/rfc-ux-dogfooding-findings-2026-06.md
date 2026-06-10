# RFC: UX Dogfooding Findings — June 2026

- **Status**: Draft (living document, updated during dogfooding session)
- **Author**: Claude (dogfooding session driven as a "classical user")
- **Date**: 2026-06-10
- **Method**: Drive the dashboard at `localhost:4800` through normal user workflows
  (launching manual tasks in kookr / knowledge-base-mcp-server / reason-at-home,
  watching them run, reading panels), and record every friction point, bug,
  data inconsistency, or wording problem as it is encountered.

## Summary

Running Kookr as a regular user surfaces friction in three buckets:
**data trust** (numbers that contradict each other), **list hygiene**
(test artifacts polluting first-class UI surfaces), and **affordance
clarity** (what a control does is not obvious before clicking it).
Each finding below has a severity, evidence, and a suggested fix.

## Findings

### F1. Tied-issue count exceeds open-issue count (data trust) — severity: medium

`GET /api/projects` for `jeanibarz/reason-at-home` returns
`repoHealth.openIssues: 25` but `openIssuesTiedToActiveTasks: 40`
(and `openPrsTiedToActiveTasks: 32` with `openPullRequests: 0`).
A user reading the project card sees "40 of 25 issues tied to active
tasks", which destroys trust in both numbers.

Likely cause: `activeTaskGithubLinks` counts links extracted from task
transcripts (including closed/merged/foreign-repo references), while
`repoHealth` counts currently-open items from the GitHub API. The two
denominators are different but presented side by side.

**Suggested fix**: intersect extracted links with the set of currently
open issues/PRs before counting, or rename the field/label so it reads
as "issue references in active tasks" rather than a subset of open issues.

### F2. Link extraction over-attributes (data trust) — severity: medium

One task ("Improve Supervision Workflow Efficiency and Autonomy") is
linked to 12+ issues and to **PR #1** of the repo. PR #1 in a repo with
600+ PRs is almost certainly a false positive from parsing a bare `#1`
in prose. This single noisy task accounts for most of the F1 anomaly.

**Suggested fix**: require contextual cues for low-numbered bare refs
(e.g. only count `#N` when adjacent to words like "PR", "issue",
"fixes", "closes"), or verify extracted numbers against the GitHub API
before persisting them as task↔GitHub edges.

### F3. Test artifacts registered as projects (list hygiene) — severity: medium

The project list contains `local/tmp`, `local/kookr-subagent-author-e2e`,
and three `local/test_launch_*` entries pointing at
`/tmp/pytest-of-jean/pytest-576/...`. These are residue from automated
tests that launched tasks with a `/tmp` cwd, and they now occupy
first-class rows in the projects API (and presumably the sidebar)
indefinitely — the paths don't even exist anymore.

**Suggested fixes** (any of):
- Auto-untrack `local/*` projects whose `localPath` no longer exists.
- Tag projects created by test runs (env var / header) and exclude them
  from the default listing.
- Surface an "archive project" affordance in the UI; `POST
  /api/projects/untrack` exists but nothing in the card UI appears to
  expose it prominently for dead local projects.

### F4. API field naming inconsistency: `id` vs `taskId` (DX) — severity: low

`GET /api/tasks` returns task objects keyed `id`, while
`GET /api/projects` embeds `recentTasks[].taskId` and
`/api/snapshot` agents carry `taskId`. Anyone scripting against the
API (or an LLM agent driving it) trips on this. Pick one name.

### F5. No `GET /api/tasks/:id` (DX) — severity: medium

You can `DELETE /api/tasks/:id` and `POST /api/tasks/:id/complete`,
but reading a single task 404s — the only way to poll one task's
status is to fetch the entire task list and filter client-side.
For a tool whose users script task launches (and whose own agents
self-monitor), a single-task GET is table stakes.

### F6. Agent type is silently round-robined at launch (UX) — severity: medium

Launching a manual task without `agentType` assigned it to
`codex-cli` with no prior indication. As a user I expected my
default agent (claude-code) or at least to be told before launch.
The response *does* report the resolved type, but the choice is a
surprise after the fact. The UI launch modal *does* have an Agent
select (Claude Code / Codex CLI / Round robin) — but its default was
**Codex CLI**, not "Round robin" or the user's primary agent, and
nothing explains the default. Suggested: default to the last-used
choice with the resolved agent always previewed ("Round robin →
next: codex-cli"), and have the API default mirror the UI default.

### F7. Stale-agent warnings show raw seconds (UI wording) — severity: low

Finding cards read "No activity for 2365s — agent may be stuck or
disconnected". 2365s is a computer's number; "39 min" is a human's.
Everywhere else the UI already formats durations ("24h 35m", "18m"),
so this one string is inconsistent with the product's own style.

### F8. Dashboard main area is empty until first click (UI) — severity: medium

On load, the right ~70% of the viewport is a black void; all content
lives in the left rail. First-run users stare at emptiness. An
overview default (aggregate activity, cost over time, waiting-on-you
queue, or even the keyboard-shortcut cheat sheet) would make the
landing state informative instead of blank.

### F9. Cryptic micro-badges and jargon (UI wording) — severity: medium

Collected from one screen:
- `1c 1/0/0` badge on a task card — no tooltip-discoverable meaning
  at a glance (children counts? pass/fail?).
- `Nudge ⏱ 40` with an `×` — is 40 a countdown? attempts? seconds?
- `Flag FP` / `Flag missed` — supervisor-internal jargon (false
  positive) surfaced as a primary button label.
- Bottom status bar `5h: 31% (1h 56m) · 7d: 8%` — presumably Claude
  rate-limit windows, but unlabeled.
- Header `$17072.37` — cumulative spend with no period or scope label
  (all-time? this machine? this month?). A number this large with no
  context reads as either alarming or broken.

### F10. Sidebar project chips are ambiguous (UI) — severity: low

The project rail shows ~20 two-letter chips with duplicate initials
(two `JC`, two `KK`, two `MM`). Without hovering each one there is no
way to tell projects apart, and dead test projects (F3) occupy chips
too. Consider initials+color uniqueness, a compact-name mode, or
hiding inactive projects by default.

### F11. Onboarding tour can be confused with action buttons (a11y/testing) — severity: low

While automating "click Skip", the first `Skip` text on the page is a
finding-card action *behind* the modal overlay, not the tour's own
Skip. Tab order / accessible naming should distinguish "Skip tour"
from "Skip finding" (`aria-label="Skip tour"` on the onboarding
button would do it; it also makes E2E selectors unambiguous).

### F12. Launch failure UX: optimistic close + buried root cause (UX bug) — severity: high

Reproduced twice via the Launch modal with a nonexistent working
directory (`/home/jean/git/does-not-exist-xyz`):

1. **No validation**: neither the form nor the server rejects a
   nonexistent `cwd` upfront, even though the server could `stat` it
   in microseconds. Instead Kookr spawns a tmux/dtach session and
   fails on a timeout.
2. **Modal closes optimistically on submit**, so when the launch then
   fails, the user's entire typed task description is gone — there is
   no "restore draft" path. Retyping a long prompt is rage-inducing.
3. **Error message leads with infrastructure jargon**: "dtach socket
   did not appear for session kookr-d2dcfb0c", followed by generic
   recovery advice whose first bullet is "Run `pnpm run doctor`".
   The actual cause ("Verify the working directory exists") is the
   *third* bullet. A user who typo'd a path is told to debug dtach.

**Suggested fixes**: (a) validate `cwd` existence at submit (client
hits a cheap `GET /api/files/meta?path=` or the launch endpoint
checks before spawning) and keep the modal open with an inline field
error; (b) on any launch failure, re-open/restore the modal with the
draft intact (or persist the draft in localStorage); (c) when the
session-spawn failure coincides with a missing cwd, say that first.

### F13. Working directory input: free-text with risky default (UX) — severity: high

The Launch modal's "Working directory" is a bare text input that
defaults to **the server's own runtime checkout**
(`/home/jean/git/kookr-prod`). Two problems:

- A user who only fills the description launches an agent *into the
  production runtime working copy* — the exact place Kookr's own
  task preamble forbids edits. The default should be the last-used
  project or an explicit choice, never the supervisor's runtime dir.
- The server already knows every tracked project's `localPath`
  (`GET /api/projects`), yet the user must remember and type absolute
  paths. A combobox of tracked projects (+ recent dirs + free-text
  escape hatch) would remove both the typing friction and the typo
  class of failures in F12.

### F14. "MISSING UNEXPECTEDLY" badge: alarming, unexplained, and apparently wrong (UX) — severity: high

After my README task signaled complete, its header showed a red
`MISSING UNEXPECTEDLY` badge next to `SIGNALED COMPLETE`. The same
badge appeared on another healthy-looking task. No tooltip, no
explanation, no suggested action. Worse: the session clearly was
*not* gone — I sent a follow-up message and the codex agent received
it and resumed work. So the badge (a) cried wolf, (b) used internal
vocabulary ("missing" from whose perspective?), and (c) co-existed
with a functioning session.

Root cause (code): the badge means "**worktree** missing
unexpectedly" (`src/frontend/presentation.ts:37` truncates the label
to "missing unexpectedly"), set by `src/server/reconciliation.ts:107`
whenever a tracked session's cwd has no entry in the worktree
registry after a refresh — *without verifying the directory is
actually gone from disk*. A registry refresh hiccup (or the recent
orphaned-worktree sweep) flags healthy sessions. Fixes: include the
word "worktree" in the badge, add a tooltip with the recovery story,
and `stat()` the path before declaring it missing.

### F15. Follow-up message delivered duplicated/concatenated (bug) — severity: high

The `user_prompt` event the agent received contained my message
**twice, concatenated**: text I had typed into a different
(non-composer) text field during an earlier failed send attempt was
prepended to the message I actually sent from the composer. The two
fragments fused into one prompt with no separator. The agent coped,
but a less robust prompt would have produced confused behavior.
Likely cause: typed-but-never-sent input is buffered somewhere
(terminal stdin proxy?) and flushed together with the next composer
send. Input that was never submitted must not be delivered.

### F16. Non-ASCII characters mojibake'd in message pipeline (bug) — severity: medium

The em-dash "—" in my follow-up reached the activity event stream as
`â\x80\x94` (UTF-8 bytes re-decoded as Latin-1). Anyone typing in
French ("é", "à") — the author's locale! — will see garbled activity
events, and the agent may receive garbled text too. Audit the
composer → websocket → tmux/dtach write path for a missing UTF-8
encoding declaration.

### F17. "Send & Next" teleports you away from your task (UX) — severity: medium

The completion composer's only primary action is **Send & Next**:
sending my reply instantly navigated me to a *different* task in a
*different project*. For triage power-users that's the point; for a
user who wants to watch their reply land, it's disorienting — I had
to find my task again to confirm anything happened. Offer a plain
"Send" (stay) next to "Send & Next" (advance), or make Enter=send,
Cmd+Enter=send-and-next.

### F18. Composer is a one-line `<input>` for multi-line work (UX) — severity: low

Replies to agents are often multi-sentence with code paths; the
composer is a single-line text input (`<input type=text>`), so long
replies scroll horizontally and pasting multi-line text is lossy.
Make it a auto-growing textarea like the Launch modal's description.

### F19. Left rail morphs and hides actionable tasks (UX) — severity: medium

Across one session the left rail switched organization several times
(SUPERVISOR FINDINGS / HEALTHY / SCHEDULES → Needs Input / Healthy /
Snoozed / Completed / Schedules). After my task signaled complete —
i.e. became *the* most actionable item, explicitly waiting on me —
it lived inside a **collapsed** "Needs Input" group and the task text
was not in the DOM at all; finding it again required search or
expanding groups one by one. The thing waiting on the user should
never be hidden by default. Persist expansion state, and auto-expand
any group that gains a waiting-on-you item.

### F20. Toasts from unrelated agents interleave into focused work (UX) — severity: low

While replying to my task, a long toast from a *different* agent
("Agent: ready for review — … RFC 0005 …") appeared over the panel.
With 10+ concurrent agents this becomes a notification firehose
precisely when the user is mid-action. Consider routing non-focused
agents' events to the bell/queue instead of toasting over the active
detail panel (DND existed and was ON in the header — the toast
appeared anyway, which makes DND's scope unclear).

### F21. Raw enum values and dev-metrics leak into UI copy (polish) — severity: low

- Search palette shows task status as `InProgress` (camelCase enum).
- Bottom status bar shows `Loop 222ms` — a render/event-loop timing
  that means nothing to users (and nothing bad at 222ms?).
- Cost figure `$17,0xx` (header) has no tooltip explaining scope.

## Things that worked well (keep)

- Task launch API rewrites relative file mentions to absolute paths
  and injects worktree discipline into the prompt while preserving
  `userPrompt` — visible, useful, and auditable.
- Auto-naming kicked in quickly ("Review README for inconsistencies
  with codebase" from my long prompt).
- Task detail panel: activity feed + live terminal side-by-side is
  exactly what a user wants when checking on an agent.
- Onboarding tour copy is clear about what Kookr is/does.
- The full manual-task lifecycle **works end to end**: UI launch →
  live terminal monitoring → agent signals complete → follow-up reply
  ("push and open a PR") → agent pushes branch and opens a real draft
  PR (knowledge-base-mcp-server#586) → user confirms completion.
- Completion dialog offers an optional 👍/👎 rating (feeding the
  task-feedback-reflect loop) with keyboard hints (Enter/Esc) — low
  friction, skippable, well placed.
- Search palette (Ctrl+K) finds tasks instantly with clear
  navigate/run/close hints.
- Playbooks tab is a usable catalog (scope badges, param counts).
- Voice input affordances (mic buttons, Alt+M) are pervasive.
- Error toasts, when they appear, include recovery steps (even if
  mis-prioritized — see F12).

## Suggested priority order

1. **F12 + F13** (launch failure UX + risky cwd default) — first-run
   users hit these in their first five minutes, and F12 loses their
   typed work.
2. **F15 + F16** (duplicated message delivery, mojibake) —
   correctness bugs in the user→agent channel, the product's core.
3. **F14 + F19** (false-alarm badge, hidden waiting-on-you tasks) —
   trust and attention-routing, Kookr's stated purpose.
4. F1/F2/F5/F6 (data trust + API ergonomics).
5. F3/F7–F11, F17/F18/F20/F21 (hygiene and polish).

## Session log

- 2026-06-10 ~18:15 — session start; API smoke checks; F1–F3 recorded.
- 2026-06-10 ~18:21 — manual task launched via API in
  knowledge-base-mcp-server (README consistency audit); F4–F6.
- 2026-06-10 ~18:25 — first UI screenshots; F7–F11.
- 2026-06-10 ~18:35 — Launch-modal failure reproduction with
  nonexistent cwd; F12–F13.
- 2026-06-10 ~18:45 — signaled-complete review flow, follow-up reply,
  duplicated-prompt + mojibake discovered in event stream; F14–F18.
- 2026-06-10 ~18:55 — second manual task (dead-code scan,
  reason-at-home) launched through the UI happy path; search palette
  checked; F19–F21. README task completed with 👍; draft PR #586
  verified on GitHub.
