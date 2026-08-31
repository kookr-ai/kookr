---
name: Codex CLI Daily Upstream Sync
description: Merge the latest openai/codex main into the fork's feat/claude-compat branch through a sync PR, rebuild its matched runtime pair, and report conflicts that need human attention
cwd: $HOME/git/codex
checklist:
  - Working tree was clean before starting (or stopped early with a clear message)
  - Fetched origin and upstream/main
  - If upstream/main is already contained in origin/feat/claude-compat, stopped early with "no upstream changes" (success)
  - Created a fresh sync worktree from origin/feat/claude-compat
  - Recovered an interrupted same-day sync worktree autonomously when it was task-owned and safe to abort
  - Merged upstream/main into the sync branch with a normal merge commit
  - Tier 1/2 conflicts auto-resolved, Tier 3 conflicts aborted with report
  - HOOK_EVENT_NAMES* arrays in hooks/src/lib.rs reconciled against matcher_pattern_for_event
  - cargo check --workspace passes
  - cargo test -p codex-core-skills -p codex-hooks passes
  - cargo test -p codex-cli --test version passes
  - Pushed sync branch to origin and opened a PR into feat/claude-compat
  - PR was merged with a normal merge commit, never squash or rebase merge
  - Local feat/claude-compat was fast-forwarded from origin/feat/claude-compat after PR merge
  - Release CLI and code-mode host built from the final local feat/claude-compat tip
  - Matched CLI/host pair installed at $HOME/bin
  - A real code-mode IPC smoke call returned its marker
  - codex --version shows a +kookr.<sha> stamp matching the final feat/claude-compat tip
  - Final report includes PR URL, merge commit, conflict-resolution log, tests, and binary stamp
---

## Objective

Keep the Codex fork's `feat/claude-compat` branch synchronized with the latest
`openai/codex` main without rewriting `feat/claude-compat`.

This daily catch-up merges upstream into a short-lived sync branch, verifies it,
opens a PR into `feat/claude-compat`, merges that PR with a normal merge commit,
then fast-forwards the local `feat/claude-compat` checkout from `origin`.

**No new functionality is added.** This task only brings existing fork work
forward onto a newer upstream base through an auditable merge PR.

## Context

- **Fork**: `jeanibarz/codex` — checkout at `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` with `origin = jeanibarz/codex` and `upstream = openai/codex`.
- **Branch**: `feat/claude-compat` is the persistent fork integration branch; never push to `main`.
- **Operational mode**: do not rebase or force-push `feat/claude-compat`. Keep local and remote aligned with normal fast-forward pulls after the sync PR is merged.
- **Rust toolchain**: pinned at 1.93.0 in `codex-rs/rust-toolchain.toml`. Available at `~/.rustup/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin/`.
- **WSL quirk**: `cargo` via `/snap/bin/cargo` fails because `/run/user/1000` is not writable. Always export `XDG_RUNTIME_DIR=/tmp` and put the rustup toolchain bin first on `PATH`.
- **Kookr integration**: the binary at `${KOOKR_CODEX_BIN:-$HOME/bin/codex}` is what Kookr spawns when the user runs Codex CLI tasks. Build version format is `0.125.0-alpha.3+kookr.<short-sha>` (or `.dirty` if the worktree is dirty at build time).
- **Skill reference**: see `~/git/kookr-prod/.claude/skills/codex-claude-compatibility/SKILL.md` for the broader fork operating model.

## Setup

Every phase assumes these environment variables:

```bash
export XDG_RUNTIME_DIR=/tmp
export PATH=$HOME/.rustup/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin:$PATH
export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_INCREMENTAL=true
export KOOKR_CODEX_CHECKOUT="${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}"
export KOOKR_CODEX_BIN="${KOOKR_CODEX_BIN:-$HOME/bin/codex}"
export KOOKR_ROOT="${KOOKR_ROOT:-$HOME/git/kookr-prod}"
cd "$KOOKR_CODEX_CHECKOUT"
```

