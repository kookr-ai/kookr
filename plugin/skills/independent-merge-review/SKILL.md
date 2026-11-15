---
name: independent-merge-review
group: agent-automation
description: Before an autonomous self-merge, spawn a fresh-context reviewer (Codex lane, Claude fallback) that posts a machine-readable exact-head PR verdict. Hard merge gate on kookr-ai/kookr; advisory evidence on repos that document review as advisory.
keywords: independent review, merge gate, self-merge, reviewer verdict, codex reviewer, claude fallback, review-skipped-timeout, before merge, autonomous merge, advisory review
related: pre-pr-review, pr-review-triage, git-commit-discipline
---

# Independent Merge Review

> **Requires:** the reviewer specialists at `plugin/reviewer-specialists/` (issue
> #1717). On `kookr-ai/kookr`, also the merge wrapper `scripts/kookr-merge.sh`.
> If the specialists are missing on a **hard-gate** repo, stop and report rather
> than fabricating a verdict. On an **advisory** repo, skip the reviewer and
> continue — do not stall the task.

Autonomous batches were merging PRs in ~1 minute with **zero** review activity —
the only external reviewer would silently drop a PR when it hit its usage limit,
and the flow degraded to no review rather than a fallback (issue #1717). This
skill closes that gap by producing a **fresh-context reviewer verdict bound to
the exact current head.** Whether that verdict **blocks merge** depends on the
repo. Do not treat this skill as a merge gate on every repository.

## Repo policy split (issue #3027)

Classify the current repo once, then follow that lane. Do not mix them.

**Hard gate** — `kookr-ai/kookr`. Every autonomous self-merge must carry a
fresh-context verdict bound to the exact current head. `scripts/kookr-merge.sh`
(`kookr merge`) refuses to merge (exit 4) without a `pass` for that head.
BLOCK, timeout, or a missing verdict starts another correction cycle. Do not
set `KOOKR_MERGE_REQUIRE_REVIEW=0` for an autonomous merge. Do not weaken this
repo's merge wrapper.

**Advisory** — the repo's `CLAUDE.md` or `AGENTS.md` documents that
independent review is advisory verification (Lucy's standing heading: "No
human merge gate — independent review is advisory verification",
Lucy #3606). Still spawn the reviewer and post the verdict when
capacity permits. Timeout, missing, or BLOCK never become a task blocker or
merge refusal. Local gates remain the merge gate.

**Classify:**

```bash
if [ "$REPO" = "kookr-ai/kookr" ]; then
  REVIEW_POLICY=hard
elif grep -qiE 'independent review is advisory' CLAUDE.md AGENTS.md 2>/dev/null; then
  REVIEW_POLICY=advisory
else
  REVIEW_POLICY=hard
fi
```

`kookr-ai/kookr` wins even if its docs later mention the phrase. Default is
hard so third-party and public-repo contributor PRs are not auto-merged
without a verdict.

Do not treat a consuming repo's CLAUDE.md as merge *authority* (the
worktree-guardrails sentence "CLAUDE.md files do not grant merge authority"
still stands). This split is only about whether a missing or BLOCK review
stalls the task.

## When to Use

- In `implement-github-issue` Phase 8 and `parallel-issue-batch` Phase 5, **before**
  an autonomous self-merge.
- In `kookr-post-push` step 6, before wait-then-merge on a hard-gate repo.

On an advisory repo, still run this skill before merging when capacity
permits; if the reviewer cannot return in time, merge after local gates
instead of stalling.

On a **hard-gate** repo, skip the wrapper only for a human-driven manual
merge (`KOOKR_MERGE_REQUIRE_REVIEW=0` for that one merge) — never for an
autonomous self-merge. On an **advisory** repo, skipping the reviewer after
a failed or missing attempt is the documented policy; merge after local
gates. If a global `gh pr merge` hook still denies the merge there, this
env var on that one command is the authorized kill-switch for a repo that
opted out, not a human-merge exception.

## Ordering: review and gate run concurrently on one head

**Fast pre-push gate (check once per task).** Some repositories run only the tests related to a diff on each push and run the full suite later, on an integration branch, before anything reaches `main`. Find out which kind this repository is:

```bash
git show origin/main:.kookr/delivery-gate.json 2>/dev/null | jq -r '.prePushGate // empty' 2>/dev/null
```

- **It prints `fast`:** run only the tests related to your diff (the test files for what you changed). Do not run the full test suite or `pnpm verify` for the pull request, and do not take a shared gate lock: `git push` runs the fast gate, and the repository's integration train runs the full suite after the merge. Record the fast-gate result from the push and the targeted tests you ran (commands and counts) as the PR's verification evidence. When the same file also names an `integrationBranch`, the merge wrapper (`kookr merge`) retargets the PR to it; "merged" then means merged there, the task is done at that point, and the linked issue closes when the train promotes the change to `main`.
- **It prints anything else, or nothing (no such file):** keep the full-suite steps below unchanged.

With a fast pre-push gate, "the gate" below is the push's fast gate (static
checks plus related tests), not a full-suite run; the rules otherwise apply
unchanged. Without one, the gate is the full gate.

In the session data behind #3691 (135 delivery sessions), a reviewer was active
for only 0.3–4 min per round, while the full gate took 10–16 min. The time was
lost by running review *after* the gate and then re-running the gate on the
head review changed (#3692). The rule:

1. Once the diff is final (head H) and the PR exists, start the reviewer **and**
   the full gate on H together. Run the gate in the background (for kookr:
   `git push` with `run_in_background`, which runs the pre-push gate). Draft
   the PR body in the same window.
   **The CI watcher and the reviewer also run in parallel:** start watching the
   PR's checks (`gh pr checks --watch`, or `pnpm check-verification` polling)
   in the background at the same time as the reviewer. Never wait for CI to
   finish before starting the review, or for the review before watching CI.
2. On a hard-gate repo, merge needs both a green gate and a `pass` for H. On an
   advisory repo the verdict is evidence only (see the policy split above).
3. A green full gate that already ran on H before the PR was opened counts; do
   not run it a second time. The gate runs once per head, never once per fix.
4. Any change that is not a delta-eligible edit (next section) makes a new head
   H'. H' needs a new review and a new full gate. While fixing, iterate with
   targeted tests (`pnpm test:changed` or the touched files).
5. Wait only on a notification, PID, or exit-marker file (see §5), never a
   `pgrep -f` loop.

Before the PR exists there is no `$PR` to post a verdict on. With a fast
pre-push gate, this reviewer is the only review (`pre-pr-review` §8, "One review
pass"): start it at the first commit, before the PR exists, and post its
verdict once the PR is open. Without a fast pre-push gate, the `pre-pr-review`
specialist panel covers the stage before the PR.

## Delta re-review after a PASS

**Amending after a PASS usually invalidates it.** A PASS binds to the exact
`review-head-sha`. `git commit --amend`, a rebase, a squash, or any new commit
produces a different sha, so the old PASS no longer applies — even when the
content looks unchanged — and `kookr merge` refuses it. One exception: when the
PASS carries `review-patch-id:` and a rebase left every file the PR changes
untouched, the patch id still matches and `kookr merge` accepts the PASS with no
new review. Do not request one: a later head with the same `review-patch-id` as
the latest PASS is already reviewed. After any other change,
run a new review for the new head (a full review, or the delta review below
when it qualifies). Never re-post or edit an old PASS with the new sha.

A PASS binds to one head. After a PASS, if the only change since the reviewed
head is a **comment-only or typo-only edit** (no executable code, test, config,
skill/playbook/`CLAUDE.md` text, hook or script file, or documented contract such
as an API reference), the next verdict may come from a **delta review**:

- The implementer gives the reviewer the last-PASS sha. The reviewer checks it
  against the latest `pass` comment, reads only `git diff <that-sha>..HEAD`, and
  returns BLOCK if the diff is outside this category.
- The reviewer is still fresh-context at the §2 strength and posts the normal
  verdict comment, including `review-lane` and the new `review-head-sha`. The
  merge wrapper still needs that exact-head `pass`.
- The full gate is **not** re-run for such an edit; the earlier green run stands.

Without a `review-patch-id:` line on the PASS, a rebase gets the same treatment only when the sole change is the PR's own
`plugin.json` version line re-bumped after a conflict, and none of the commits
pulled in from `main` touch files the PR touches. Anything else, including docs
that define agent behavior or a contract, needs a full review and gate.

## The verdict comment contract

The reviewer posts **one** PR comment whose body carries these machine-readable
lines (the merge gate and the `review:coverage` metric parse them; the literals
live in `src/core/independent-review.ts`):

```
<!-- kookr-independent-review -->
kookr-review-verdict: pass        # or: block
review-lane: codex                # or: claude
review-head-sha: <full HEAD sha the reviewer actually reviewed>
review-patch-id: <id>             # only when the repo has scripts/review-patch-id.sh

## Independent reviewer verdict: PASS
<one-paragraph summary; for BLOCK, a numbered list of confirmed findings>
```

**`review-patch-id:` (optional).** When the repository has
`scripts/review-patch-id.sh`, also record the id of the exact file versions the
PR changes: `git fetch origin <base>` then
`bash scripts/review-patch-id.sh origin/<base>`, where `<base>` is the PR's base
branch. It lets the `pass` survive a rebase that does not touch the files the
PR changes, so a moved head does not force a second review. Omit the line when
the script is absent.

On a **hard-gate** repo, the merge wrapper depends on:

- **`kookr-review-verdict: block`** ⇒ merge is refused (exit 4). An explicit
  block is never overridden by the timeout label.
- **`kookr-review-verdict: pass`** with a `review-head-sha` matching the PR's
  current head ⇒ merge allowed. A missing or older binding is refused — re-run
  the reviewer after any new commit.
- A **`block` is sticky for the exact head it reviewed**: a later `pass` bound to
  that same `review-head-sha` (a re-poll of identical content) does **not** clear
  it — the merge is refused (`sticky-block`). Only a **new commit** with its own
  fresh `pass` clears a block.
- The **latest** verdict comment wins **across heads**, so the fix-and-re-review
  loop is honored: block → fix (new commit) → post a fresh `pass` for the new head.

On an **advisory** repo those lines are evidence. Post them when the reviewer
returns; do not refuse merge or stall the task if they are missing, stale, or
`block`.

## Protocol

### 1. Stage the diff and pick the lane (with fallback)

Capture the diff the reviewer will judge and the exact head it reviews:

```bash
HEAD_SHA="$(git rev-parse HEAD)"
BASE="${BASE_REF:-origin/main}"
git diff "$BASE"...HEAD > /tmp/kookr-review-$PR.diff
```

Choose the reviewer lane. **Codex is the primary lane; Claude is the fallback.**
On a hard-gate repo, zero-review merges must stay unreachable when Codex is
rate-limited.

**Why this lane order (do not mistake it for a cross-vendor guarantee).** The
value this review adds is **fresh context + exact-head binding + the hard gate**
— an independent pass that the implementer's narrative cannot steer, bound to
the sha that actually merges. It is **not** a claim that a *different vendor*
catches more bugs: re-slicing 591 verdicts by implementer vendor found no
cross-vendor effect (same-vs-cross 5.6% vs 3.1%, p=0.20), and the clearest
real catch was fully same-vendor. Codex is primary only for **availability**
(so the Claude fallback keeps zero-review merges unreachable), not because
same-vendor review is weaker. A same-vendor fallback is therefore acceptable —
**provided it runs at the strength floor in §2**, which is the real protection.

- **Codex lane (primary):** run the lane script (below); from inside Codex,
  `spawn_agent` or a `codex-cli` child task also work. If Codex is **unavailable or
  rate-limited** — the script exits 3, the spawn errors, the agent reports a
  usage/quota limit, or it returns no verdict within the budget below — **fall
  back to the Claude lane** at once; do not retry Codex. On a hard-gate repo, do
  not degrade to no review. On an advisory repo, if both lanes fail, continue to
  merge after local gates.
- **Claude lane (fallback):** spawn a Claude reviewer subagent via the `Agent`
  tool.

Record which lane produced the verdict in `review-lane:`. On fallback, record
the reason the script printed.

**Codex lane script.** Do not call `codex exec` by hand. Write the reviewer
prompt (§2) to a file and run it as below. The prompt must name the diff file by
path rather than inline it: the script refuses a prompt over 100 KB (exit 2).

```bash
LANE_SCRIPT="${CLAUDE_PLUGIN_ROOT:-plugin}/skills/independent-merge-review/scripts/codex-review-lane.mjs"
node "$LANE_SCRIPT" --prompt-file /tmp/kookr-review-$PR.prompt.md --repo-dir "$PWD" \
  > /tmp/kookr-review-$PR.codex.md
case $? in
  0) LANE=codex ;;   # reviewer's final message is in the .codex.md file
  3) LANE=claude ;;  # Codex unusable here (reason on stderr): use the Claude lane now
  *) echo "lane script usage error"; LANE=claude ;;
esac
```

The script closes stdin (`codex exec` otherwise waits on "Reading additional
input from stdin..." until killed), passes the model from
`KOOKR_CODEX_REVIEW_MODEL` (unset = Codex's configured default), and makes a
short preflight call first (`KOOKR_CODEX_REVIEW_PREFLIGHT_TIMEOUT`, default 25 s).
The review call always runs at high reasoning effort, whatever the host's Codex
config says, to hold the §2 strength floor.
A model the API rejects (`model_not_found`), a quota error, a hung preflight, a
failed or timed-out review (`KOOKR_CODEX_REVIEW_TIMEOUT`, default 570 s so the preflight plus the review fit the 10-minute budget in §5), or a
missing `codex` binary all exit **3**. Choosing the host's default Codex model is
an operator setting, not part of this skill.

**Sandbox needs bubblewrap on Linux.** The script runs Codex with
`--sandbox read-only` (`KOOKR_CODEX_REVIEW_SANDBOX` overrides). On Linux, Codex
runs its tools through bubblewrap (`bwrap`), and without it the run aborts with
no verdict (agents have reported this even with `danger-full-access`). So when `bwrap` is not on `PATH`
the script exits 3 before calling Codex: take the Claude lane, record
"Codex lane unavailable: bubblewrap not installed", and tell the operator that
installing the `bubblewrap` package enables the Codex lane. Do not work around it
by dropping the sandbox.

### 2. Spawn the reviewer FRESH-CONTEXT (blind to the implementer)

The reviewer MUST run in a **fresh context with no shared session** with the
implementer — it sees the diff, the issue, and the repo, but **not** the
implementer's reasoning, plan, or self-report. That independence is the whole
point: a reviewer told "the author says this is fine" is not an independent
check.

**Strength floor (do not spawn a weak reviewer).** This is the gated,
defect-catching pass — spawn it at **full reviewing strength**: the lane's
strong default reasoning model at high effort (the Codex reviewer at its
standard high-reasoning setting; the Claude fallback on the session's strong
default model — e.g. an Opus-class model — **never** a cheap/nit-tier model
such as the one the `pre-pr-review` `lint-like` lane now runs on). The reviewer
is never downgraded to save tokens: a cheap pass here would silently weaken the
one hard merge gate, and under a Codex outage the same-vendor Claude fallback is
only safe *because* it holds this floor. If you cannot spawn at the floor, treat
it as a reviewer failure (fall back / timeout path), not as a cheaper review.
The one exception is the lint-level pass for a docs-only or test-only diff in a
fast-gate repository (`pre-pr-review` §8, "One review pass"), which may run on
the cheap `lint-like` model.

Reuse the reviewer-specialist prompts (`plugin/reviewer-specialists/`), at
minimum `correctness-specialist.md`, prefixed with the fan-out marker header
(see `pre-pr-review` §8). With a fast pre-push gate, this reviewer replaces the
panel, so include every body `select-specialists.sh` selects (`correctness`,
`test` when listed, and the `lint-like` bodies) and ask for one labelled
verdict per concern. Give the reviewer only:

- `{repoDir}` — the worktree path
- the staged diff (`/tmp/kookr-review-$PR.diff`) and changed-file list
- the issue number/body (acceptance criteria) — the *requirements*, not the
  implementer's narrative

**Never give the reviewer the pre-PR review pack** (the `--review-out` file
from `kookr context-pack`, e.g. `/tmp/issue-<N>.review.md`) or any other
context pack. That pack is written for the implementer's own specialists and
carries the implementer's summaries and framing; a reviewer that reads it is no
longer blind to the implementer. Build the reviewer prompt only from the three
inputs above.

Instruct the reviewer to return a verdict:

- **BLOCK** if it finds any **confirmed** correctness or safety defect (a bug it
  can point at with a concrete failure scenario, not a style nit or a
  speculation).
- **PASS** otherwise. Suggestions and nits do not block — note them, verdict
  stays PASS.

When the reviewer replaces the panel (fast pre-push gate), it also BLOCKs on
the findings the panel used to block on: a changed runtime path with no test
that exercises it, documentation the diff made stale, and a convention break
or dead code the diff introduced. Each finding in a BLOCK is tagged
**critical** or **non-critical** by the reviewer, not by the implementer:

- **critical:** a correctness defect (wrong behaviour with a concrete failure
  scenario), possible data loss, or a security weakness.
- **non-critical:** everything else, including missing tests, stale docs,
  conventions and dead code.

Also tell the reviewer how many `kookr-review-verdict: block` comments the PR
already carries, and pass it those comments. They are reviewer output, not your
reasoning, so the reviewer stays blind. From the third review on, the round
cap in §4a applies.

### 3. Post the verdict comment

Translate the reviewer's result into the contract above and post it:

```bash
# Patch id of the reviewed diff, only where the repo ships the script.
PATCH_ID_LINE=""
if [ -f scripts/review-patch-id.sh ]; then
  BASE=$(gh pr view "$PR" --repo "$REPO" --json baseRefName --jq .baseRefName)
  git fetch --quiet origin "$BASE" \
    && PATCH_ID=$(bash scripts/review-patch-id.sh "origin/$BASE" "$HEAD_SHA") \
    && PATCH_ID_LINE="review-patch-id: $PATCH_ID"
fi
cat > /tmp/kookr-verdict-$PR.md <<EOF
<!-- kookr-independent-review -->
kookr-review-verdict: ${VERDICT}      # pass | block
review-lane: ${LANE}                  # codex | claude
review-head-sha: ${HEAD_SHA}
${PATCH_ID_LINE}

## Independent reviewer verdict: $(printf '%s' "$VERDICT" | tr '[:lower:]' '[:upper:]')
${SUMMARY_AND_FINDINGS}
EOF
gh pr comment "$PR" --repo "$REPO" --body-file /tmp/kookr-verdict-$PR.md
```

### 4. Resolve a BLOCK before merging (hard-gate only)

On a **hard-gate** repo, BLOCK refuses the merge. For **each** confirmed
finding, do exactly one:

- **Fix it** — implement the fix, commit, push. The head SHA changes, so you MUST
  re-run this skill (step 1) and post a fresh verdict for the new head.
- **Rebut it** — if the finding is wrong, post a PR comment explaining why, then
  re-run the reviewer so it can confirm and post a fresh `pass`. A rebuttal is
  not a merge authorization on its own; only a `pass` verdict is.

**Whole-class fixes.** If a second BLOCK round names the same defect class as
the first (for example "unquoted path" or "missing null check"), do not fix one
instance and re-review. Spawn a new fresh-context reviewer, give it only the
class name from the BLOCK comment, and ask it to list **every** instance in the
lines the PR changes, plus other call sites of the same function or the same
pattern in files the PR touches. It returns a list, not a verdict. Fix them all,
then request the next review; that review is the counted §6 iteration. From
review 3 on this applies only to a critical class, because the §4a round cap
turns the other classes into follow-up issues.
In the #3691 sample, one PR took 12 BLOCK rounds and another 8, each round
finding one more instance of the same class (analyst-reported).

Never edit an old BLOCK comment to say pass — post a new verdict comment; the
gate reads the latest.

On an **advisory** repo, post the BLOCK as evidence. Do not stall or refuse
merge because of it. Fix confirmed findings when they are cheap and clearly
right; otherwise merge after local gates and leave the BLOCK on the PR.

### 4a. Round cap: two blocked rounds, then only critical findings block (hard-gate)

Of 56 reviewed pull requests in the 10–15 Nov 2026 sample, 13 were blocked at
least once, and those then took a median of 3 rounds (mean 4.1). Most of the
extra rounds were spent on findings that could have waited. The rule:

1. **Count the rounds from the PR, not from memory.** The round count is the
   number of `kookr-review-verdict: block` comments on the PR. Give the
   reviewer that count with the comments (§2).
2. **Reviews 1 and 2** block on any blocking finding, critical or not (§2).
3. **From review 3 on** (the PR already carries two or more BLOCKs), only
   **critical** findings block. The reviewer lists every non-critical finding
   under `Follow-ups`, each with a short issue title and a body that names the
   file, the line and what is wrong. With no critical finding, the verdict is
   `pass`.
4. **The relaying session files the follow-ups before posting the verdict.**
   The Codex lane runs read-only, so the session that posts the verdict files
   each follow-up as written, then puts the issue links in the `pass` body:

   ```bash
   gh issue create --repo "$REPO" --title "<follow-up title>" \
     --body "<follow-up body>

   Found by the independent review of #$PR (round $ROUND, non-critical under the round cap)."
   ```

5. **The capped pass needs a new head.** The merge wrapper keeps a BLOCK sticky
   for the head it reviewed (`sticky-block`), so a `pass` on the head that got
   the second BLOCK is refused. Commit the round-2 fixes first; the third
   review runs on that new head. If you disagree with every round-2 finding,
   rebut them on the PR and still push the fixes you do accept.
6. The merge rule does not change: the latest verdict must be a `pass` bound to
   the current head (or to its `review-patch-id`).

**Worked example.** PR #4100 changes `src/core/task-archive.ts`.

- **Review 1 on H1** (`a1b2…`): BLOCK. (1) critical: a pruned task is deleted
  before its archive write is flushed, so a crash loses it. (2) non-critical:
  no test covers the empty-history path. The implementer fixes both: H2.
- **Review 2 on H2** (`c3d4…`): BLOCK. (1) non-critical: `docs/reference/tasks.md`
  still says pruning deletes history. (2) non-critical: the helper
  `archiveName()` is exported but unused. The implementer fixes the doc,
  leaves the helper for now, and commits: H3.
- **Review 3 on H3** (`e5f6…`): the PR carries two BLOCKs, so the cap applies.
  The reviewer finds no critical defect and returns one follow-up, the unused
  export. The session files it as #4101 and posts:

  ```
  <!-- kookr-independent-review -->
  kookr-review-verdict: pass
  review-lane: codex
  review-head-sha: e5f6...
  review-patch-id: 9f8e...

  ## Independent reviewer verdict: PASS
  Round 3 of the review; the PR already had two BLOCKs, so only correctness,
  data-loss and security findings block. No such finding on this head: the
  crash window from round 1 is closed, and the archive is written and flushed
  before the prune.

  Follow-ups (non-critical, filed under the round cap):
  - #4101 `archiveName()` in src/core/task-archive.ts is exported but never used
  ```

  `kookr merge 4100` accepts this `pass`: it is the latest verdict and is bound
  to the current head H3.

If review 3 had found a critical defect, it would BLOCK as before, and every
later review keeps applying the cap.

### 5. Latency budget — never turn timeout into quality

The reviewer verdict should land within **10 minutes**. If the reviewer
(including the Claude fallback) has not returned a verdict by then, record
telemetry:

```bash
gh label create review-skipped-timeout --repo "$REPO" \
  --color ededed --description "Autonomous merge proceeded without a reviewer verdict (latency budget exceeded)" 2>/dev/null || true
gh issue edit "$PR" --repo "$REPO" --add-label review-skipped-timeout
```

`review-skipped-timeout` is telemetry only.

- **Hard-gate:** the merge wrapper refuses the PR while timeout is the latest
  state; retry the reviewer, use the configured fallback, and after the default
  **10 correction/review attempts** record a concrete blocker. An explicitly
  lower project cap remains authoritative. A timeout, missing review, or stale
  review never counts as a successful quality improvement, and never authorizes
  the merge.
- **Advisory:** apply the label if useful and continue to merge after local
  gates. Timeout, missing, or stale review never become a task blocker.

**Waiting for the reviewer or a background gate.** Never wait with
`while pgrep -f "<pattern>"; do sleep …; done`: the loop's own shell contains the
pattern, so it matches itself and never exits. Wait on a PID or an exit-marker
file with the toolkit helper
(`${CLAUDE_PLUGIN_ROOT}/hooks/kookr-wait.sh --pid <PID>` or
`--file "$LOG.exit"`, both with an explicit `--timeout`), or on the background
task's completion notification. When capturing test output, keep the full log:
`cmd 2>&1 | tee "$LOG" | tail -40; echo "exit=${PIPESTATUS[0]}"`.

### 6. Correction budget and periodic reflection

On a **hard-gate** repo, one iteration is one implementation attempt followed by
one fresh independent review of the resulting head. A BLOCK must be fixed or
rebutted and followed by another review; a PASS is usable only for the exact
current head. The durable attempt counter belongs to the unit/continuation
lineage, survives restart and branch-head changes, and defaults to 10. It must
not reset when a successor task or reviewer task is launched. The §4a round cap
works inside this budget: past review 2, only critical findings start another
iteration, so the budget is reached only by a PR that keeps producing them.

On an **advisory** repo this budget does not stall the implementation task.

Every five completed units, run a bounded self-reflection using blind or held-out
review data. Track mean iterations alongside precision, recall, F1, calibration,
fresh-review rate, exact-head binding, review coverage, and safe-merge rate.
Mutation may improve reviewer selection, prompts, mutators/judges, or gates only
when the quality sample is large enough and safety metrics are intact. Never
optimize for fewer iterations alone, and never let the reviewer weaken its own
gate to improve that number. Use `reviewer-distillation-meta` for blind
prediction/judging/mutation and retain a held-out evaluation set.

## Trust model (a guardrail, not a sandbox)

The implementer agent relays the verdict (it runs `gh pr comment`), so the gate
cannot cryptographically distinguish a genuine reviewer verdict from a
hand-written one — author-pinning is not feasible when the same actor posts on
the reviewer's behalf. This is deliberately a **guardrail against silent
zero-review merges**, not a defense against an implementer that chooses to forge
a `pass`. The value is that the fresh-context reviewer step becomes an auditable
action with a visible artifact. On a hard-gate repo, skipping it is a
conscious violation, not an accidental degradation. On an advisory repo,
skipping after a failed reviewer attempt is the documented policy, not a
violation. Keep the reviewer genuinely fresh-context when it runs — that
independence is what the verdict is worth.

## Output Contract

Before declaring the merge review done, report:

- review-policy: `hard` / `advisory` (and how it was classified)
- lane used: `codex` / `claude` (fallback) — and, if fallback, why Codex was skipped
- verdict: `pass` / `block` / `skipped` (+ confirmed-finding count for block)
- verdict comment posted: yes (URL) / no
- for a hard-gate block that was resolved: fixed (new head SHA) / rebutted + re-reviewed
- review round (count of BLOCK comments before this verdict) and, under the §4a cap, the follow-up issues filed
- timeout label applied: no / yes (with reason)
- on advisory: whether merge proceeded after local gates despite missing/BLOCK/timeout

## See Also

- [[pre-pr-review]] — the reviewer-specialist fan-out this reuses
- [[pr-review-triage]] — triaging review comments after they arrive
- `kookr-post-push` step 6 (wait-then-merge) — where this gate runs before `kookr merge`
