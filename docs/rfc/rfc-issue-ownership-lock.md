# RFC: Issue-Ownership Lock — an Atomic Claim Registry for GitHub Issues

**Status:** Draft (v4 — post round-4 panel: socratic, operability, design-minimalist, ambition-amplifier; consolidated. Ready for user review)
**Date:** 2026-07-02
**Author:** Jean Ibarz (with Claude Opus 4.8)
**Implementation branch:** `rfc/issue-ownership-lock`

---

## Problem

Kookr lets a standalone launch and a parallel batch both select work autonomously. Nothing records *who owns an issue* when it is selected, so two independently-launched tasks can pick the same GitHub issue, each create a worktree, and each start editing — and the only thing that stops them is a human supervisor typing a correction into one of the terminals.

### Empirical grounding

The run-21 self-reflection over recent Kookr supervision sessions (`~/.claude/session-reflections/reflection-report.md`) found that with duplicate-prompt dedupe, stale-base corrections, and delivery automation all improving, the **single biggest remaining source of manual intervention is duplicate work on one issue** — ~7 of the 15 interventions in session `2026-07-01T23-07-34-400Z`, and the report's #1 pattern to fix. Concrete evidence:

- **Issue #700 — one task, four live sessions, four identical corrections.** The supervisor sent the *same* correction **4 times** to four different agent IDs: *"this #700 task accidentally has multiple live sessions. You are NOT the designated owner session (kookr-e7957251). Stop immediately. Do not create a worktree, edit tracked files…"* Two distinct failures: one task ID acquired multiple live sessions, **and** multiple agents were touching one issue.
- **Issue #779 — two independent selection paths collided.** A parallel batch already owned #779 through a child task (`ef486174…` / `kookr-05c5f8ea`), yet a **standalone** task (prompt: *"fix the control-room enter bug"*) independently selected the same issue and had to be told: *"stop work on issue #779 immediately. A parent parallel batch already selected #779…"*
- **Issue #779 ↔ #780 — file collision, hard hold.** #779's uncommitted edits landed in files also being changed by active task #780, forcing a *"hard hold"* correction.

**Direct measurement (round-4).** A scan of the current task store (pruned to 16 records — the long history is not reconstructible because `audit.jsonl` deletion rows carry only task IDs, not prompts) found **3 same-issue task pairs created within 60 seconds of each other** (one pair 6s apart) and 9 within 10 minutes. Small corpus, and some pairs may be legitimate relaunch chains — but same-issue temporal proximity is demonstrably not rare even in a 16-record window. The claim frequency question (Open Questions in earlier drafts) is now answered as well as the available data allows.

**Honest scoping of the evidence (round-1/round-4 socratic).** The evidence is concentrated in one long session; #700 — though corrected four times — is arguably one incident. This RFC claims a **structural gap**, not a statistical base: there is *no atomic, cross-path record of issue ownership at selection time*. Two of the three items (#700 multi-session, #779 double-selection) are in scope. **#779↔#780 is a *file-scope* collision between two different issues — an issue lock does not fix it** (Non-Goals; reflection Rec #4 tracks it separately). We cite it only insofar as removing the #779 double-selection removes one of the two colliding tasks.

**Coverage honesty (round-4).** #779's standalone task was launched from a generic prompt, plausibly through *none* of the instrumented playbooks. The plugin ships ~7 issue-selecting playbooks, not 2. This RFC therefore (a) instruments **every** issue-selecting playbook, not just `implement-github-issue` (§7), and (b) states plainly that a raw ad-hoc spawn that picks an issue with no playbook remains unprotected until the PR-2 hook backstop — a documented residual gap, not a claimed win.

### Why prompt-hash dedupe does not already solve this

`kookr spawn` ships a prompt-hash dedupe (`--dedupe warn|block|skip`, `bin/kookr-spawn.js:150`; server check `src/server/launch-service.ts:169`, key = `(promptHash, agentType, canonicalCwd)`). It catches *"the same task launched twice."* It does **not** catch #779: `Implement issue #779…` and `fix the control-room enter bug` are different strings resolving to the same issue. Issue-ownership locks on the issue identity — the thing that actually collides. The two mechanisms are complementary.

### What Kookr already has (and this RFC reuses)

- **A single-writer server process.** CLI verbs are thin HTTP clients against the one running server (`bin/kookr.js:42`, `bin/kookr-signal.js:110`); Node runs one handler to completion between `await` points. Same "strong consistency for free" placement as `rfc-meta-task-coordinator §7`.
- **A task store with synchronous creation and atomic persistence.** `TaskStore` (`src/core/tasks.ts`) is an in-memory `Map`; `createTask` (called at `src/server/launch-service.ts:357`) is **fully synchronous**. Persistence: `TaskStateSaveScheduler` (`src/server/task-state-save-scheduler.ts:46`) coalesces into atomic writes (`atomicWriteFile`, `src/core/persistence-utils.ts:19`); its `flush()` loop is race-safe (verified). No OS file lock — one server process is already the correctness assumption. Terminal states: `completed|terminated|cancelled` (`src/shared/contracts/task-status.ts:17`).
- **The launch gate where dedupe already blocks.** `launchTask` runs `checkSubmission` (`:333`) before `createTask` (`:357`) and `adapter.launch()` (`:407`); launch failure already calls `deleteTask` (`:430`).
- **The registry pattern to mirror: `WorktreeLeaseService`** (`src/core/worktree-lease-service.ts:18`) — an **in-memory `Map` as the authority for live occupancy**, owner-scoped release, transient `reconcileFromTaskStore` backfill. (Its heartbeat-based staleness is deliberately *not* copied — see R12.)
- **The repo-resolution toolbox** in `src/core/project-identity.ts` (`getProjectId:173`, `normalizeGitRemote:38`, `projectIdFromRepoSpecifier:69`, `isSafeGithubProjectId:227`, `projectIdToOwnerRepo:269`); `TaskStore.getProjectIds()` (`tasks.ts:616`). No fork→upstream resolver exists (verified).
- **Observability anchors:** `CollaborationAuditLog` (structured allow/deny JSONL — note: multi-writer in practice; our sink is deliberately single-author, R21) and the synchronous `summarizeActivity` (`src/core/activity-summary.ts`, fed by `Monitor` events, never an LLM call).
- **An already-anticipated claims API.** The `parallel-issue-batch` playbook (Phase 2 step 5) already reads `GET /api/issue-claims?provider=github&repo=$REPO` "when available." Greenfield; this RFC ships it as authoritative.