Keep Git `rerere` enabled in the local repository used for this workflow:

```bash
git config --local rerere.enabled true
git config --local rerere.autoupdate false
```

Use repo-local config, not user-global config. Keep `rerere.autoupdate=false`:
rerere may write a known resolution into the working tree, but the operator must
inspect the diff and stage files explicitly.

## Phase 1: Pre-flight

1. Confirm the main checkout has no tracked work in progress:

   ```bash
   cd "$KOOKR_CODEX_CHECKOUT"
   git status --porcelain
   git rev-parse --abbrev-ref HEAD
   ```

   **Tracked-file dirtiness** (lines starting with `M `, ` M`, `A `, `D `,
   `R `, etc.) means the user has work in progress: **stop**. Do not stash,
   commit, reset, or discard it. Report the dirty tracked files and exit.

   Pure untracked tool artifacts (`?? graphify-out/`, `?? target/`, `?? *.png`,
   scratch dirs) are not real dirtiness. Review untracked paths first, then add
   only known-safe artifact paths to `.git/info/exclude` and continue:

   ```bash
   unknown_untracked=0
   while IFS= read -r p; do
       case "$p" in
           graphify-out/|*/target/|target/|*.png|*.jpg|*.jpeg|*.gif|*.webp|scratch/|tmp/)
               grep -qxF "$p" .git/info/exclude || echo "$p" >> .git/info/exclude
               ;;
           *)
               echo "untracked path requires manual review: $p"
               unknown_untracked=1
               ;;
       esac
   done < <(git status --porcelain | awk '/^\?\? /{print substr($0, 4)}')
   if [ "$unknown_untracked" -ne 0 ]; then
       exit 1
   fi
   git status --porcelain
   ```

   If any untracked entries look like source, config, or user work, stop and
   report them.

2. Fetch current refs:

   ```bash
   git fetch origin
   git fetch upstream
   ```

3. Ensure the local branch can later fast-forward to the remote integration branch.

   If `feat/claude-compat` is currently checked out and is behind
   `origin/feat/claude-compat`, fast-forward it now:

   ```bash
   git checkout feat/claude-compat
   git pull --ff-only origin feat/claude-compat
   ```

   If the fast-forward fails, stop and report. Do not reset automatically unless
   the user explicitly approves losing the old local branch tip.

## Phase 2: Idempotency and recovery check

Skip the PR workflow if upstream is already contained in the fork branch and the
installed binary already matches the integration branch:

```bash
if git merge-base --is-ancestor upstream/main origin/feat/claude-compat; then
    FINAL_FULL_SHA=$(git rev-parse origin/feat/claude-compat)
    FINAL_SHA=$(git rev-parse --short=9 origin/feat/claude-compat)
    INSTALLED_VERSION=$("$KOOKR_CODEX_BIN" --version 2>/dev/null || true)
    PAIR_MANIFEST="$(dirname "$KOOKR_CODEX_BIN")/.codex-current/codex-pair.json"
    INSTALLED_PAIR_SHA=$(jq -r '.sourceCommit // empty' "$PAIR_MANIFEST" 2>/dev/null || true)
    if printf '%s\n' "$INSTALLED_VERSION" | grep -q "+kookr.$FINAL_SHA" \
        && [ "$INSTALLED_PAIR_SHA" = "$FINAL_FULL_SHA" ]; then
        echo "feat/claude-compat already contains upstream/main and the installed CLI/host pair matches — no upstream changes today"
        exit 0
    fi
    echo "feat/claude-compat already contains upstream/main, but its installed CLI/host pair is missing or stale"
    echo "expected +kookr.$FINAL_SHA and pair source $FINAL_FULL_SHA"
    echo "got version: ${INSTALLED_VERSION:-<none>}"
    echo "got pair source: ${INSTALLED_PAIR_SHA:-<none>}"
    echo "skip Phases 3-5 and run Phase 6 to rebuild/install the matched pair from the current integration branch"
    RECOVER_INSTALL_ONLY=1
else
    RECOVER_INSTALL_ONLY=0
    NEW_COMMITS=$(git rev-list --count origin/feat/claude-compat..upstream/main)
    echo "new upstream commits not yet contained in feat/claude-compat: $NEW_COMMITS"
fi
```

