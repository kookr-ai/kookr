# RFC: One front door for issue delivery — natural-language selection, an approvable plan, efficient parallel execution, and uncontested interactive bundles

**Status:** Draft (v4.1 — post round-3 review and consensus attack)
**Date:** 2026-11-14
**Author:** Jean Ibarz (with Claude)
**Evidence pack:** [`rfc-unified-issue-delivery-evidence.md`](rfc-unified-issue-delivery-evidence.md)

---

## Problem

An operator who wants "implement these issues, efficiently" has two playbooks to choose from, and neither one does the whole job.

| | `implement-github-issue` (IGI) | `parallel-issue-batch` (PIB) |
|---|---|---|
| Work | One issue per run, inline; loops and chains | A supervisor that spawns one child task per issue, in parallel |
| Several issues in one PR | Forbidden | Designed, but switched off |
| Selector | Numbers, or a raw `gh --search` string | Same, plus prose in `extraInstruction` |
| A plan the operator can check | None ("do not stop to ask") | A matrix that nobody approves |
| Efficiency guidance | None | None |

The two files total 2,088 lines, about 350 of them duplicated, and their rules disagree in several places (evidence pack §1).

So the operator writes the strategy by hand. On 2026-11-14 they pasted a paragraph asking the task to:

- parallelise;
- group issues into one PR where it helps;
- follow the fleet skills;
- propose a plan to validate first.

The task then did all of this outside any playbook (evidence pack §4). This should be the default behaviour.

**Why bundling is not in the first slice.** Three review rounds established that safe multi-issue PRs need a server change, not just playbook text:

- **One claim per task is a deliberate registry invariant.** `grant()` calls `releaseAllFor` first.
- **Label- or comment-based protection fails.**
  - The queue feeder (`umbrella-decomposer.ts:378`) and the goal supervisor (L271-275) check claims, assignment and linked PRs, but not labels.
  - IGI's open-PR regex at L229 does not match a multi-issue branch name.
  - A bundle would skip its own labelled secondaries.
