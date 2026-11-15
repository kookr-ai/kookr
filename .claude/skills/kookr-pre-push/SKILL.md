---
name: kookr-pre-push
description: Repo delivery-cycle entrypoint before git push or PR creation — compose the repo pre-push hook, pre-pr-review, reviewer specialists, and PR gate without duplicating them.
keywords: pre-push, before push, git push, before PR, delivery cycle, push, PR gate, reviewer specialists
related: pre-pr-review, kookr-post-push, kookr-pr-lifecycle, pr-review-triage, git-commit-discipline
---

# Pre-Push

> **Requires:** the OSS extension's `[[pre-pr-review]]` skill for the review-layer step (not bundled — see `docs/hooks-setup.md`). If absent, skip the review-layer step rather than fabricating output. The repo-level `pnpm build:server`, `pnpm check:e2e`, `pnpm test`, and `pnpm test:integration` checks always run.

Use this before every non-trivial `git push` in Kookr. This skill does not replace existing checks. It sequences the checks that already exist so the branch is ready for push and for `gh pr create`.

## What Is Already Enforced

- **Repo git hook (`.hooks/pre-push`)**: `git push` automatically runs every rule in [Rules a push can fail on](#rules-a-push-can-fail-on), cheap static checks first. `package.json` installs the hook via `prepare -> git config core.hooksPath .hooks`. Bundled — runs for every contributor.
- **Global PR gate (`~/.claude/hooks/pr-workflow-gate.sh` → `hooks/pr-workflow-gate.sh`)** — lives in this repo (not under `plugin/` because it integrates with Kookr config) and is installed by `scripts/install-hooks.sh`. `gh pr create` is blocked until `[[pre-pr-review]]` creates `/dev/shm/.pr-gate-<repo>-<branch>-pre-done`.
- **Reviewer specialists (`plugin/reviewer-specialists/`)** — bundled with the `kookr-toolkit` plugin. `[[pre-pr-review]]` defines the reviewer-specialist review layer for non-trivial work (conventions, correctness, deadcode, test, docs-drift, plus a11y for UI diffs). The **docs-drift-specialist** checks whether the code change left documentation stale — requirements, MBSE/system-models, ADRs, user-facing docs — and suggests the concrete edit.

This skill adds the missing delivery-cycle behavior: run the repo's review workflow before the push, not just when the hook or PR gate forces you to.

## Rules a push can fail on

Check these before you push: each one is cheaper to satisfy up front than to learn about from a rejected push. `.claude/hooks-tests/pre-push-skill-rule-list.test.sh` fails if a `pnpm` lane or `bash` helper the hook runs is missing from this list or out of order.

**`.hooks/pre-push`, in the order it runs.** The first rejection stops the push.

1. **No `.review-state/*.json` in the index.** Review markers stay local-only.
2. **No reserved test identity as the repo committer** (`hooks/git-identity-guard.sh`, e.g. `test@example.com`).
3. **Dependencies install.** With no `node_modules`, the hook runs `pnpm install --frozen-lockfile`; an install failure rejects the push.
4. **Review-gate marker** (non-trivial diffs only): `.review-state/<branch>.json` exists, its `sha` equals HEAD, and it is either `approved` with a producer token or `bypass` with a `reason`. See Workflow step 3.
5. **Plugin checks** (when a `plugin/` directory exists). These run before any type-check or test lane, so a missed bump costs seconds, not a full run:
   - no hardcoded absolute home path (`/home/<user>/git/kookr`) under `plugin/`;
   - `hooks/skill-placement-gate.sh`: `.claude/skills/` and `.claude/agents/` names start with `kookr-`, `plugin/` skill and agent names do not, no name collides between `.claude/` and `plugin/`, and every `subagent_type` is qualified as `kookr-toolkit:<name>`;
   - no `commands/` name in both `.claude/commands/` and `plugin/commands/`;
   - **any change under `plugin/` (other than `plugin.json` itself) needs a `"version"` value in `plugin/.claude-plugin/plugin.json` that differs from `origin/main`'s.** The hook only compares the two values. Two open PRs that bump to the same value merge without a conflict, so after a rebase make sure your version is still above the one on `origin/main`.
6. **Shell portability** (`scripts/check-shell-portability.sh`) on changed shell scripts, hooks, and files that spawn subprocesses. Skipped for docs-only diffs or with `SKIP_PORTABILITY_CHECK=1`.
7. `pnpm build:server` (server type-check). Skipped for docs-only diffs.
8. `pnpm check:e2e` (E2E type-check). Skipped for docs-only diffs.
9. `pnpm validate:skills` (skill frontmatter).
10. `pnpm validate:playbooks` (bundled playbooks parse).
11. `pnpm validate:docs-commands` (`pnpm` and `kookr` commands quoted in `README.md` and `docs/` exist).
12. `pnpm validate:rerun-bound` (the max-2 CI-rerun rule stays in the pr-lifecycle skill and implement playbooks).
13. `pnpm validate:requirements` (requirements status matrix).
14. `pnpm test`. Skipped for docs-only diffs. When at most five unit-test files fail, the hook re-runs only those once; a pass continues the push with a `FLAKY` notice (logged to `<git-common-dir>/kookr-flaky-tests.log`), while a second failure, an unhandled error, or a crashed worker rejects it.
15. `pnpm test:integration` (self-contained integration tests). Skipped for docs-only diffs. Items 14 and 15 are the full gate: when `.kookr/delivery-gate.json` on `origin/main` sets `"prePushGate": "fast"`, the hook runs `bash scripts/fast-gate-tests.sh` instead, which runs only the tests related to the diff, and the integration train runs the full suite (see [integration-train](../../../docs/reference/integration-train.md)).
16. `pnpm check:faa-gate`: a change to a finishedAwaitingAck mitigation surface must cite a classified root cause (read from `KOOKR_PR_BODY`) or a reasoned bypass.

A "docs-only" diff means `origin/main` exists, the diff against it is non-empty, and every changed file is an addition or modification of prose Markdown under `docs/` or a top-level `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CLA.md`, or `SECURITY.md`. A delete or rename runs the full gate.

**`pnpm verify` only (not in the hook).** `pnpm verify` is the local merge gate (`pnpm merge` needs its result recorded on the PR), so these fail the merge rather than the push:

- `pnpm check:cycles`: no import cycles.
- `pnpm validate:delivery-ownership` and `pnpm validate:parent-fallback`: orchestration rehearsals.
- `pnpm validate:docs-env-vars`: **every new `KOOKR_*` environment variable read in source is documented in `docs/reference/environment-variables.md`** (or listed in the verifier's internal allowlist), and every `KOOKR_*` var in `.env.example` is documented there too.
- `pnpm validate:docs-api-routes`: **every new `/api/*` route registered under `src/server` is documented in `docs/reference/api.md`** (or listed in `INTERNAL_API_ROUTES` with a reason).
- `pnpm test:smoke`, `pnpm test:hooks`, `pnpm test:stt`.

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
- Run the repo's type-check and test lanes: `pnpm build:server`, `pnpm check:e2e`, `pnpm test`, `pnpm test:integration`
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

Expect `.hooks/pre-push` to re-run every check in [Rules a push can fail on](#rules-a-push-can-fail-on), including the review-gate marker from step 3.

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