If `RECOVER_INSTALL_ONLY=1`, skip Phases 3-5 and run Phase 6. Do not open a PR.

If `RECOVER_INSTALL_ONLY=0`, continue to Phase 3.

## Phase 3: Create the sync worktree and merge upstream

1. Create a dated sync branch from the remote integration branch:

   ```bash
   DATE=$(date -u +%Y-%m-%d)
   DATE_COMPACT=$(date -u +%Y%m%d)
   SYNC_BRANCH="sync/upstream-main-$DATE_COMPACT"
   SYNC_WORKTREE="../codex-sync-upstream-$DATE_COMPACT"
   TAG="pre-sync-$DATE"
   BASE_SHA=$(git rev-parse origin/feat/claude-compat)

   git tag -f "$TAG" origin/feat/claude-compat
   echo "backup tag: $TAG -> $(git rev-parse "$TAG")"
   echo "base sha: $BASE_SHA"

   git worktree add "$SYNC_WORKTREE" -b "$SYNC_BRANCH" origin/feat/claude-compat
   cd "$SYNC_WORKTREE"
   git config --local rerere.enabled true
   git config --local rerere.autoupdate false
   ```

   If the branch or worktree already exists from a same-day retry, inspect it
   before reusing it.

   Clean reuse is allowed only if the worktree is clean and the existing sync
   branch already contains the captured base SHA:

   ```bash
   git merge-base --is-ancestor "$BASE_SHA" HEAD
   ```

   If the same-day worktree exists and is dirty because an earlier run was
   interrupted during `git merge --no-ff upstream/main`, recover autonomously
   instead of asking the user, but only when all of these checks pass:

   - `git rev-parse --abbrev-ref HEAD` equals `$SYNC_BRANCH`.
   - `git rev-parse --git-common-dir` points at the canonical checkout's
     `.git` directory.
   - `git rev-parse -q --verify MERGE_HEAD` succeeds, proving this is an
     in-progress merge rather than arbitrary edits.
   - `git merge-base --is-ancestor "$BASE_SHA" HEAD` succeeds.
   - `git status --porcelain` contains no untracked paths and no changes outside
     the merge result.

   For that task-owned interrupted merge, record a conflict-log line such as
   `recovered stale same-day merge attempt: aborted MERGE_HEAD <sha> and retried
   current upstream/main <sha>`, then run:

   ```bash
   STALE_MERGE_HEAD=$(git rev-parse MERGE_HEAD)
   git merge --abort
   git status --porcelain
   git merge-base --is-ancestor "$BASE_SHA" HEAD
   ```

   If the abort leaves the worktree clean and the base check still passes,
   continue with the current `upstream/main` merge below. Do not ask the user
   just because the aborted stale merge had unresolved Tier 1/Tier 2 conflicts;
   those resolutions are reproducible from `origin/feat/claude-compat` and
   `upstream/main`.

   If that check fails, the base branch moved since the sync branch was created.
   Stop and report. Do not merge the PR until the sync branch has merged the
   current `origin/feat/claude-compat` base and Phase 4 verification has run
   again. Do not delete worktrees or branches blindly.

   Stop and report instead of aborting if the existing worktree is not the
   dated sync worktree, is not on `$SYNC_BRANCH`, has untracked source/config
   files, has no `MERGE_HEAD`, or contains local commits that do not contain the
   captured base SHA.

2. Merge upstream with a normal merge commit:

   ```bash
   git merge --no-ff upstream/main
   ```