- **Under-claimed bundle members can be picked up by other launchers.** That is the duplicate-delivery failure the claim registry exists to stop (#700).

This RFC therefore ships everything except bundles now. It defines bundles as a follow-up whose prerequisite is server multi-claim, and records the design inputs the reviews produced.

## Goals

- **G1. One front door.** The operator launches a single playbook to deliver GitHub issues, whatever their count.
- **G2. A natural-language selector**, with today's deterministic shapes behaving exactly as before for numbers, blank, and qualifier filters.
- **G3. An approvable plan.** On request, the run shows the plan once and waits. Otherwise it records the plan and proceeds.
- **G4. Efficient execution.**
  - Run independent issues in parallel children.
  - Route each issue by observable features, as `agent-fleet-orchestration` prescribes.
  - Follow the known efficiency rules.
  - Measure the results.
- **G5. Nothing that runs today changes.** This covers both enabled PIB schedules (kookr with a numbers selector; lucy with a blank selector and `onAmbiguity=auto-safe-subset`), starvation refill, headless report-and-exit, claims, the merge paths (including the head-bound `never-executed` waiver), Ralph loops and self-continuation.

## Non-goals (this RFC)

- **Changing playbook ids**, server code or any merge path. Ten server sites and the live schedules key on `parallel-issue-batch.md`, and there is no alias mechanism. Display names may change.
- **Changing label skip lists.** A union of the lists silently shrinks both live schedules' pools (round-3 delivery finding 2). The lists stay as they are.
- **Multi-issue PRs on contested repos, or headless; single-procedure dedup.** See Follow-ups B and C. Uncontested interactive bundles are R6a–R6d.
- **Enforcing selector rules in tooling.** They are playbook instructions, i.e. best effort. The recorded plan, and approval when requested, are the guard.

## Decision

- **PIB is the front door.** Its display name becomes **"Deliver GitHub Issues"** and its id stays `parallel-issue-batch.md`.
  - It already owns the supervision machinery: the headless gate, run state, the write-scope matrix, contract-checked child spawn, the inline parent fallback, outcome and report-and-exit, and starvation handling.
  - The server's batch matchers and the concurrent-batch guard key on its id.
- **IGI stays the single-issue engine.** Ralph loops, self-continuation chains, and the prose references from the queue feeder and goal supervisor all depend on it. Its description points operators to the front door.
- **"Keep only one of them" is met for operators in Slice A:** one front door. It is met in the implementation by Follow-up C: one written delivery procedure. That trade-off is deliberate. Collapsing the files now would break PIB's spawn-time contract check and the delivery-ownership invariants (round-3 failure-mode finding 3).

## Requirements (Slice A)

### Selector

- **R1. Classify the selector in this order.**
  1. **Reserved qualifiers fail closed.** Any token starting with `repo:`, `state:`, `is:`, `archived:` or `linked:` (prefix match) is rejected with today's message. A rejected selector never falls through to natural language.
  2. **Blank:** unchanged.
  3. **Numbers:** every comma- or space-separated token matches `^#?\d+$`. This is the same rule as `parseExplicitIssuePins`.
  4. **Qualifier filter:** at least one token has the form `-?<qualifier>:<value>`, with GitHub's quoting rules. The selector is passed verbatim to `gh issue list -R "$REPO" --state open --search`, as today.
  5. **Natural language:** everything else. This is deterministic: natural language is exactly "not blank, not numbers, and no qualifier token".
- **R2. Natural-language resolution.**
  - The agent resolves the text with `gh issue list` / `gh issue view`, always with `-R "$REPO" --state open`.
  - It may read an issue's body only after that issue passes the author check.
  - It writes `resolvedNumbers`, the commands it ran and its assumptions (for example "recent = created-desc") to `$STATE_DIR/selector.json`.
  - From then on the run is a numbers run. Every later phase, child, Ralph iteration and continuation uses `resolvedNumbers`, never the text.
- **R3. Free-text keyword selectors.** Today a selector such as `flaky dashboard` (no qualifier) is passed to `gh --search` as keywords. Under R1.5 it becomes natural language, and the resolver is told to treat bare keywords as a keyword search. This is the only shape whose handling changes. The plan records the command, so the change is visible.

### Plan and approval

- **R4. The plan is a proposal until approval, then becomes the existing `selection.json`.**
  - Each write-scope matrix row gains `execution` (`inline` or `child`), `route` (R7) and one `reason` string.
  - When `approvePlan=true`, the supervisor first writes the matrix to `$STATE_DIR/plan-proposal.json`. Only an approved plan becomes `$SELECTION_FILE`.
  - This matters because Phase 0 resumes any prior run whose `selection.json` lists issues. An unapproved proposal must never be resumable.
  - Only the supervisor writes either file. Children receive their unit by value in the child prompt, as today.
  - A resolved natural-language selection is written to `$STATE_DIR/selector.json` (R2). Ralph iterations share `STATE_DIR`, because `RUN_KEY` is the task id, so they reuse it.
- **R5. `approvePlan`** is a new parameter, `false` (default) or `true`.
  - **`true` when interactive** (the existing gate reports `HEADLESS=0`): show the plan once and wait. Editing the plan produces a new `planVersion`. Declining it ends the run as `blocked` with reason `plan declined`.
  - **`true` when headless:** write `plan-proposal.json` only, with no `selection.json` and no per-issue blocker lines, so no issue is excluded later. End the run with `outcome: "blocked"` and reason `approval requested — plan in <selection.json path>; relaunch with issueSelector=<numbers> approvePlan=false to execute it`.
    - `blocked` already exists. The starvation refill consumes only `blocked-empty`, and a terminal run is never resumed by Phase 0.
    - The relaunch reproduces the plan exactly, because Slice A plans contain only single-issue units.
  - **No launcher sets `approvePlan` today**, so no schedule or automation changes.
  - `onAmbiguity` keeps its exact current values (`ask`, `auto-safe-subset`, `auto-stop`) and meaning.

### Efficiency

- **R6. Unit of work.** Slice A plans single-issue units only. The `UNIT_COUNT > 1` fail-closed guard stays as written.
- **R7. Routing**, copied from `agent-fleet-orchestration` and based on observable features only:

  | Feature | Route |
  |---|---|
  | 1 module, an acceptance criterion in the issue | `direct`: the child implements |
  | More than 1 module, OR failed before, OR no clear spec | `strong`: a child on a strong model, delivering alone, never batched with others |
  | Write-scope matrix shows more than 8 files, OR the issue is labelled `architecture` | `skip`, with reason "needs RFC/umbrella" |

  - Children run in parallel up to `maxConcurrentTasks`.
  - Children never spawn tasks.
  - The independent reviewer keeps the `independent-merge-review` strength floor.
- **R8. Efficiency rules**, stated once in the supervisor and copied into the child template:
  - look up the KB before exploring;
  - run the full gate once per head, concurrently with the independent review;
  - use targeted tests while fixing;
  - retry only the failing check;
  - make no unrelated edits.

  Each rule cites its skill: `token-efficiency`, `independent-merge-review` (ordering), and `agent-fleet-orchestration`.
- **R9. Measurement.** The outcome record gains `issuesDelivered`, `prsMerged` and `wallClockMinutes`. `parseBatchOutcomeRecord` ignores unknown fields, so these are additive. They are the baseline for deciding Follow-up B's defaults.

### Uncontested interactive bundles (consensus-attack revision)

- **R6a. When a bundle is allowed.** R6's single-issue-only rule is relaxed to allow a `bundle` unit when **all** of these hold:
  - **Approval:** `approvePlan=true` and the run is interactive, so a human approved the exact bundle.
  - **Uncontested repo:** no *other* autonomous launcher draws from this repo's pool. Specifically:
    - `GET /api/schedules` shows no enabled schedule whose parameters or prompt reference `$REPO`;
    - `GET /api/tasks` shows no other `inProgress` task, outside this run's own tree, whose parameters or prompt reference `$REPO`.
    - If either lookup fails, the repo counts as contested.
  - **Size:** 2–3 issues.
  - **No dependencies:** no issue depends on another in the bundle.
  - **One trust class:** all members come from trusted authors.
  - **Routing:** every member routes `direct` (R7).
- **R6b. How a bundle is delivered.**
  - **Inline, by the supervisor itself.** It never goes to a child, so the `UNIT_COUNT > 1` spawn guard and the child-template contract stay untouched.
  - **Claims and protection.** The supervisor claims the primary, assigns every member to `CURRENT_USER` (the queue feeder and the goal supervisor already skip assigned issues), and runs the parent-implementer bookkeeping, which records delivery ownership.
  - **Branch name.** It carries `issue-<N>` for every member, e.g. `fix-issue-12-issue-15-<slug>`, so IGI's open-PR regex matches each one.
  - **Implementation.** It follows `agent-fleet-orchestration` "Coding fleets": a spec per issue; one implementer subagent and one spec-only test-writer subagent per issue; the lead gates each issue on its blind tests; one commit per issue.
  - **PR.** One full gate, one independent review and one merge for the whole bundle. The PR body lists `Closes #N` only for delivered issues.
- **R6c. On a gate failure.** The supervisor drops the failing issue's commit, removes its assignment, and records the issue as returned to the pool; the rest ships. If the failure only appears when the commits are combined, the run delivers the members one at a time instead.
- **R6d. Contested repos.** Bundles there stay behind Follow-up B (server multi-claim). The playbook says so in the plan row's `reason`.

### Other

- **R10.** The dashboard shows the other-author prompt-injection warning for the PIB id as well as IGI's. PIB has the same `allowOtherAuthors` parameter (round-1 consumer map).

## Slices A1 and A2 — files to change

**A1 (PR 1)** covers R1–R5 and R7–R11. **A2 (PR 2)** covers R6a–R6d, the uncontested interactive bundles. A2 lands after A1, and after its own verification of the parent-fallback text, the API response shapes, the branch regex and assignment clean-up.

### A1

- `plugin/playbooks/parallel-issue-batch.md`:
  - display name and description;
  - Phase 2 selector (R1–R3);
  - Phase 3 plan fields (R4);
  - a new Phase 3a approval step (R5);
  - the routing table (R7);
  - efficiency rules in the supervisor and the child template (R8);
  - outcome metrics (R9);
  - parameter validation for `approvePlan`.
- `plugin/playbooks/implement-github-issue.md`: a description pointer to the front door.
- `src/frontend/components/PlaybookBrowser.tsx`, plus its test (R10).
- `src/core/parallel-issue-batch-playbook.test.ts`, with contract assertions for:
  - the reserved prefix rejection coming before natural language;
  - the numbers rule;
  - the natural-language branch being defined as "no qualifier token";
  - `resolvedNumbers` being frozen;
  - the `approvePlan` default `false`;
  - the headless approval exit writing `blocked` and not `blocked-empty`;
  - the `UNIT_COUNT` guard still present;
  - the routing table present;
  - the metrics fields.

  Existing assertions are unchanged.
- `src/core/playbook-parser.test.ts`: the display name.
- `docs/reference/kookr-self-batch-schedule.md`: the display name.
- `plugin/.claude-plugin/plugin.json`: version bump.

### A2
- `plugin/playbooks/parallel-issue-batch.md`: the inline bundle delivery path (R6a–R6d), extending the parent-implementer bookkeeping.
- Contract tests for the contention check, the assignment and its clean-up, the branch naming, and the unchanged `UNIT_COUNT` spawn guard.
- `scripts/parent-implementer-fallback-rehearsal.ts`, if its asserted text moves.
- `plugin.json`.

**Live effect.** The changes are:

- a display name;
- one new opt-in parameter;
- a recorded plan;
- routing and efficiency guidance in child prompts;
- metrics in outcome records;
- free-text keyword selectors going through the resolver (R3).

Neither live schedule uses a free-text keyword selector or sets `approvePlan`.

**Revert.** Revert the plugin version. Slice A persists no state that an older playbook misreads: `planVersion` and the metrics are additive fields.

## Follow-up B — multi-issue PRs on contested repos and headless runs (own RFC; prerequisite: server multi-claim)

These design inputs come from the three review rounds:

- **Claim model.**
  - A primary plus secondaries, replaced atomically on grant, which keeps "a new claim releases the old one" for Ralph.
  - Every key gets a relaunch-arbiter lease and cooldown, so a dead bundle's secondaries are not freed immediately.
  - Per-key release; forcing any member forces the whole set.
  - Provider-reset resume captures the whole set.
  - The boot rebuild tombstones a key held by two tasks.
  - `kookr spawn` and `kookr issue claim` take the set.
  - The registry owns a `ClaimSet` type, and consumers never read the field.
- **Discoverability.** The branch name carries `issue-<N>` for every member, or the duplicate check uses `closingIssuesReferences`, so IGI's open-PR regex and goal-supervisor's linked-PR filter both see every member.
- **Contract.** Bundle delivery (at most 3 issues, no dependencies, one trust class, one commit per issue, squash merge, `Closes` only for delivered issues) is defined once in IGI.
  - The child reports a typed outcome per issue.
  - The supervisor alone appends the new `planVersion`, for example splitting into singles after a gate failure.
  - The child template, the context pack (one body per member) and `pr_create_guard` are extended for N issues.
- **Policy.**
  - `allowBundles` is interactive-only until the multi-claim soak.
  - Approval binds to a `planVersion` reference, so approved bundles survive a relaunch.

## Follow-up C — one written delivery procedure (own issue)

- **Approach.** IGI gains an explicit **unit entry**, and PIB's child template invokes it.
  - **What the unit entry skips:** Phase 0 selection, Ralph/`.batch-stop`, self-continuation, and slot release.
  - **Its input:** the unit's numbers and merge parameters.
  - **What stays in the child prompt:** the merge header, `pr_create_guard`, `kookr issue owner` read-before-push, and the `children.json` delivery record, so `check_child_prompt` and the delivery-ownership validator keep enforcing them.
- **Gate.**
  - Contract tests on the generated child prompt.
  - Re-run `delivery-ownership-rehearsal` and `parent-implementer-fallback-rehearsal`.
  - One supervised canary batch on a sandbox repo, checked by hand against an explicit list of intended differences (`staging` base, branch naming, incident `Refs`).
- **Claims.** Supervised children keep the fail-closed claim check. IGI's "404 means claims disabled, so proceed" rule applies only to standalone IGI runs.

## Edge cases (Slice A)

- **Natural-language selector.**
  - Resolves to 0 issues: the run ends `blocked-empty` and records the commands it ran.
  - Resolves to more than `targetIssueCount`: it takes the top N by drain order and lists the rest as deferred in the plan.
- **Natural-language text that contains a qualifier**, such as `label:bug the 10 most recent`: it is classified as a filter (R1.4). That is deterministic. The plan shows the exact `gh` command, and the operator writes `label:bug sort:created-desc` with `targetIssueCount=10` instead.
- **Approval when the operator never answers:** the existing interactive wait applies. Only interactive runs can wait, and headless runs never wait (R5).
- **A Ralph loop or relaunch after a natural-language resolution:** it reads `resolvedNumbers`, so the selection cannot drift.

## Alternatives considered

- **IGI as front door (v1).** Rejected. A supervisor under the IGI id is invisible to the server's batch matchers. A child also cannot be launched as "IGI with parameters", because `--playbook` accepts prompt-wrapper playbooks only.
- **Bundles protected by an `in progress` label and a sticky comment (v3).** Rejected after round 3. Other launchers ignore the label, IGI's open-PR regex misses bundle branches, and a bundle skips its own secondaries.
- **Server multi-claim inside this RFC (v1, v2).** Moved to Follow-up B. It breaks a deliberate invariant and touches the relaunch arbiter, provider-reset resume and at least 10 consumers. It deserves its own reviewed design.
- **`KOOKR_LAUNCH_SOURCE` as the "human present" signal (v2).** Rejected. `cli` is also sent by the queue feeder, `kookr-supervise`, ops-digest and every detached spawn. An opt-in parameter has no such failure mode.
- **Removing `--admin` (v2).** Rejected. It appears only in the head-bound `never-executed` waiver, which IGI permits too.
- **Union of the label skip lists (v2, v3).** Rejected. It silently shrinks both live schedules' pools.

## Critic feedback incorporated

**Round 1** (`failure-mode-analyst`, `design-minimalist`, `ambition-amplifier`, `delivery-pragmatist`, `boundary-critic`; N=5):

- The evidence pack's claim that a task can hold several claims was wrong; corrected.
- PIB became the front door.
- The work was split into slices.
- Selector guards were added.
- Delegation bounds and metrics were added.

**Adversarial pair, round 1.** The minimalist won on sequencing. Ambition won on intent: one front door, swarm delegation, bundling.

**Empirical checkpoint after round 1.** Five load-bearing claims were verified in code. See the v2 section in git history.

**`ambition-amplifier` 2026-11-14:** novel findings.

**Round 2** (`failure-mode-analyst`, `boundary-critic`, `design-minimalist`, `socratic-challenger`; N=4):

- Server multi-claim deferred.
- Approval became opt-in, with `onAmbiguity` unchanged.
- Routing copied from the skill.
- The plan moved into a versioned `selection.json`.
- The rejection of `--admin` removal was verified.
- `auto-proceed` was corrected to the real `onAmbiguity` values.

**Round 3** (`failure-mode-analyst`, `delivery-pragmatist`, `boundary-critic`; N=3):

- **Label protection broken** (failure-mode 1–2): v3's bundles were dropped from this RFC and became Follow-up B, with the claim and discoverability inputs.
- **Runtime read defeats `check_child_prompt`; IGI is run-scoped** (failure-mode 3, boundary 1): Follow-up C with an explicit unit entry.
- **Headless approval exit** (failure-mode 4): it uses `blocked`, not `blocked-empty`. Approval binding to a `planVersion` matters only once bundles exist (Follow-up B).
- **Removing fail-closed for children** (failure-mode 5): Follow-up C keeps fail-closed for supervised children.
- **The R1 classifier was undefined** (failure-mode 7): defined deterministically as "no qualifier token means natural language".
- **The label union shrinks live pools** (delivery 2): dropped (Non-goals).
- **Slice 1 too big, IGI bundle code unused, unverifiable replay exit** (delivery 1, 4, 5): replaced by one small Slice A, plus follow-ups with executable gates.
- **Label ownership and the sweep** (boundary 4, failure-mode 8): moot once labels were dropped.
- **Rollback state** (delivery 6): Slice A persists only additive fields.

**general-purpose 2026-11-14: consensus attack — finding.** The panel assumed duplicate-delivery risk applies to every repo. In fact it applies only where another autonomous launcher draws from the same issue pool, as on kookr and lucy.

The motivating bundle was PR #1260 on a repo with no enabled delivery schedule and no queue-feeder coverage. The attack also confirmed that the queue feeder (`umbrella-decomposer.ts:388`) and the goal supervisor (L271-275) skip assigned issues. The RFC had never considered assignment as a protection.

**Incorporated in one revision, as R6a–R6d.** Interactive bundles are allowed on uncontested repos only. The supervisor delivers them inline, and they are protected by the primary claim, assigning every member, and parent bookkeeping. Contested repos still wait for Follow-up B.

**Intent preservation check.** The operator asked for five things:

| Ask | Slice A |
|---|---|
| One playbook | One front door |
| Swarm delegation | Parallel children with routing |
| Natural-language selector | Yes |
| Approvable plan | Yes |
| Bundling | Yes, for interactive runs on uncontested repos (R6a–R6d) |

Headless runs, and repos where other launchers compete for the same issues, wait for Follow-up B. That is an explicit trade-off, not a silent drop.
