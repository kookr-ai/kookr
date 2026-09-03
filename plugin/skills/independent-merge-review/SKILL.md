---
name: independent-merge-review
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
(`pnpm merge`) refuses to merge (exit 4) without a `pass` for that head.
BLOCK, timeout, or a missing verdict starts another correction cycle. Do not
set `KOOKR_MERGE_REQUIRE_REVIEW=0` for an autonomous merge. Do not weaken this
repo's merge wrapper.

**Advisory** — the repo's `CLAUDE.md` or `AGENTS.md` documents that
independent review is advisory verification (Lucy's standing heading: "No
human merge gate — independent review is advisory verification",
jeanibarz/lucy#3606). Still spawn the reviewer and post the verdict when
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

Skip only when the merge is a human-driven manual merge (set
`KOOKR_MERGE_REQUIRE_REVIEW=0` for that one merge).

## The verdict comment contract

The reviewer posts **one** PR comment whose body carries these machine-readable
lines (the merge gate and the `review:coverage` metric parse them; the literals
live in `src/core/independent-review.ts`):

```
<!-- kookr-independent-review -->
kookr-review-verdict: pass        # or: block
review-lane: codex                # or: claude
review-head-sha: <full HEAD sha the reviewer actually reviewed>

## Independent reviewer verdict: PASS
<one-paragraph summary; for BLOCK, a numbered list of confirmed findings>
```

On a **hard-gate** repo, the merge wrapper depends on:

- **`kookr-review-verdict: block`** ⇒ merge is refused (exit 4). An explicit
  block is never overridden by the timeout label.
- **`kookr-review-verdict: pass`** with a `review-head-sha` matching the PR's
  current head ⇒ merge allowed. A missing or older binding is refused — re-run
  the reviewer after any new commit.
- The **latest** verdict comment wins, so the fix-and-re-review loop is honored:
  block → fix → post a fresh `pass` for the new head.

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

- **Codex lane (primary):** spawn a Codex reviewer (`spawn_agent`, or a
  `codex-cli` child task). If Codex is **unavailable or rate-limited** — the
  spawn errors, the agent reports a usage/quota limit, or it returns no verdict
  within the budget below — **fall back to the Claude lane**. On a hard-gate
  repo, do not degrade to no review. On an advisory repo, if both lanes fail,
  continue to merge after local gates.
- **Claude lane (fallback):** spawn a Claude reviewer subagent via the `Agent`
  tool.

Record which lane produced the verdict in `review-lane:`.

### 2. Spawn the reviewer FRESH-CONTEXT (blind to the implementer)

The reviewer MUST run in a **fresh context with no shared session** with the
implementer — it sees the diff, the issue, and the repo, but **not** the
implementer's reasoning, plan, or self-report. That independence is the whole
point: a reviewer told "the author says this is fine" is not an independent
check.

Reuse the reviewer-specialist prompts (`plugin/reviewer-specialists/`), at
minimum `correctness-specialist.md`, prefixed with the fan-out marker header
(see `pre-pr-review` §8). Give the reviewer only:

- `{repoDir}` — the worktree path
- the staged diff (`/tmp/kookr-review-$PR.diff`) and changed-file list
- the issue number/body (acceptance criteria) — the *requirements*, not the
  implementer's narrative

Instruct the reviewer to return a verdict:

- **BLOCK** if it finds any **confirmed** correctness or safety defect (a bug it
  can point at with a concrete failure scenario, not a style nit or a
  speculation).
- **PASS** otherwise. Suggestions and nits do not block — note them, verdict
  stays PASS.

### 3. Post the verdict comment

Translate the reviewer's result into the contract above and post it:

```bash
cat > /tmp/kookr-verdict-$PR.md <<EOF
<!-- kookr-independent-review -->
kookr-review-verdict: ${VERDICT}      # pass | block
review-lane: ${LANE}                  # codex | claude
review-head-sha: ${HEAD_SHA}

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

Never edit an old BLOCK comment to say pass — post a new verdict comment; the
gate reads the latest.

On an **advisory** repo, post the BLOCK as evidence. Do not stall or refuse
merge because of it. Fix confirmed findings when they are cheap and clearly
right; otherwise merge after local gates and leave the BLOCK on the PR.

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

### 6. Correction budget and periodic reflection

On a **hard-gate** repo, one iteration is one implementation attempt followed by
one fresh independent review of the resulting head. A BLOCK must be fixed or
rebutted and followed by another review; a PASS is usable only for the exact
current head. The durable attempt counter belongs to the unit/continuation
lineage, survives restart and branch-head changes, and defaults to 10. It must
not reset when a successor task or reviewer task is launched.

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
- timeout label applied: no / yes (with reason)
- on advisory: whether merge proceeded after local gates despite missing/BLOCK/timeout

## See Also

- [[pre-pr-review]] — the reviewer-specialist fan-out this reuses
- [[pr-review-triage]] — triaging review comments after they arrive
- `kookr-post-push` step 6 (wait-then-merge) — where this gate runs before `pnpm merge`