3. If the merge reports conflicts, classify each conflict region and resolve per
   the tiered policy below. Append one line to the in-memory conflict-resolution
   log for every conflict, including rerere-assisted resolutions.

   After all authorized Tier 1/2 resolutions:

   ```bash
   git diff
   git add <resolved-files>
   GIT_EDITOR=true git commit
   ```

   If the merge has multiple conflicted files, resolve all authorized Tier 1/2
   files, then commit once.

   **Tier 1 — auto-resolve. Disjoint additive collisions in the same hunk.**
   - Both sides add different `use ...` imports: keep both.
   - Both sides add disjoint helper functions, struct impls, consts, or tests in
     the same area: keep both.
   - Both sides add disjoint test functions inside one `#[tokio::test]`-anchored
     block: reconstruct as sequential tests, each with its own annotation and
     closing brace.
   - Upstream extends a constant array such as `HOOK_EVENT_NAMES` and the fork
     side has unrelated re-exports in the same hunk: keep both, with the array
     first then the re-exports.

   **Tier 2 — auto-resolve, log a one-line rationale. One side is the new upstream
   API, the other is the older form the fork patched.**
   - Constructor signature change: take upstream's new signature and layer
     fork-specific captures or parameters on top.
   - Fork-redundant code: if upstream now provides what the fork previously added,
     drop the fork's redundant redefinition after grepping for the symbol outside
     the conflict region.

   **Tier 3 — abort and report. Genuinely semantic divergence.**
   - Same logic reimplemented differently on both sides.
   - Upstream removes or renames a symbol the fork actively extends or calls.
   - Conflict region is more than roughly 50 lines per side.
   - More than 3 hunks conflict in one file.

   For Tier 3:

   ```bash
   git merge --abort
   ```

   Report the file, upstream commit range, classification reason, and the backup
   tag. Do not open a PR.

   **Source of truth for hooks-crate conflicts**: when extending
   `HOOK_EVENT_NAMES` / `HOOK_EVENT_NAMES_WITH_MATCHERS`, the canonical event list
   is `codex-rs/hooks/src/events/common.rs::matcher_pattern_for_event`. Events
   whose arm returns `matcher` go in `HOOK_EVENT_NAMES_WITH_MATCHERS`; all
   variants go in `HOOK_EVENT_NAMES`.

## Phase 4: Verify and add sync fix-ups

Post-merge compile or array reconciliation fixes are normal commits on the sync
branch. Do not amend fork commits and do not rewrite `feat/claude-compat`.

1. Reconcile hook event arrays against `matcher_pattern_for_event`.

   `codex-rs/hooks/src/lib.rs` must mirror the match arms in
   `codex-rs/hooks/src/events/common.rs::matcher_pattern_for_event`:

   - `HOOK_EVENT_NAMES`: every variant.
   - `HOOK_EVENT_NAMES_WITH_MATCHERS`: only variants whose arm returns `matcher`.

   If arrays diverge, edit `codex-rs/hooks/src/lib.rs`, stage the change, and
   commit it on the sync branch.

2. Run workspace check:

   ```bash
   cd "$SYNC_WORKTREE/codex-rs"
   cargo check --workspace --offline 2>&1 | tail -30
   ```

   If it fails, classify the error before rolling back.

   **Mechanical fork-extension fallout** may be patched on the sync branch:
   - Missing field in an upstream-new crate's literal where the struct is
     fork-extended. Add the fork default, such as `settings_file: None`.
   - Missing field at a fork-extension callsite of an upstream-extended struct.
     Add the upstream field with the appropriate default.
   - Function-signature drift at a fork callsite. Insert the new upstream
     argument from surrounding context.
   - Cargo.lock version normalization from placeholder `0.0.0` to workspace
     versions.

   For mechanical fallout: patch, rerun `cargo check`, then commit the fix-up on
   the sync branch with a clear message such as:

   ```bash
   git add <files>
   git commit -m "fix(sync): reconcile upstream merge fallout"
   ```

   **Real regression** means removed upstream symbols the fork still calls, type
   errors in fork logic, missing methods on fork-extended traits, or anything not
   covered above. For real regressions, stop and report. Do not open a PR.