### What's missing

Any record of issue ownership at selection time; any atomic claim (the batch read is read-then-act); any one-live-session-per-task enforcement (#700); any automatic release when an owner dies.

## Goals

- **Explicit, atomic ownership:** exactly one task owns an issue, decided *before* either claimant creates a task or worktree.
- **Automatic claiming** folded into every issue-selecting path (all ~7 issue-selecting playbooks + batch spawn), not agent memory.
- **Structured refusal** so a losing autonomous agent re-selects or parks cleanly without a human.
- **Safe automatic release** on terminal state; reclaim only *confirmed-dead* owners; never leak locks; never reclaim a live-but-quiet owner.
- **Fork-aware repo resolution** with no repo string needed in the common case and hard rejection of misspelled/mismatched identifiers.
- **Reduce #700 recurrence** via a one-live-session guard **sited by a mandatory attach-path audit** (R18) — no premature "cannot recur" claim.
- **Prove it worked and turn it off safely:** durable audit trail, boot-visible flag state, and a kill switch from the first hot-path PR.
- Reuse the coordinator's in-process placement and `WorktreeLeaseService`'s registry pattern. No parallel source of truth.

## Non-Goals

- **No cross-machine / distributed lock.** Single host, single server process (now asserted at startup, R27).
- **No file-scope lock.** Cross-issue file overlap (#779↔#780) is real but separate (reflection Rec #4). Not claimed solved here.
- **No new durable *state* store.** Authority is an in-memory map; its durable projection is `Task.issueClaim` in `tasks.json`; the only new durable file is the append-only audit log.
- **No GitHub-side lock** (labels/assignees/branches — Alternatives).
- **No blocking queue in PR 1** (refuse-and-re-select; queue deferred).
- **No session-attach rewrite.** One-live-session is enforced and the violation detected; the #700 root cause is audited first (R18), any refactor deferred with a stated fallback.
- **No replacement of prompt-hash dedupe.**

## Requirements

Deterministic, testable. Round tags: `W#` (round 1), `N#` (round 2), `R3v`/`R4v` (round 3/4 verification).

### Atomicity, placement & source of truth

- R1. A claim SHALL be keyed by `(canonical-repo, issueNumber)` with at most one active owner. No `provider` field (YAGNI; the endpoint accepts `?provider=github` for playbook compat but ignores it).
- R2. **The live-ownership authority SHALL be an in-memory `Map<key, ownerTaskId>`** in the registry (the `WorktreeLeaseService` model), with `Task.issueClaim` as its **durable projection**, rebuilt into the map on boot. This is the canonical statement of the round-2 N1 resolution: a claim must have a home *before* its task exists, which only the map provides; the map and field have one writer (the registry), so they cannot desync. [N1]
- R3. `Task.issueClaim` SHALL be written only via `TaskStore.setIssueClaim()`/`clearIssueClaim()`, and only by the registry. Enforced **structurally** (call-site-count test or restricted export), not by review discipline — the `setProjectId` precedent already drifted to two callers. Honestly: a call-site test is a speed bump, not a guarantee (a contributor can update it in the same commit); if drift recurs, escalate to an unexported/branded-type design. [boundary, R4v]
- R4. Claim acquisition SHALL be two-phase: **(a)** async key resolution (repo, §6 — may `await`); **(b)** a **synchronous critical section** in `launchTask` interleaved with task creation: read the map → if held by a task that is non-terminal **per its in-memory store status** (the *synchronous* "live"; never the async `isAlive` probe, which belongs to reconcile R12 — using it here would reintroduce the W9 yield) → return the owner block, **no task created**; else `createTask()` (synchronous) → `map.set` → `setIssueClaim`. No `await` between check and set. Both the set-before-yield ordering and the synchronous-status held-check SHALL be tested invariants. [W1, W2, W9, N1, R3v]
- R5. On grant, the winner's `issueClaim` SHALL be flushed (`TaskStateSaveScheduler.flush()`) before the claim is reported won — after the in-memory set, so the race stays closed while the crash-before-persist window closes. Whole-file fsync cost accepted at N<50; measure, and MAY relax later. [W3, N8]
- R5b. The `adapter.launch` failure catch (`launch-service.ts:426`, today `deleteTask` only) SHALL also call `releaseAllFor(taskId)` — else a failed launch leaves an orphaned map entry and a phantom `granted` audit row. [R3v]
- R6. Claims SHALL be re-entrant for their owner (idempotent → exit 0).
- R7. **Feature flag `KOOKR_ISSUE_CLAIMS`** (read at startup; **restart required**; resolved value SHALL be logged at boot, R23) SHALL gate the feature completely: when off, (a) the `launchTask` CAS is a **strict early no-op** — no repo resolution, no `await`, no throw, for the ~100% of launches that don't claim; (b) release-side calls are no-ops; (c) claim routes return **404**, collapsing flag-off and old-server into the single client behavior of R26. Default off in the first hot-path deploy. This is the canonical no-op/kill-switch statement; §1 and Rollback cross-reference it. [delivery, R4v]
- R27. The server SHALL assert **single-writer at startup** (pid/port lock) so the CAS's inherited single-process assumption fails loudly, not with silent double-grants, if Kookr ever runs multi-process. Ships in PR 1a. (Promoted from SHOULD/Open Question — the same structural-enforcement standard R3 applies to field writes applies to the process assumption the whole CAS rests on.) [R4v ambition]

### Release, expiry, reclaim

- R8. Claims SHALL be released on terminal transition, in the three `agent-lifecycle` wrappers beside `releaseTaskLeases` (`:341/:377/:401`).
- R9. Release SHALL also fire on the reconcile-driven dead-session terminate — as an **additive `releaseAllFor(id)` call at reconcile's two call sites** (boot `index.ts:573`, periodic `lifecycle-timers.ts:386`), *not* a reroute through `LifecycleDeps` wrappers (which would double-fire cleanup, and the boot site precedes deps construction at `:742`). [N2, boundary]
- R9b. Every `releaseAllFor` call site SHALL be **defensively isolated** (`.catch`, mirroring `cleanupTaskWorktrees(...).catch(...)`) so a registry defect cannot abort completion cleanup or a reconcile tick — the release side runs on *every* task completion and is therefore itself a hot path. The catch SHALL NOT be silent: it SHALL log at error level (taskId + error) and emit a `release_failed` ClaimEvent — a swallowed release failure is a leaked claim, and R14's no-leak guarantee is unfalsifiable without the signal. (Flag-gating is per R7, not restated.) [delivery, R4v operability]
- R10. Release SHALL be holder-checked (`releaseAllFor` clears a key only if that task still owns it). [W8]
- R11. Orphaned claims (owner task gone) SHALL be treated as released.
- R12. Confirmed-dead reclaim rides R8/R9: the dead-session terminate (gated on `hasLiveBackingSession` → `terminalBackend.isAlive`, `launch-service.ts:199`) releases the claim. Reclaim SHALL NOT use passive PostToolUse recency; a live-but-quiet owner (Playwright run, long LLM pass) SHALL NOT be reclaimed. [W4]
- R13. Time-based staleness (quiet but sessions probe alive) SHALL raise a **coordinator finding** only — never a silent takeover. [W4]
- R14. Locks SHALL NOT leak: after owner death the key becomes claimable within one reconcile tick, and every release/reclaim/failure-to-release is recorded (R21, R9b).

### Loser refusal, bounded re-selection & override

- R15. A losing claim SHALL exit non-zero with the owner block: `taskId`, `sessionId`, `status`, `name`, `worktree`, `doing`, `lastActivityAt`.
- R16. On refusal the automatic caller SHALL prefer **re-selection**: one pass over the finite candidate set (skipping claimed issues; freed-mid-pass not revisited — bounded staleness, no livelock), then one retry after ≥1 reconcile interval (the dead-owner window is ~one 5s tick), then stop. **The give-up SHALL be observable**: emit an `exhausted` ClaimEvent and a coordinator finding — the same treatment as R25's park, since both are "automation stopped trying, human should look." Claim steps sit at selection time (before worktree/implementation); sunk cost on refusal is candidate *reading* only, and the advisory list read lets callers filter claimed issues before selecting at all. [N5, N6, R4v operability/socratic]
- R17. `--force` takeover: CAS-guarded, releases the prior owner atomically, records `takeoverOf` + a note on the displaced task, audits with the prior owner's status/`doing` snapshot. Operator/manual use only; playbooks SHALL NOT invoke it autonomously. [W8]

### One session per task (audit-first)

- R18. **The #700 attach-path audit is a blocking prerequisite** (a `docs/reports/` artifact in PR 1a): determine from session records which call chain produced four sessions — `addSession` is reachable from `launchTask` but also `crash-recovery`, `startup-recovery` (`replayExisting`), `ralph-loop-service`, `schedule-runner` (adapters: `claude-code-adapter.ts:379`, `codex-cli-adapter.ts:370`). The one-live-session guard (async `isAlive` probe; allows legitimate recovery/replay re-attach) SHALL be placed at the chokepoint the audit identifies. **Stated fallback:** if the audit shows a guard cannot cover the pattern (e.g., it originates inside a whitelisted replay path), PR 1c becomes a session-attach design decision brought back to the user — not a guard shipped on faith. Until then the RFC claims "reduce," not "cannot recur." [N3, R4v ambition]

### Repo resolution (fork-aware)

- R19. The repo argument SHALL be optional, resolved from cwd (`getProjectId`). The claim key SHALL be the **issue's home repo** (upstream, for forks — two forks of one upstream must collide on one key). **Instrumented playbooks auto-populate `--repo` from their own parameters** (batch: `repoFullName`; `implement-github-issue`: its repo param) — so for every instrumented path the fork case requires no manual step, honoring "automatic, not remembered." Only a truly ad-hoc claim from a fork checkout must pass `--repo <upstream>` explicitly; fork + no `--repo` fails closed (exit 2, actionable message), never silently keying on the fork. Automatic gh-backed upstream detection is a fast-follow **specified as fail-closed with a bounded timeout** (gh success → auto-fill; gh failure → the same exit-2 as today — strictly additive UX; the earlier fail-open concern [N4] applied to a design this RFC never intended to build). [W6, N4, R4v ambition]
- R20. Repo identifiers SHALL be normalized (`normalizeGitRemote`/`projectIdFromRepoSpecifier`) and validated (`isSafeGithubProjectId`). An explicit `--repo` is authoritative for the issue's home; rejected as a mismatch (exit 2, print both) only when neither the cwd `origin` nor a known upstream of it. If nothing yields a safe id → fail listing the cwd repo + `TaskStore.getProjectIds()`. Bare names (`lucy`) map only if unambiguous among active project ids, else exit 2 with candidates.

### Observability & degradation

- R21. Every claim decision (`granted|reentrant|denied|released|dead_reclaim|orphan_reclaim|force|release_failed|exhausted`) SHALL flow through **one authorship point**: an injected sink (`emit(ClaimEvent)`) called only inside the registry, with `claim()`/`releaseAllFor()` returning structured results so no caller re-derives rows. Sink writes `~/.kookr/issue-claims-audit.jsonl` (JSONL format per `CollaborationAuditLog`; authorship model deliberately single-writer, unlike that log). **A sink write failure SHALL itself log at error level** — a silently frozen audit log is indistinguishable from a quiet day, and the log is the PR-1 measurement mechanism (R24). [boundary, operability, R4v]
- R22. `doing`/`lastActivityAt` SHALL be produced by a **server-side decorator** over the registry's bare `ClaimOwnerRecord` (synchronous `summarizeActivity` over `Monitor` events — never an LLM call); `Monitor`/`TerminalBackend` never enter core. The decorator is the single place these fields are computed, shared by the HTTP list and the launch-time refusal body. [boundary]
- R23. PR-1 read surface: `ageMs` + `lastActivityAt` on `list`/`owner` (needed by R15). Boot SHALL log, in order: the resolved `KOOKR_ISSUE_CLAIMS` value (so an operator can confirm a kill-switch restart took effect), then `[issue-claims] N owners rebuilt from M active tasks; K unprotected: <task ids, truncated>` — IDs, not just a count, so the operator can act on it. `stale`/`reclaimable`/`numberKind`/`--stale-only`/`--verify` deferred (fast-follow / PR 3). [minimalist, R4v operability]
- R24. `/metrics` counters are deferred; the **audit log is the PR-1 measurement mechanism**, with a **stated practice**: the existing session-reflection loop (the process that produced this RFC's evidence) SHALL include the claim audit log in its per-run analysis, so "did duplicate-work interventions drop" is answered on the reflection cadence, not left to memory. [minimalist vs operability, resolved]
- R25. Server unreachable → **bounded fail-closed**: ~3 tries/~30s backoff, then stop. "Blocked" is a `CoordinatorFinding` (no new `TaskStatus`), and because the trigger is server-unreachability, the CLI SHALL **also park locally** (non-zero exit, reason on stderr). The stderr park lands in the agent's terminal pane, which Kookr's session capture already ingests — so it surfaces in the task's activity/`doing` even while the server-side finding can't render; the finding lands when the server returns. [W7, N7, R3v]
- R26. HTTP 404 on the claim routes (old server, or flag off per R7) → **proceed as pre-lock** (advisory, logged). Distinct from unreachable: failing closed on version skew would turn a plugin/server deploy-ordering mismatch into a fleet launch outage. [delivery]

## Design

### 1. Two-phase claim, interleaved with task creation

Phase (a) resolves the key (may `await`: repo resolution, §6). Phase (b) is the synchronous CAS per R4, placed in `launchTask` beside `checkSubmission` (`:333`), behind the R7 flag/no-op contract:

1. `holder = map.get(key)`; held by a non-terminal task ≠ me (synchronous status read) → owner block, no `createTask`.
2. Else `createTask()` (synchronous, `:357`) → `map.set(key, task.id)` → `setIssueClaim` → `await flush()` (R5) → proceed to `adapter.launch` (whose failure catch releases, R5b).

`createTask`'s synchronicity (verified: `tasks.ts:119-215`, no internal `await`) is what makes steps 1–2 one event-loop tick; a concurrent claimant that passed phase (a) sees the map entry. The map is not a redundant index — it is the only structure that can hold a claim in the pre-`createTask` window (R2/N1); v2's "scan tasks, no map" variant is why round 2 found the atomicity broken.

The single-process assumption behind all of this is asserted at startup (R27).

### 2. Data layer

```jsonc
// durable projection on Task (task-read-model.ts), written only via TaskStore.setIssueClaim (R3)
"issueClaim": { "repo": "github.com/owner/repo", "number": 779,
  "sessionId": "kookr-05c5f8ea", "claimedAt": "2026-07-02T18:04:00Z", "takeoverOf": null }
```

```ts
// in-memory authority in the registry (rebuilt from fields on boot; R2)
private owners = new Map<string /* repo\tnumber */, string /* taskId */>();
```

### 3. `IssueClaimRegistry` — pure core, injected sink, server-side decorator

`src/core/issue-claim-registry.ts`, constructed in `createKookrServerInternal`. Depends on a narrow port + sink — never on `Monitor`, `TerminalBackend`, or `server/coordinator`:

```ts
interface ClaimTaskView { id; status: TaskStatus; name; issueClaim?; worktreePath?; } // projection, not full Task
interface ClaimTaskPort {
  activeTaskViews(): ClaimTaskView[];
  setIssueClaim(taskId, c): Promise<void>;   // awaits flush (R5)
  clearIssueClaim(taskId): void;
}
class IssueClaimRegistry {
  constructor(port: ClaimTaskPort, emit: (e: ClaimEvent) => void) {}
  claim(key, claimant, opts): ClaimResult     // synchronous CAS (§1)
  releaseAllFor(taskId): ReleasedKey[]         // holder-checked (R10)
  ownerRecord(key): ClaimOwnerRecord | null   // bare fact; no doing/stale
  listRecords(filter?): ClaimOwnerRecord[]
}
```

Liveness is never consulted in `claim()` (that removes the W9 yield and keeps core clean); confirmed-dead reclaim is the reconcile-driven release (R9/R12); time-based staleness → finding (R13). The server-side decorator (R22) adds `doing`/`lastActivityAt`/`ageMs`; the sink (R21) is the sole audit author. Both the `--claim-issue` launch path and the CLI drive the same singleton registry, so refusal shape and exit codes are shared by code.

### 4. HTTP surface

| Method & path | Purpose | Success | Conflict |
|---|---|---|---|
| `POST /api/issue-claims` `{repo,number,taskId,sessionId,force?}` | atomic claim | `200 {owned:true,reentrant,tookOverStale?}` | `409 {owned:false,owner:{…}}` (decorated) |
| `DELETE /api/issue-claims/:repo/:number` `{taskId}` | explicit release (holder-checked) | `200` | `403` if not owner |
| `GET /api/issue-claims?repo=&number=` | list (one when `number` given); `ageMs`/`lastActivityAt` | `200 [{…}]` | — |

`repo` canonical, re-validated (`isSafeGithubProjectId`, 400). Unknown/terminal `taskId` → 400. Flag off → all three return 404 (R7).

### 5. CLI surface — `kookr issue`

`bin/kookr.js` dispatches `issue` → `bin/kookr-issue.js` (thin-client pattern, shared exit constants). Verbs: `list [--json]`, `claim <issue> [--repo <r>] [--force] [--json]`, `release <issue> [--repo <r>] [--json]`, `owner <issue> [--repo <r>] [--json]`.

| Code | Meaning |
|---|---|
| `0` | You own it (granted, re-entrant, or post-`--force`). |
| `2` | User error: bad flags; unresolvable/ambiguous repo; fork with no `--repo`; repo neither cwd-origin nor its upstream. |
| `3` | Server unreachable → bounded fail-closed + local park (R25). |
| `4` | Server rejected (unknown/terminal task, bad issue id). |
| `5` | Reserved (prompt-hash dedupe, `kookr-spawn`). |
| `6` | **Claim held by another live task** (R15). Distinct code kept deliberately — `kookr-signal`'s convention is distinct codes "so a wrong … is visible rather than silently swallowed," and playbooks branch on it without parsing JSON. |

404 (route absent: old server or flag off) → reported distinctly; autonomous caller proceeds as pre-lock (R26). Exit 6 → re-select per R16:

```
✗ You do NOT own github.com/owner/repo#779.
  Owner:   task ef486174 (kookr-05c5f8ea) · status inProgress
  Worktree ../repo-issue-779-enter-fix
  Doing:   "running control-room test suite" (last activity 40s ago)
  Action:  pick a different issue. Operator override: kookr issue claim 779 --force
```

### 6. Repo resolution (fork-aware)

`resolveClaimRepo({cwd, repoFlag, activeProjectIds, isFork})` — server use-case, deps injected (placement verified clean against `use-cases/` precedent):

1. `fromCwd = getProjectId(cwd)` (phase (a)); `local/<name>` → null.
2. Fork + no `repoFlag` → **exit 2**: "cwd is a fork; pass `--repo <upstream>`" (R19; instrumented playbooks auto-populate it, so this fires only for ad-hoc fork usage).
3. No flag, not a fork: home = `fromCwd`; unsafe id → exit 2 + active-repo list.
4. With flag: parse (`projectIdFromRepoSpecifier`); bare-name disambiguation per R20; accept if `fromCwd` or its upstream, else exit-2 mismatch (the hallucination guard).
5. Validate (`isSafeGithubProjectId`).

Existence / PR-vs-issue validation needs `gh` (no local issue index exists — verified) → PR-3 `--verify`.

### 7. Integration: claim points everywhere issues are selected

Kookr does not create worktrees — agents do; so Kookr's claim point is the launch gate and the agents' is a playbook step:

- **Batch:** parent keeps the advisory read (early filter), spawns with `--claim-issue <n>` → CAS in `launchTask` (§1). Loss → no task; re-select (R16).
- **Every issue-selecting playbook** (`implement-github-issue`, `oss-bug-fix`, `oss-bug-pr`, `oss-bug-triage`, `oss-contribution-pipeline`, `issue-triage`, `repository-idea-scout`, and any future ones): a required `kookr issue claim "$TARGET"` step immediately after target selection, `--repo` auto-populated from the playbook's repo parameter. Exit 0 → proceed; 6 → next candidate then bounded retry (R16); 3 → bounded park (R25); 404 → pre-lock (R26). *(Round-4 correction: v3.1 instrumented only two playbooks; #779's standalone task plausibly used neither.)*
- **Residual gap, stated:** a raw ad-hoc spawn that picks an issue with no playbook is unprotected until the PR-2 hook backstop (which gets real design in PR 2 — it needs a "when does reading become claiming" policy that is out of PR-1 scope).
- **Release:** terminal wrappers + additive reconcile release (R8/R9/R9b); launch-failure release (R5b).
- **One-session guard:** per the R18 audit outcome.

### 8. Observability

Single-author audit log (R21, including `release_failed`/`exhausted`), boot log with flag value + unprotected IDs (R23), reclaim visibility (audit row + displaced-task note + finding for time-based staleness), `ReconciliationResult.claimsReleased`, local park captured via session output (R25), measurement practice on the reflection cadence (R24).

## Files to change

- **New** `src/core/issue-claim-registry.ts` (+ test) — registry per §3. Tests: two claimants same tick → one owner, loser creates no task; reverse-order key resolution → one winner; set-before-await + synchronous-held-check invariants; re-entrant; orphan reclaim; holder-checked release; CAS-guarded double-`--force`; boot rebuild.
- `src/core/task-read-model.ts` — `issueClaim`; `src/core/tasks.ts` — `setIssueClaim`/`clearIssueClaim` + call-site guard (R3).
- `src/server/launch-service.ts` — CAS before `createTask` (flag-gated strict no-op, R7); `--claim-issue`; release in the launch-failure catch (R5b); one-session guard per R18 audit.
- `src/server/agent-lifecycle.ts` — isolated `releaseAllFor` in the three terminal wrappers (R9b).
- `src/server/reconciliation.ts` + `lifecycle-timers.ts` + `index.ts` — additive isolated release at both reconcile sites; `claimsReleased`; registry + sink construction; boot order (flag log → rebuild → serve); startup single-writer assertion (R27).
- **New** `src/server/issue-claims-audit-log.ts` (+ test) — the sink; error-logs its own write failures (R21).
- **New** `src/server/issue-claim-decorator.ts` (+ test) — `doing`/`lastActivityAt`/`ageMs` (R22).
- **New** `src/server/routes/issue-claims.ts` (+ test) — three routes; flag-off → 404 (R7/R26).
- **New** `src/server/use-cases/resolve-claim-repo.ts` (+ test) — §6; fork tests (fork+no-flag → exit 2; explicit upstream accepted; two forks collide on one key).
- **New** `docs/reports/` #700 attach-path audit (R18, blocking for 1c).
- `bin/kookr.js` + **new** `bin/kookr-issue.js` (+ test) — verbs, exit codes, bounded park, 404-vs-unreachable.
- `bin/kookr-spawn.js` — `--claim-issue <n>`.
- **All issue-selecting playbooks** in `plugin/playbooks/` — the claim step with auto-populated `--repo`, bounded re-selection, degradation handling (§7).
- `docs/architecture.md` / `docs/features.md` — registry, CLI, audit log, flag.

## Edge cases

### Repo-identifier correctness

| Situation | Behavior |
|---|---|
| Normal: cwd `origin`, no fork | home = `origin`; no `--repo` needed. |
| Fork via instrumented playbook | `--repo` auto-populated from the playbook's repo param; no manual step (R19). |
| Fork, ad-hoc, no `--repo` | exit 2 with actionable message; never keys on the fork. |
| Two forks of one upstream claim #123 | both key on upstream → collide correctly. |
| `--repo jeanibarz/lucy`, cwd `kookr`, unrelated | exit 2, print both (hallucination guard). |
| `--repo lucy` (bare) | unique `*/lucy` among active → use; else exit 2 with candidates. |
| `--repo LUCY.git` / SSH URL | normalized. |
| No `origin`, no `--repo` | exit 2 + active-repo list. |
| Number doesn't exist / is a PR | claimed offline; hard check is PR-3 `--verify`. |

### Lock-lifecycle

| Situation | Behavior |
|---|---|
| Three claimants same tick | phase (b) serializes; one owns, others exit 6 → re-select (R16). |
| Owner reaches terminal state | wrapper → holder-checked release (R8/R10). |
| Owner crashes, sessions confirmed dead | reconcile terminate + additive release (R9/R12), audited. |
| Owner quiet 31 min, sessions alive | **not** reclaimed (R12); finding only (R13). |
| Dead-owner window (~5s tick) | last-candidate exit-6 retries once after ≥1 tick (R16). |
| Server crash after grant | R5 flush → task+claim persisted together or neither; boot rebuilds. |
| `adapter.launch` fails after grant | catch releases + deletes (R5b); no orphan, no phantom audit row. |
| Queued (pended) owner | a pended task holds its claim (it won the issue; the claim is the reservation). If an operator needs the issue *now*: cancel the pended task (auto-releases) or `kookr issue release`/`--force`. |
| Re-entrant (spawn + CLI) | same task → 200 (R6). |
| `--force` vs concurrent old-owner release | holder-check (R10) + CAS-guarded force (R17). |
| #700 four sessions | guard per R18 audit; recovery/replay re-attach allowed. |
| Re-selection exhausted | `exhausted` audit event + coordinator finding (R16) — not a silent stop. |

### Migration / rollout

| Situation | Behavior |
|---|---|
| In-flight tasks at cutover | boot backfill **through the CAS**, from **high-confidence signals only** (a live `GitHubStateStore` reference typed `issue` on the task's repo) — never raw `playbookParameterValues` (stale/re-targeted → wrong-issue claims). Flag is restart-gated, so enable-on-boot has no concurrent launches mid-scan. Underivable tasks = a bounded fail-open window, logged with task IDs (R23). |
| New playbook + old server | 404 → pre-lock (R26); no outage. |
| New server + old playbook | no claim step → pre-lock. Safe. |
| Rollback | flag off (+ restart; boot log confirms the resolved value) → routes 404, CAS/release no-ops. `issueClaim` fields round-trip harmlessly under reverted code (plain `JSON.parse`, no schema strip — asserted by a rollback test). |

## Failure modes and mitigations

| Failure mode | Mitigation |
|---|---|
| Both claimants read "unowned", both start | map authority + synchronous CAS before `createTask` (R2/R4). |
| Async key resolution reopens the race | phase split; no `await` in phase (b); tested (R4). |
| Async liveness probe sneaks into the CAS | forbidden by R4's synchronous-"live" pin; tested. |
| Crash after grant before persist | forced flush (R5). |
| Launch fails after grant | release in the catch (R5b). |
| Live-but-quiet owner reclaimed | confirmed-dead-only reclaim (R12); staleness → finding (R13). |
| Reconcile rewiring blast radius | additive release, not reroute (R9). |
| Registry defect aborts completions/reconcile | isolated release calls — with error log + `release_failed` event, not silent (R9b). |
| Silently frozen audit log | sink write failures error-logged (R21); expected-stop case documented (Rollback). |
| Guard misses #700's real path | audit-first with a stated fallback (R18). |
| Fork mis-keying / fail-open upstream | home-repo key; explicit `--repo` (auto-populated in playbooks); fail-closed fast-follow (R19). |
| Re-selection livelock / silent give-up | bounded pass + retry + `exhausted` finding (R16). |
| Fail-closed hangs a task invisibly | bounded budget + local park captured in session output + finding (R25). |
| Version skew outage | 404 = pre-lock, distinct from unreachable (R26). |
| Claim bug wedges normal launches | flag + strict no-op contract (R7). |
| Multi-process silently breaks the CAS | startup single-writer assertion (R27). |
| `issueClaim` gains a second writer | structural call-site guard; escalation path named (R3). |

## Alternatives considered

1. **Advisory `declare` (read-then-write).** The race itself; the batch's Phase-2 read is this and didn't stop #779. Rejected.
2. **File-scope lock instead.** Catches #779↔#780 but not same-issue double-selection; needs per-edit scope prediction. Complementary follow-up, not a substitute.
3. **Batch self-dedupe only.** Misses cross-path collisions (batch vs standalone = #779). Kept only as the early advisory filter.
4. **Task-field-only claim, no map (v2) / map duplicating a persisted index (v1).** Both rejected — see R2: the field alone cannot hold a pre-`createTask` claim (N1); the map is the single authority, the field its projection, one writer.
5. **GitHub labels/assignees / branch existence as the lock.** Not atomic, network-bound, pollutes the board / couples "claimed" to "already started." Rejected.
6. **Reroute reconcile through lifecycle wrappers.** Double-fires cleanup; boot site lacks deps (N2). Additive release instead (R9).
7. **gh auto-upstream in v1.** Deferred for hot-path latency, not fail-open (that was a strawman — the fast-follow is fail-closed by construction, R19). Playbook auto-population covers the instrumented paths meanwhile.
8. **Do nothing — prompt-hash dedupe.** Different key; #779 collided under different prompts. Rejected.
9. **Blocking queue.** Larger; refuse-and-re-select first (R16). Deferred.

## Phasing

### PR 1a — Mechanism + manual CLI + audit (no create-side hot path)

Registry (map + projection + sink), `TaskStore` setters + guard, three routes, decorator, CLI verbs, isolated release wiring (terminal wrappers + reconcile — note this *is* a hot path, hence R9b's isolation), orphan/dead reclaim, audit log, boot logging (flag value, rebuild, unprotected IDs), fork-aware `resolveClaimRepo`, startup single-writer assertion (R27), **the #700 attach-path audit report (R18)**. Exercised via manual `kookr issue claim`; flag-gated.

### PR 1b — Auto-claim on the launch path (gated; after 1a soaks)

`--claim-issue` CAS in `launchTask`, claim steps in **all issue-selecting playbooks** (auto-populated `--repo`), bounded re-selection + `exhausted` finding, bounded park, 404-as-pre-lock, boot backfill. **Stated soak criterion for 1a→1b:** ≥1 week of 1a with (i) zero `release_failed` events, (ii) zero audit anomalies (`granted` without eventual `released`/reclaim for terminal tasks), (iii) boot rebuild counts matching expectations across ≥2 restarts. Not just elapsed time.

### PR 1c — The #700 one-session guard

Shaped by the R18 audit: guard at the identified chokepoint, or — if the audit says a guard can't cover it — a session-attach design decision brought back for review. Separated so an attach regression is triageable apart from the claim path.

### Fast-follow — Visibility & convenience

`/metrics` counters, `stale`/`reclaimable`/`numberKind`/`--stale-only`, fail-closed bounded-timeout gh auto-upstream.

### PR 2 — Coordination robustness

Time-based staleness findings via the coordinator module; **the ad-hoc hook backstop** (claim-on-first-`gh issue view`), which closes §7's stated residual gap and needs its own design pass ("when does reading become claiming").

### PR 3 — Validation + UI

`--verify` existence / PR-vs-issue (`gh`-backed); Project Drawer claims surface.

## Rollback

- **Kill switch:** flag off + restart (restart-gated by the env-var convention; the boot log prints the resolved value so the operator can confirm it took). Routes 404 → clients proceed pre-lock; CAS and release no-op. Complete for both batch and playbook paths (R7).
- **Field compat:** `issueClaim` survives reverted code (plain `JSON.parse` round-trip; asserted by a rollback test).
- **Audit log:** append-only; a reverted/off binary stops writing — expected-stop is documented so a frozen log isn't misread; unexpected sink failures error-log while live (R21).
- **`--force` mistake:** re-`--force` back; every force is audited with the prior-owner snapshot.

## Open questions

- **`issueClaims[]`** (multiple linked issues per task) — small change if the single-claim model bites.
- **Backfill fidelity in practice** — how often is an in-flight task's issue confidently derivable at enable time?
- **PR-2 seam** — a narrow `ClaimReclaimPort` so coordinator-driven staleness findings keep `core` clean.
- **Re-selection vs queue** — decide from `exhausted`-event frequency in the audit data after 1b.
- **R5 flush cost** — measure the whole-file fsync on the launch path; relax if it matters.

## Critic feedback incorporated

**Round 1 (boundary, failure-mode, design-minimalist, socratic, operability):** CAS moved before `createTask` (W1); single-writer `issueClaim` (boundary); staleness out of `claim()` (W9); two-phase claim (W2); forced flush (W3); confirmed-dead-only reclaim (W4); attach-site async guard (W5); fork-aware home-repo key (W6); fail-closed no-server (W7); holder-checked release + CAS-guarded force (W8); honest issue-vs-file scoping (socratic); re-selection on refusal; audit log + synchronous `doing` (operability). Rejected with reason: `--force`/`release`/bare-name mapping kept (user-required; `--force` operator-only); distinct exit 6 kept (`kookr-signal` convention); `claimIndex`-as-duplicate/`provider`/`owner`-route dropped (minimalist).

**Round 2 (failure-mode, boundary, design-minimalist, delivery-pragmatist):** **N1 (Critical)** — v2's field-only claim had no home pre-`createTask`; resolved by the map-as-authority + synchronous interleaved CAS (R2/R4). Additive reconcile release (N2/R9); #700 audit-gating (N3/R18); fork explicit-`--repo` (N4/R19); bounded re-selection (N5-6/R16); bounded fail-closed (N7/R25); flush-analogy corrected (N8/R5). Read-path decorator + `ClaimTaskView` + single sink (boundary → R21/R22). Deferred: metrics, `stale`/`reclaimable`/`numberKind`, `--verify`-divergence (checked an index that no longer exists), gh auto-upstream (minimalist). Feature flag, PR 1a/1b/1c split, no-op contract, backfill window, 404 version-skew, Rollback section (delivery).

**Round 3 (verification — failure-mode, boundary, delivery):** all confirmed the v3 fixes hold against real code (`createTask` verified synchronous; decorator/sink clean; boot reconcile precedes `LifecycleDeps` so additive release is the only sound choice). Folded as v3.1: synchronous-"live" pin (R4), launch-failure release (R5b), isolated release calls (R9b), flag-off→404 + restart note (R7), `CoordinatorFinding`-not-`TaskStatus` + local park (R25), high-confidence backfill (Migration), queued-owner row, boot ordering + unprotected count, structural R3 guard, single-author sink note (R21).

**Round 4 (socratic, operability, design-minimalist, ambition-amplifier):**
- **Coverage honesty (socratic #1 / ambition #1 — the round's top finding):** only 2 of ~7 issue-selecting playbooks were instrumented, and #779's standalone task plausibly used neither. Fixed: **all** issue-selecting playbooks get the claim step (§7, Files); the residual ad-hoc gap is stated in the Problem and §7, with the PR-2 hook backstop named as what closes it.
- **Empirical measurement (socratic #7):** performed — 3 same-issue pairs within 60s in the 16-record store; history not reconstructible (audit rows lack prompts). Added to Problem with its limitations stated.
- **#700 audit-first (ambition #2 / socratic #3):** the audit is a blocking PR-1a deliverable with a stated fallback if a guard is the wrong shape (R18, Phasing 1c).
- **Fork strawman (ambition #3):** deferral rationale corrected — the fast-follow auto-upstream is fail-closed by construction; meanwhile playbooks auto-populate `--repo` from their own repo parameter, so no instrumented path has a manual step (R19).
- **Startup guard promoted SHOULD→SHALL** (ambition #4): R27, PR 1a.
- **Operability:** `release_failed` event + error-logged catches (R9b) — the round's highest-value fix (a swallowed release failure was an unfalsifiable leak); `exhausted` event + finding on R16 give-up (parity with R25); boot log prints the resolved flag value; unprotected-count logs task IDs; 1a→1b soak criterion stated (Phasing); local-park visibility via session capture stated (R25); sink-failure logging (R21); measurement practice bound to the reflection cadence (R24).
- **Minimalist consolidation:** no design re-bloat found (all v3.1 items load-bearing); the document was consolidated — the N1 explanation now lives canonically in R2 (was stated 7×), the no-op/kill-switch contract canonically in R7 (was 3×), R9b's flag-gating now cites R7, Alternatives 4/5 merged, requirement litigation-prose trimmed with history retained in this section.
- **Socratic #4/#5 answered in-text:** claim steps sit at selection time so refusal sunk cost is candidate reading only (R16); the queued-owner hold is an intentional reservation with a stated operator path (Edge cases).
