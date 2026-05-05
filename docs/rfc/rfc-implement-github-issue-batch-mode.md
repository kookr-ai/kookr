# RFC: Batch-Mode for the Implement GitHub Issue Playbook

**Status:** Draft (v9 — post-v8 review)
**Date:** 2026-05-05
**Author:** Jean Ibarz (with Claude)

(See git history for v1–v8 design iterations and the round-by-round critic record.)

---

## Problem

The `implement-github-issue` playbook accepts one `issueId` and walks a single issue from "read it" to "open a PR". Run inside Kookr's Ralph loop the same prompt is replayed every iteration, so the loop happily re-implements the same issue forever.

The user wants to drive the playbook through a **batch of issues** with one launch — either an explicit list (`50, 565, 566, 517, 518`) or a GitHub filter (`label:bug,enhancement`). On each iteration the agent should pick a not-yet-shipped, not-burned-out candidate from the batch, ship a PR, then stop and let Ralph re-fire.

## Design philosophy

Playbook content change, not an engine feature. The canonical Ralph pattern is "read external state, do one unit of work, stop." The agent's source of truth is `gh pr list`; the only local state is a one-column append-only attempt counter so the loop terminates cleanly when one issue is permanently broken.

## Requirements

1. The playbook accepts a selector matching three shapes: blank (legacy single-issue), explicit ID list, GitHub filter.
2. Existing single-issue launches continue to work — the legacy "blank → most recent open" path is preserved by the digit-only heuristic.
3. Looped launches process the batch one PR per iteration and stop when nothing remains.
4. An iteration must skip issues already covered by an open PR opened by a previous iteration, including under the GitHub search-index lag window.
5. A typo or malformed selector must fail loudly with a clear message.
6. A hot-loop on a permanently-broken issue must terminate after a small bounded number of attempts so other issues in the batch still ship — by **mechanical** count, not by the agent self-judging "did I try this before?" across Ralph re-injections that wipe its short-term context.
7. Hitting iteration cap or cost cap with issues remaining must be observable.
8. The playbook is `loopable` per RFC `rfc-loopable-playbook-workflows.md` (#533) so the dashboard offers `Run looped`.
9. Implementation is one PR — playbook content + (conditionally) parser/wiring fallback.
10. A workdir reused across launches must not silently inherit stop signals from a prior run.

## Hard preconditions

This RFC's loop cannot terminate cleanly without one engine-side piece on top of #533:

- **P1 — `stopPredicate` field on `EffectivePlaybookLoop` and propagation through `buildPlaybookRalphLoopRequest`.** `src/shared/contracts/playbook.ts:31-40` (`EffectivePlaybookLoop`) and `:25-29` (`PlaybookLoopConfig`) have no `stopPredicate`. `src/server/use-cases/looped-playbook-launch.ts:118-129` doesn't copy it into `RalphLoopRequest`. The cycler executor at `src/core/ralph-cycler.ts:122-136` already exists and is correct. Estimated work: ~30 lines (type field + parser pickup + request copy).

- **P2 — predicate stays single-line in frontmatter.** Round-4 review verified the existing `parseLoopConfig` in `src/core/playbook-parser.ts:133-144` does NOT support YAML block scalars (`stopPredicate: |\n    body`); a `|` is parsed as the literal string `"|"` and the continuation line is silently dropped. v9 keeps the predicate to a single line so this RFC does not impose block-scalar parser work on #533.

The predicate body fits comfortably on one line:

```yaml
stopPredicate: 'test -f .batch-stop && grep -qE "^STOP:" .batch-stop'
```

**Action before this RFC's PR opens.** Confirm P1 is in #533's PR (preferred — keeps engine code in one PR) or absorb it into this RFC's PR (~30 lines in `playbook.ts`, `playbook-parser.ts`, and `looped-playbook-launch.ts`).

The previously-stated hard precondition (#533 merged + Kookr restarted) still holds — without it, the new frontmatter parses as unknown keys and the playbook launches as a one-shot.

## Design

### Frontmatter

```yaml
parameters:
  - name: issueSelector
    type: textarea
    description: "Blank (most recent), issue numbers (50, 565, 566), or filter (label:bug)"
  - name: repo
    description: "GitHub repo (owner/name); blank = current"
tags: [workflow, loopable]
loop:
  iterationCap: 10
  costCapUsd: 25
  stopPredicate: 'test -f .batch-stop && grep -qE "^STOP:" .batch-stop'
```

The attempt cap is hardcoded to 3 in the prompt body. Round-4 dropped the v8 `attemptCap` frontmatter knob — wiring it through `PlaybookLoopConfig` / `EffectivePlaybookLoop` / `buildPlaybookRalphLoopRequest` would expand P1's scope, and the alternative ("agent reads a comment in the playbook body") is non-mechanical and contradicts requirement 6. If real-world data shows 3 is wrong, expose the knob in a follow-up that adds the engine wiring.

### Selector resolution (described to the agent)

Read `{{issueSelector}}`, trim, take the first non-blank non-comment line. Tokenize: split on `[,\s]+`, drop empties, dedup preserving order.

- **Empty after tokenize** → blank shape, fall back to legacy "most recent open" via `gh issue list --state open --limit 1 -R "{{repo}}"`. Ship one PR. Single-shot path does **NOT** write `.batch-stop`.
- **Every token matches `^#?\d+$`** → list shape, candidate set is the deduped integer list.
- **Otherwise** → filter shape, candidate set is `gh issue list --state open --limit 100 -R "{{repo}}" --search "<original line>"`.
  - Reject the filter (write `STOP: FAILED — <reason>` and stop) if it contains any of these state-or-repo operators that would collide with the frontmatter-supplied flags: `repo:`, `state:`, `is:`, `archived:`, `linked:`. The check is per-token after splitting on whitespace, so `is:open` is rejected while a hash like `#is:bug` is not.
  - Empty result: `STOP: FAILED — selector resolves to no open issues`.

### Per-iteration pick algorithm (mechanical)

The agent runs the following on every iteration before any other work. Each step is described in the prompt; the agent uses bash to execute.

**Step 0 — workdir hygiene.** `rm -f .batch-stop`. Unconditional, every iteration. If `.batch-stop` exists at the start of an iteration it is either (a) leftover from a prior single-shot or aborted run in the same workdir, or (b) the predicate already fired and Ralph would not have re-run the agent — so it can never legitimately exist at iteration start. Removing it unconditionally protects against stale-file contamination without needing to detect "is this iteration 1."

1. **Resolve the selector** to the candidate set (see above).

2. **For each candidate `N` in selector order:**
   - **Issue is open?** `gh issue view N -R "{{repo}}" --json state` must report `OPEN`. Treat 404 or CLOSED as permanently done — skip silently and continue. Treat 5xx, network errors, or timeouts as transient: do **not** record an attempt, do **not** skip the candidate; try the next candidate. If a sustained partial outage starves one specific candidate (always transient on N, others succeed), the iteration cap eventually fires and the operator investigates via the `iteration_cap` exit reason. v9 accepts this bound rather than adding per-candidate transient counters. If **all** candidates trip transient errors in a single iteration, write `STOP: FAILED — gh issue view transient: <last-error>` and stop.
   - **No matching open PR?** `gh pr list -R "{{repo}}" --state open --json number,headRefName --limit 100`, filter client-side for any `headRefName` matching `(^|[-_./])issue[-_.]N([-_.]|$)`. If a match exists, an earlier iteration shipped this — skip silently and continue.
     - **Safe-invocation contract.** Do **not** add `--search`, `--author`, `--label`, `--draft`, or `--assignee`. Any of those silently switches to the lag-prone GitHub Search backend.
     - The regex covers the common separators (`-`, `_`, `/`, `.`). Branch names using exotic separators (`+`, `~`, `:`) will not match and produce a duplicate-PR false negative. Documented in Edge cases.
   - **Attempts under cap?** `[ "$(grep -c "^N$" .batch-attempted 2>/dev/null || echo 0)" -lt 3 ]`. If at or above the cap, skip silently and continue.
   - First candidate passing all three is the target.

3. **No target?** Write `STOP: COMPLETE` to `.batch-stop`, stop.

4. **Record the attempt** before any side effects: `echo "$TARGET" >> .batch-attempted`.

5. **Implement the target** via the existing Phases 1-7 (worktree, code, tests, PR creation). End with `gh pr create`. Then stop — Ralph will re-fire.

The agent does **not** judge "have I tried this twice"; the count check in step 2c does. After a Ralph re-injection the agent has no memory of prior iterations, so any judgment-based scheme is unreliable.

### Stop signal — `.batch-stop` file

The predicate reads a workdir file. The agent writes one of:

- `STOP: COMPLETE` — all candidates shipped or skipped by exhaustion.
- `STOP: FAILED — <one-line reason>` — selector validation failed, `gh` exhausted by transients, etc.

The predicate `test -f .batch-stop && grep -qE '^STOP:' .batch-stop` is true only when the file exists and contains a STOP line.

The single-shot legacy path does NOT write `.batch-stop` — there is no `stopPredicate` running in non-Ralph mode and writing the file pollutes the workdir for subsequent looped launches.

### What the engine does NOT change

- `src/core/tasks.ts` — `RalphLoopState.stopPredicate` is already typed.
- `src/server/launch-service.ts` — unchanged.
- No new HTTP routes, WebSocket messages, or MCP tools.

### What changes

`.kookr/playbooks/implement-github-issue.md` — rewritten:

- Parameter `issueId` → `issueSelector: textarea`. **All `{{issueId}}` references in the body are replaced** — no legacy alias.
- Frontmatter gains `tags: [workflow, loopable]` and the `loop:` block.
- Body gains the mechanical pick algorithm above as a new Phase 0; Phases 1-7 (existing implementation flow) read from the agent's selected `TARGET` shell variable.
- Anti-patterns gains:
  - **Don't put dependent issues in one selector** — branches diverge from `main`, 566 won't see 565's open PR.
  - **Don't pre-create branches matching `*-issue-N-*`** for issues you don't want the agent to touch — the PR check will skip them. Use `gh issue close N` if you want it permanently out of the batch.
  - **Don't edit `.batch-attempted` by hand** mid-loop — append-only is the contract.
  - **Don't relaunch against an existing `.batch-attempted` if you want a fresh start** — `rm .batch-attempted` first. (`.batch-stop` is auto-cleaned by Step 0.)
  - **Don't add `--search`, `--author`, `--label`, `--draft`, or `--assignee`** to the duplicate-PR check.

The conditional ~30-line absorption (if RFC #533 hasn't merged P1) lands in `src/shared/contracts/playbook.ts`, `src/core/playbook-parser.ts`, and `src/server/use-cases/looped-playbook-launch.ts`.

## Files to change

- `.kookr/playbooks/implement-github-issue.md`
- `docs/rfc/rfc-implement-github-issue-batch-mode.md` (this RFC)
- (Conditional on P1 not in #533's PR) ~30 lines split across:
  - `src/shared/contracts/playbook.ts` — add `stopPredicate?: string` to `PlaybookLoopConfig` and `EffectivePlaybookLoop`.
  - `src/core/playbook-parser.ts` — pick up `loop.stopPredicate` from frontmatter.
  - `src/server/use-cases/looped-playbook-launch.ts` — copy `stopPredicate` into `RalphLoopRequest` in `buildPlaybookRalphLoopRequest`.

## Edge cases

- **Closed issue in the selector.** Step 2a detects → skip silently.
- **Issue in a different repo.** All `gh` calls use `-R "{{repo}}"`. Out-of-repo IDs return 404 → skip silently.
- **Filter contains forbidden operator** (`repo:`, `state:`, `is:`, `archived:`, `linked:`). Validation rejects with `STOP: FAILED`.
- **Filter resolves to >100 issues.** No upfront cap — the iteration cap fires. Operator sees partial work in `gh pr list` and an `iteration_cap` exit reason in the dashboard, then either bumps `iterationCap` or splits the residue.
- **GitHub search-index lag after `gh pr create`.** Step 2b uses `gh pr list` without search-flag (GraphQL `repository.pullRequests` — strongly consistent).
- **Repo with >100 open PRs.** `gh pr list --limit 100` may not include the just-created PR if pagination order pushes it off page 1. Known limitation; relaunch fresh in repos at this scale.
- **Branch names with exotic separators** (`+`, `~`, `:`). The headRefName regex misses these, producing a duplicate-PR false negative. Documented anti-pattern is to avoid such separators in agent-managed branches.
- **Crash mid-`gh pr create`.** Either the PR exists (next iteration's step 2b finds it, skips) or it doesn't (step 2c counts the attempt; on the third pick of the same issue, it gets skipped). Bounded by the cap.
- **Crash between step 4 and step 5's worktree creation.** Phantom attempt: `.batch-attempted` shows N once with no work done. With cap=3, one phantom + two genuine flakes = skip. One phantom + one genuine = retry.
- **Phase 3 worktree collision** (existing pre-check). The collision aborts the iteration after step 4; the attempt is recorded; after three collisions the issue is auto-skipped.
- **`gh issue view` 5xx / timeout / network error.** Transient: do not record an attempt, try next candidate. If all candidates trip transient errors in a single iteration, `STOP: FAILED — gh issue view transient`. Sustained partial outage on a single candidate: bounded by `iterationCap`.
- **Same issue fails twice on tests.** Both attempts are in `.batch-attempted`; third attempt happens; if it also fails, fourth pick is filtered out by step 2c.
- **Broken `gh` from iteration 1.** Step 2a's first `gh issue view` fails. Loop terminates with `STOP: FAILED` after one iteration.
- **The user edits the selector mid-loop via Ralph's prompt-edit.** New selector is read on next iteration. `.batch-attempted` carries forward, so any issue already at cap stays skipped — even under the new selector. For a true reset, `rm .batch-attempted`.
- **iterationCap reached with issues remaining.** No `.batch-stop` file written; engine terminates on cap. Operator sees `iteration_cap` exit reason in dashboard plus partial `gh pr list` history. Relaunching the same task continues from `.batch-attempted` state.
- **Blank selector in looped mode.** First iteration ships one issue, exits without writing `.batch-stop`. Loop hits `iterationCap` if relaunched against the same selector — by then a new "most recent open" is picked.
- **Stale `.batch-stop` from a prior single-shot or aborted run.** Step 0's unconditional `rm -f .batch-stop` deletes it.
- **Aborted batch run leaves `.batch-attempted` + stale `.batch-stop`.** Step 0's unconditional `rm -f .batch-stop` handles the stop file. The operator's `.batch-attempted` carries forward (intentional, so a relaunch picks up where the prior run left off). For a true reset, `rm .batch-attempted` per anti-pattern.
- **#533 merged but Kookr not restarted.** Frontmatter ignored, playbook launches as a one-shot. The agent reading `{{issueSelector}}` (now an unrecognized parameter to the old parser) sees the literal string `{{issueSelector}}` and emits `STOP: FAILED — selector parameter not interpolated; restart Kookr after upgrading`.

## Open questions

- **O1: real batch composition.** Are real batches independent typo-fixes or sub-issues with implicit dependencies? Action before declaring v1 complete: scan the user's recent issue tracker. If batches are dependency-heavy, the explicit-list shape may need a fail-loud detector for consecutive issue numbers (often sub-issues run in sequence).