3. Run fork-critical tests:

   ```bash
   cargo test --offline -p codex-core-skills -p codex-hooks 2>&1 | tail -10
   cargo test --offline -p codex-cli --test version 2>&1 | tail -5
   ```

   If any test fails, stop and report. Do not merge the PR.

4. Verify both release executables before the sync PR is merged:

   ```bash
   cargo build --offline --release -p codex-cli --bin codex 2>&1 | tail -5
   cargo build --offline --release -p codex-code-mode-host --bin codex-code-mode-host 2>&1 | tail -5
   ```

   If either release build fails, stop and report. Do not merge the PR. This
   keeps `feat/claude-compat` from advancing to a commit that cannot produce a
   matched Kookr runtime pair.

## Phase 5: Open and merge the sync PR

1. Push the sync branch:

   ```bash
   git push -u origin "$SYNC_BRANCH"
   ```

   This is a normal push of a short-lived sync branch. Do not force-push
   `feat/claude-compat`.

2. Create or reuse a PR into `feat/claude-compat`:

   ```bash
   PR_URL=$(gh pr list \
       --base feat/claude-compat \
       --head "$SYNC_BRANCH" \
       --state open \
       --json url \
       --jq '.[0].url')
   if [ -z "$PR_URL" ]; then
       PR_URL=$(gh pr create \
           --base feat/claude-compat \
           --head "$SYNC_BRANCH" \
           --title "sync: merge upstream/main into feat/claude-compat ($DATE)" \
           --body "Daily upstream sync. Merges openai/codex upstream/main into feat/claude-compat with a normal merge commit. Verification: cargo check --workspace --offline; cargo test --offline -p codex-core-skills -p codex-hooks; cargo test --offline -p codex-cli --test version; release builds for codex and codex-code-mode-host.")
   fi
   echo "$PR_URL"
   ```

   If `gh pr create` fails with a permission error but the GitHub connector is
   available, use the connector to create the same PR instead of stopping. Keep
   the same base, head, title, and verification/conflict-resolution body. Record
   in the final report that the connector was used because the `gh` token lacked
   `CreatePullRequest` permission.

3. Merge the PR only after local verification has passed.

   Use a normal merge commit. Never squash merge and never rebase merge this PR:

   ```bash
   git fetch origin
   CURRENT_BASE_SHA=$(git rev-parse origin/feat/claude-compat)
   if [ "$CURRENT_BASE_SHA" != "$BASE_SHA" ]; then
       echo "origin/feat/claude-compat moved from $BASE_SHA to $CURRENT_BASE_SHA"
       echo "merge origin/feat/claude-compat into $SYNC_BRANCH, rerun Phase 4 verification, then retry Phase 5"
       exit 1
   fi
   gh pr merge "$PR_URL" --merge --delete-branch
   ```

   This base-SHA guard prevents GitHub from creating a final merge commit from a
   different integration-branch tree than the one verified locally.

   If `gh pr merge` cannot see a connector-created PR but the GitHub connector is
   available, use the connector merge operation with `merge_method=merge` and
   `expected_head_sha=$(git rev-parse HEAD)`. After a connector merge succeeds,
   delete the short-lived remote sync branch with `git push origin --delete
   "$SYNC_BRANCH"` to match `gh pr merge --delete-branch` cleanup.

   If GitHub refuses to merge because checks, permissions, or branch protection
   block it, stop and report the PR URL. Do not bypass protections.

## Phase 6: Fast-forward local feat/claude-compat and deploy the matched pair

