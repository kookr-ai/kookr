---
name: independent-merge-review
description: Before an autonomous self-merge, spawn a fresh-context reviewer (Codex lane, Claude fallback) that posts a machine-readable PR verdict comment; the merge wrapper blocks on a BLOCK verdict and on a missing verdict.
keywords: independent review, merge gate, self-merge, reviewer verdict, codex reviewer, claude fallback, review-skipped-timeout, before merge, autonomous merge
related: pre-pr-review, pr-review-triage, git-commit-discipline
---

# Independent Merge Review

> **Requires:** the reviewer specialists at `plugin/reviewer-specialists/` and the
> merge wrapper `scripts/kookr-merge.sh` (issue #1717). If the reviewer
> specialists are missing, stop and report the missing dependency rather than
> fabricating a verdict.

Autonomous batches were merging PRs in ~1 minute with **zero** review activity —
the only external reviewer would silently drop a PR when it hit its usage limit,
and the flow degraded to no review rather than a fallback (issue #1717). This
skill closes that gap: **every autonomous self-merge must carry a fresh-context
reviewer verdict, or the sanctioned timeout label.**

The gate is enforced deterministically in `scripts/kookr-merge.sh` (`pnpm
merge`), so it is unreachable to merge without one. This skill is the
agent-facing protocol that *produces* the verdict the gate reads.

## When to Use

- In `implement-github-issue` Phase 8 and `parallel-issue-batch` Phase 5, **before**
  calling `pnpm merge <PR>` on an autonomous self-merge.
- In `kookr-post-push` step 6, before wait-then-merge.

Skip only when the merge is a human-driven manual merge (set
`KOOKR_MERGE_REQUIRE_REVIEW=0` for that one merge) or when merging to a repo that
does not use `pnpm merge`.

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

Rules the gate depends on:

- **`kookr-review-verdict: block`** ⇒ merge is refused (exit 4). An explicit
  block is never overridden by the timeout label.
- **`kookr-review-verdict: pass`** with a `review-head-sha` matching the PR's
  current head ⇒ merge allowed. A `pass` bound to an **older** commit is treated
  as stale and refused — re-run the reviewer after any new commit.
- The **latest** verdict comment wins, so the fix-and-re-review loop is honored:
  block → fix → post a fresh `pass` for the new head.

## Protocol

### 1. Stage the diff and pick the lane (with fallback)

Capture the diff the reviewer will judge and the exact head it reviews:

```bash
HEAD_SHA="$(git rev-parse HEAD)"
BASE="${BASE_REF:-origin/main}"
git diff "$BASE"...HEAD > /tmp/kookr-review-$PR.diff
```

Choose the reviewer lane. **Codex is the primary lane; Claude is the fallback so
zero-review merges become unreachable when Codex is rate-limited.**

- **Codex lane (primary):** spawn a Codex reviewer (`spawn_agent`, or a
  `codex-cli` child task). If Codex is **unavailable or rate-limited** — the
  spawn errors, the agent reports a usage/quota limit, or it returns no verdict
  within the budget below — **fall back to the Claude lane**; do not degrade to
  no review.
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

### 4. Resolve a BLOCK before merging

If the verdict is BLOCK, the merge gate refuses the merge. For **each** confirmed
finding, do exactly one:

- **Fix it** — implement the fix, commit, push. The head SHA changes, so you MUST
  re-run this skill (step 1) and post a fresh verdict for the new head.
- **Rebut it** — if the finding is wrong, post a PR comment explaining why, then
  re-run the reviewer so it can confirm and post a fresh `pass`. A rebuttal is
  not a merge authorization on its own; only a `pass` verdict is.

Never edit an old BLOCK comment to say pass — post a new verdict comment; the
gate reads the latest.

### 5. Latency budget — never deadlock throughput

The reviewer verdict must land within **10 minutes**. If the reviewer (including
the Claude fallback) has not returned a verdict by then, do **not** stall the
batch indefinitely:

```bash
gh label create review-skipped-timeout --repo "$REPO" \
  --color ededed --description "Autonomous merge proceeded without a reviewer verdict (latency budget exceeded)" 2>/dev/null || true
gh issue edit "$PR" --repo "$REPO" --add-label review-skipped-timeout
```

`review-skipped-timeout` is the timeout label the merge gate recognizes. With it
present, the gate allows the merge and the `review:coverage` metric counts the
PR as *timed-out* (not *reviewed*), so the escape hatch stays visible instead of
silently passing as a review.

Use the timeout label sparingly — it is the last resort for a genuinely
unresponsive reviewer, not a way to skip review.

## Trust model (a guardrail, not a sandbox)

The implementer agent relays the verdict (it runs `gh pr comment`), so the gate
cannot cryptographically distinguish a genuine reviewer verdict from a
hand-written one — author-pinning is not feasible when the same actor posts on
the reviewer's behalf. This is deliberately a **guardrail against silent
zero-review merges**, not a defense against an implementer that chooses to forge
a `pass`. The value is that the fresh-context reviewer step becomes a required,
auditable action with a visible artifact; skipping it is a conscious violation,
not an accidental degradation. Keep the reviewer genuinely fresh-context — that
independence is what the gate is protecting.

## Output Contract

Before declaring the merge review done, report:

- lane used: `codex` / `claude` (fallback) — and, if fallback, why Codex was skipped
- verdict: `pass` / `block` (+ confirmed-finding count for block)
- verdict comment posted: yes (URL) / no
- for a block that was resolved: fixed (new head SHA) / rebutted + re-reviewed
- timeout label applied: no / yes (with reason)

## See Also

- [[pre-pr-review]] — the reviewer-specialist fan-out this reuses
- [[pr-review-triage]] — triaging review comments after they arrive
- `kookr-post-push` step 6 (wait-then-merge) — where this gate runs before `pnpm merge`
