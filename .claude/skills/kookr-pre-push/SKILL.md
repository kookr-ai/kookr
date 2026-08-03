---
name: kookr-pre-push
description: Repo delivery-cycle entrypoint before git push or PR creation — compose the repo pre-push hook, pre-pr-review, reviewer specialists, and PR gate without duplicating them.
keywords: pre-push, before push, git push, before PR, delivery cycle, push, PR gate, reviewer specialists
related: pre-pr-review, kookr-post-push, kookr-pr-lifecycle, pr-review-triage, git-commit-discipline
---

# Pre-Push

> **Requires:** the OSS extension's `[[pre-pr-review]]` skill for the review-layer step (not bundled — see `docs/hooks-setup.md`). If absent, skip the review-layer step rather than fabricating output. The repo-level `pnpm test`, `pnpm build:server`, and `pnpm check:e2e` checks always run.

Use this before every non-trivial `git push` in Kookr. This skill does not replace existing checks. It sequences the checks that already exist so the branch is ready for push and for `gh pr create`.

## What Is Already Enforced

- **Repo git hook (`.hooks/pre-push`)**: `git push` automatically runs `pnpm build:server`, `pnpm check:e2e`, and `pnpm test`. `package.json` installs the hook via `prepare -> git config core.hooksPath .hooks`. Bundled — runs for every contributor.
- **Global PR gate (`~/.claude/hooks/pr-workflow-gate.sh` → `hooks/pr-workflow-gate.sh`)** — lives in this repo (not under `plugin/` because it integrates with Kookr config) and is installed by `scripts/install-hooks.sh`. `gh pr create` is blocked until `[[pre-pr-review]]` creates `/dev/shm/.pr-gate-<repo>-<branch>-pre-done`.
- **Reviewer specialists (`plugin/reviewer-specialists/`)** — bundled with the `kookr-toolkit` plugin. `[[pre-pr-review]]` defines the reviewer-specialist review layer for non-trivial work (conventions, correctness, deadcode, test, docs-drift, plus a11y for UI diffs). The **docs-drift-specialist** checks whether the code change left documentation stale — requirements, MBSE/system-models, ADRs, user-facing docs — and suggests the concrete edit.

This skill adds the missing delivery-cycle behavior: run the repo's review workflow before the push, not just when the hook or PR gate forces you to.

## Workflow

### 1. Check scope before pushing

Review the branch before you spend hook time:

```bash
git diff --stat main..HEAD
git diff main..HEAD
git log --oneline --decorate -n 5
```

Confirm:
- The diff only contains issue-relevant changes
- No debug leftovers, secrets, or accidental files
- Commit messages are PR-ready, not `wip` or `temp`

### 2. Run `pre-pr-review`

For any branch that you expect to push for review or turn into a PR, run [[pre-pr-review]] before `git push`.

In this repo, that means:
- Run the repo's TypeScript checks: `pnpm build:server`, `pnpm check:e2e`, `pnpm test`
- Run the reviewer specialists for non-trivial changes
- Fix blocking findings before proceeding
- Create the PR gate state file only after the mandatory checks pass

This is intentionally earlier than the `gh pr create` hook. The hook is the backstop; this skill is the normal path.

### 3. Write the review-gate marker

The repo's `.hooks/pre-push` blocks any push of non-trivial source changes that does not have a SHA-bound review marker at `.review-state/<branch>.json` (slashes in branch names flattened to underscores). The marker proves that reviewer specialists ran against the *current* HEAD, not a stale earlier commit.