After the PR is merged, or when Phase 2 enters install-only recovery, update the
main checkout by fast-forward only:

```bash
cd "$KOOKR_CODEX_CHECKOUT"
git fetch origin
git checkout feat/claude-compat
git pull --ff-only origin feat/claude-compat
```

If this cannot fast-forward, stop and report. Do not reset automatically.

Build and install both executables from this final local `feat/claude-compat`
tip, not from the pre-merge sync branch. The paired installer prepares both
artifacts before it atomically switches the active runtime directory:

```bash
CODEX_SRC="$KOOKR_CODEX_CHECKOUT" \
CODEX_INSTALL_DIR="$(dirname "$KOOKR_CODEX_BIN")" \
CODEX_BUILD_PROFILE=release \
    "$KOOKR_ROOT/scripts/rebuild-codex.sh"
```

Sanity-check the installed pair and its source commit:

```bash
"$KOOKR_CODEX_BIN" --version
FINAL_FULL_SHA=$(git rev-parse feat/claude-compat)
FINAL_SHORT_SHA=$(git rev-parse --short=9 feat/claude-compat)
PAIR_MANIFEST="$(dirname "$KOOKR_CODEX_BIN")/.codex-current/codex-pair.json"
test "$(jq -r .sourceCommit "$PAIR_MANIFEST")" = "$FINAL_FULL_SHA"
node "$KOOKR_ROOT/scripts/smoke-codex-code-mode.mjs" --codex "$KOOKR_CODEX_BIN"
```

The `+kookr.<sha>` suffix must match `$FINAL_SHORT_SHA`, the pair manifest must
match `$FINAL_FULL_SHA`, and the IPC smoke must observe its marker in a real
code-mode tool result. If any check fails, report the mismatch and stop.

## Phase 7: Report

State clearly in the final summary:

- Starting `origin/feat/claude-compat` SHA and final merged SHA.
- How many upstream commits were absorbed.
- Sync branch name and PR URL.
- Base SHA verified before PR merge.
- Merge commit SHA.
- Conflict-resolution log, required even when there were zero conflicts.
- Post-merge fix-up commits, if any.
- Test results with passed / failed / ignored counts.
- Installed binary version stamp and pair source commit.
- Code-mode IPC smoke result.
- Whether the run performed a full sync PR or install-only recovery.
- That the matched pair is active through `${KOOKR_CODEX_BIN:-$HOME/bin/codex}`.
- That the production Kookr instance has **not** been auto-restarted; the user
  must run `pnpm prod:update` or `pnpm prod:restart` themselves to pick up the
  new binary in the running dashboard.

## Idempotency rules

- If `upstream/main` is already an ancestor of `origin/feat/claude-compat` and
  the installed binary matches that branch, the run is a no-op.
- If `upstream/main` is already contained but the installed binary is stale or
  missing, the run skips the PR workflow and performs install-only recovery.
- Same-day retries reuse clean dated sync branches/worktrees. If the dated
  task-owned sync worktree is only dirty because an earlier `git merge --no-ff
  upstream/main` was interrupted, abort that stale merge and retry against the
  current fetched `upstream/main` without asking. Report only when the worktree
  fails the explicit recovery checks.
- The persistent branch is never force-pushed.
- The local main checkout is updated only by `git pull --ff-only` after the PR is
  merged.

## Anti-patterns

- Do not rebase `feat/claude-compat`.
- Do not force-push `feat/claude-compat`.
- Do not squash merge or rebase merge the sync PR.
- Do not merge the sync PR before the release build passes on the sync branch.
- Do not build/install from the sync branch after the PR has been merged; build
  from the final local `feat/claude-compat` tip so the version stamp matches.
- Do not auto-resolve Tier 3 conflicts.
- Do not amend fork commits as part of the sync.
- Do not reset the main checkout unless the user explicitly approves it.
- Do not push to `main` or to `upstream`.
- Do not restart the Kookr production instance.