After the reviewer specialists complete and any blocking findings are addressed, write the marker via the producer script (issue #1968). **Do NOT** `cat > .review-state/...` with only `sha`+`status` — the pre-push gate rejects approved markers that lack a valid producer HMAC token.

```bash
# List the specialists that actually ran (must be non-empty for approved).
bash scripts/write-review-state-marker.sh --status approved \
  --specialists "correctness,lint-like,test"
```

The writer derives the same marker key as `.hooks/pre-push` (branch name with `[^A-Za-z0-9.-]` → `_`, or `detached-<short-sha>`), binds the token to HEAD, and writes atomically.

The hook auto-skips the marker requirement for trivial paths (`docs/`, `.github/`, top-level `*.md`, `docs/**/*.md`, `*.test.*`, `*.spec.*`, `tsconfig*.json`, `.gitignore`). Any source file outside that list (`src/**`, `plugin/**`, `.hooks/**`, root config TS, lockfiles) requires the marker. Lockfile changes are deliberately gated — supply-chain attack surface — even for routine bumps.

For genuinely-trivial-but-not-allowlisted changes (e.g. a one-line comment in `src/`, a string-literal typo, a routine dependency version bump) write a `bypass` marker with a `reason` that's specific enough to be useful in `git log` (the hook logs `BYPASS for <ref> — <reason>` on every push). Bypass does **not** require a producer token (human escape hatch):

```bash
bash scripts/write-review-state-marker.sh --status bypass \
  --reason "<specific justification — e.g. 'pnpm-lock-only bump for axios 1.7.2 → 1.7.3, no transitive changes'>"
```

The reason field is mandatory for bypass markers — the hook rejects bypass markers without a `reason`.

Every new commit (including amend) shifts the SHA and invalidates the marker. Re-run specialists and re-write the marker after every amend.

### 4. Push and let the repo hook re-check

Push normally:

```bash
git push --set-upstream origin "$(git rev-parse --abbrev-ref HEAD)"
```

Expect `.hooks/pre-push` to re-run:
- `pnpm build:server`
- `pnpm check:e2e`
- `pnpm test`
- Plugin classification + version-bump checks (when `plugin/**` changed)
- Pre-PR review-gate marker check (this skill's output, step 3)

Do not bypass the hook. If it fails, fix the issue and push again.

### 5. Report milestone status explicitly

Before you tell the user "push succeeded", "looks good", or "open a PR", report the delivery milestones in plain language:

- `pre-pr-review`: run / skipped, with reason
- reviewer specialists: run / skipped, with reason
- repo pre-push hook: passed / failed
- branch state: pushed / needs another push
- next step: create PR / run `[[kookr-post-push]]` / fix blockers

Do not make the user ask whether the pre-push workflow or reviewer layer actually ran.

## Fast Path

For trivial doc-only or comment-only changes:
- You may skip reviewer specialists
- The repo hook still runs on `git push`
- `gh pr create` still requires the `[[pre-pr-review]]` state file unless the developer manually creates a bypass file
- Still report whether reviewer specialists were intentionally skipped

## External OSS Contributions (pushing to a fork)

If you are about to push a branch that will become a PR to an **external repository** (any PR where `--base` is not `kookr-ai/kookr`), run this extra pre-push checklist before `git push`:

1. **Re-read the recon report** at `~/.claude/{slug}-recon/recon-report.md` — slug is the dash-separated org-repo (`langgenius-dify`, `rust-lang-rust`, etc.).
2. **Check the recon's AI-disclosure policy** and apply it **on the first push**, not after reviewer pushback. Common forms:
   - **Opt-in marker in title** — e.g. dify appends `🤖🤖🤖` to the PR title for automated agents
   - **Co-authored-by trailer** — some projects want `Co-authored-by: Claude <noreply@anthropic.com>` in the commit
   - **Disclosure line in PR body** — "This contribution was developed with AI assistance"
   - **No AI policy documented** → default to writing the description like a human (no backtick-heavy prose, contractions, imperfect grammar — repos without an explicit opt-in usually dislike LLM-looking PRs)
   - **AI explicitly banned** (e.g. ggml-org/llama.cpp) → the repo is already on the oss-gate blocklist; stop.
   - **Anti-AI / LLM-detection-harsh** (e.g. rust-lang/rust banning suspected-LLM PRs as spam) → **stop before pushing** and escalate to the user with sourced evidence: quote the CONTRIBUTING.md line, link the rejected PR or reviewer pushback, cite the CI bot that detects AI content. Ask for explicit confirmation before contributing — the user usually does not want AI contributions to these repos and may want to add the repo to the oss-gate blocklist. Don't try to "write like a human" to sneak through.
3. **Verify commit message style** — some repos forbid issue links (`#NNN`) in commit messages (e.g. rust-lang/rust keeps them in PR body only).
4. **Verify reviewer assignment** — don't manually `r?` a specific person unless the recon confirms they're a valid assignee; let the triagebot auto-assign.

These checks live here (not in the global PR gate) because they apply **before** `git push`, while the commit and branch name are still fluid and cheap to amend.

## Relationship to the Rest of the Flow

- `[[pre-pr-review]]` is the enforced pre-PR gate and the place where the reviewer specialists live
- `.hooks/pre-push` is the enforced push-time verification
- `[[kookr-post-push]]` starts after the branch is on GitHub and continues through PR follow-through, including the `pnpm merge <PR>` wrapper that substitutes for `gh pr merge --auto` on this repo (issue #29)
