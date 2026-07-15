---
name: Grok Build Daily Upstream Sync
description: Merge the latest xai-org/grok-build main into the fork's feat/claude-compat branch through a sync PR, rebuild the binary, and report conflicts that need human attention
cwd: $HOME/git/grok-build
checklist:
  - Working tree was clean before starting (or stopped early with a clear message)
  - Fetched origin and upstream/main
  - If upstream/main is already contained in origin/feat/claude-compat AND the installed binary matches, stopped early with "no upstream changes" (success)
  - Created a fresh sync worktree from origin/feat/claude-compat
  - Recovered an interrupted same-day sync worktree autonomously when it was task-owned and safe to abort
  - Merged upstream/main into the sync branch with a normal merge commit
  - Tier 1/2 conflicts auto-resolved, Tier 3 conflicts aborted with report
  - Fork compat patches verified against upstream hook-event enums (cargo check compiles the fork's emission sites against the merged enums)
  - cargo check -p xai-grok-pager-bin -p xai-grok-hooks passes
  - cargo test -p xai-grok-hooks passes
  - Release build (cargo build --release -p xai-grok-pager-bin) passes on the sync branch
  - Pushed sync branch to origin and opened a PR into feat/claude-compat
  - PR was merged with a normal merge commit, never squash or rebase merge
  - Local feat/claude-compat was fast-forwarded from origin/feat/claude-compat after PR merge
  - Release binary built from the final local feat/claude-compat tip
  - Binary installed at $HOME/bin/grok
  - grok version reports a commit stamp matching the final feat/claude-compat short SHA
  - Final report includes PR URL, merge commit, conflict-resolution log, tests, and installed version stamp
---

## Objective

Keep the Grok Build fork's `feat/claude-compat` branch synchronized with the
latest `xai-org/grok-build` main without rewriting `feat/claude-compat`.

This daily catch-up merges upstream into a short-lived sync branch, verifies it,
opens a PR into `feat/claude-compat`, merges that PR with a normal merge commit,
then fast-forwards the local `feat/claude-compat` checkout from `origin`.

**No new functionality is added.** This task only brings existing fork work
forward onto a newer upstream base through an auditable merge PR.

This playbook is the Grok twin of `codex-rebase.md` (the Codex CLI fork sync);
the operating model is identical, only the repo layout, crate names, and
verification commands differ.

## Context

- **Fork**: `jeanibarz/grok-build` — checkout at
  `${KOOKR_GROK_CHECKOUT:-$HOME/git/grok-build}` with `origin =
  jeanibarz/grok-build` and `upstream = xai-org/grok-build`.
- **Branch**: `feat/claude-compat` is the persistent fork integration branch;
  never push to `main`.
- **Operational mode**: do not rebase or force-push `feat/claude-compat`. Keep
  local and remote aligned with normal fast-forward pulls after the sync PR is
  merged.
- **Rust toolchain**: pinned by the fork's root `rust-toolchain.toml` (stable
  channel; `rustup` auto-installs on first build). `protoc` resolves through the
  repo's `bin/protoc` dotslash launcher or `$PROTOC`/PATH.
- **Binary crate**: `xai-grok-pager-bin`; the release artifact is
  `target/release/xai-grok-pager`, installed as `grok` (matching how official
  installs ship it).
- **WSL quirk** (shared with the codex sync): snap-provided `cargo` fails when
  `/run/user/1000` is not writable. Always `export XDG_RUNTIME_DIR=/tmp`.
- **Kookr integration**: the binary at `${KOOKR_GROK_BIN:-$HOME/bin/grok}` is
  what Kookr spawns for `grok-build` tasks. Build provenance is self-reported:
  the fork's `build.rs` bakes `git rev-parse --short HEAD` into the version
  string, so `grok version` prints `v<semver> (<short-sha>) [<channel>]` — the
  Grok analogue of the codex fork's `+kookr.<sha>` stamp. Freshness checks parse
  that output; there is no side-channel state file.
- **Build qualification**: Kookr's grok-build adapter treats the reviewed
  compatibility manifest as ADVISORY — a locally-built fork binary launches with
  a supervision warning; that is expected and fine.
- **Manual rebuild**: `pnpm grok:rebuild` in the Kookr repo runs
  `scripts/rebuild-grok.sh` (fast kookr-dev profile).

## Setup

Every phase assumes these environment variables:

```bash
export XDG_RUNTIME_DIR=/tmp
export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_INCREMENTAL=true
export KOOKR_GROK_CHECKOUT="${KOOKR_GROK_CHECKOUT:-$HOME/git/grok-build}"
export KOOKR_GROK_BIN="${KOOKR_GROK_BIN:-$HOME/bin/grok}"
cd "$KOOKR_GROK_CHECKOUT"
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
   cd "$KOOKR_GROK_CHECKOUT"
   git status --porcelain
   ```

   Auto-exclude only obviously-generated untracked paths (`target/`, images,
   scratch dirs) via `.git/info/exclude`, exactly like the codex playbook's
   pre-flight. If any untracked entries look like source, config, or user work,
   stop and report them.

2. Fetch current refs:

   ```bash
   git fetch origin
   git fetch upstream
   ```

3. Ensure the local branch can later fast-forward to the remote integration
   branch. If `feat/claude-compat` is currently checked out and is behind
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
    FINAL_SHORT=$(git rev-parse --short origin/feat/claude-compat)
    INSTALLED_VERSION=$("$KOOKR_GROK_BIN" version 2>/dev/null || true)
    if printf '%s\n' "$INSTALLED_VERSION" | grep -q "($FINAL_SHORT)"; then
        echo "feat/claude-compat already contains upstream/main and installed binary matches — no upstream changes today"
        exit 0
    fi
    echo "feat/claude-compat already contains upstream/main, but installed binary is missing or stale"
    echo "expected commit stamp ($FINAL_SHORT), got: ${INSTALLED_VERSION:-<none>}"
    echo "skip Phases 3-5 and run Phase 6 to rebuild/install from the current integration branch"
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
   SYNC_WORKTREE="../grok-build-sync-upstream-$DATE_COMPACT"
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

   Same-day retry and interrupted-merge recovery rules are identical to the
   codex playbook: clean reuse is allowed only if the worktree is clean and the
   existing sync branch contains the captured `$BASE_SHA`
   (`git merge-base --is-ancestor "$BASE_SHA" HEAD`). A dirty same-day worktree
   may be recovered autonomously ONLY when all of: HEAD is `$SYNC_BRANCH`;
   `git rev-parse --git-common-dir` points at the canonical checkout's `.git`;
   `MERGE_HEAD` exists (in-progress merge, not arbitrary edits); the base check
   passes; and `git status --porcelain` shows nothing outside the merge result.
   Then `git merge --abort`, re-verify clean + base, log a
   `recovered stale same-day merge attempt` line, and retry the merge below.
   Anything else: stop and report; do not delete worktrees or branches blindly.

2. Merge upstream with a normal merge commit:

   ```bash
   git merge --no-ff upstream/main
   ```

3. If the merge reports conflicts, classify each conflict region and resolve per
   the tiered policy below. Append one line to the in-memory conflict-resolution
   log for every conflict, including rerere-assisted resolutions. After all
   authorized Tier 1/2 resolutions: `git diff`, `git add <resolved-files>`,
   `GIT_EDITOR=true git commit` (one commit for all resolved files).

   **Tier 1 — auto-resolve. Disjoint additive collisions in the same hunk.**
   - Both sides add different `use ...` imports: keep both.
   - Both sides add disjoint helper functions, struct impls, consts, or tests in
     the same area: keep both.
   - Upstream extends an event enum / constant array the fork side only
     re-exports or annotates: keep both, upstream's extension first.

   **Tier 2 — auto-resolve, log a one-line rationale. One side is the new
   upstream API, the other is the older form the fork patched.**
   - Constructor/function signature change: take upstream's new signature and
     layer fork-specific parameters or captures on top.
   - Fork-redundant code: if upstream now provides what the fork previously
     added (e.g. upstream implements one of our Claude-compat hook events
     natively), drop the fork's redundant redefinition after grepping for the
     symbol outside the conflict region — and call this out prominently in the
     report, since it means a fork patch can be retired.

   **Tier 3 — abort and report. Genuinely semantic divergence.**
   - Same logic reimplemented differently on both sides.
   - Upstream removes or renames a symbol the fork actively extends or calls.
   - Conflict region is more than roughly 50 lines per side.
   - More than 3 hunks conflict in one file.

   For Tier 3: `git merge --abort`, then report the file, upstream commit range,
   classification reason, and the backup tag. Do not open a PR.

   **Source of truth for hooks-crate conflicts**: the fork's Claude-compat
   patches live around `crates/codegen/xai-grok-hooks` (event emission) and the
   headless turn driver in `crates/codegen/xai-grok-pager`. When upstream
   touches the hook event enums or dispatch, keep upstream's event model and
   re-apply the fork's additional emissions on top; the fork must remain a
   strict superset of upstream's emitted events.

## Phase 4: Verify and add sync fix-ups

Post-merge compile fixes are normal commits on the sync branch. Do not amend
fork commits and do not rewrite `feat/claude-compat`.

1. Fast check of the binary crate and the hooks crate:

   ```bash
   cd "$SYNC_WORKTREE"
   export XDG_RUNTIME_DIR=/tmp
   cargo check -p xai-grok-pager-bin -p xai-grok-hooks 2>&1 | tail -30
   ```

   (`cargo check --workspace` on this repo is expensive; the pager-bin check
   already pulls the full dependency closure that ships in the binary. Run the
   full workspace check only when the merge touched crates outside that
   closure. Deliberate deviation from the codex playbook: no `--offline` —
   upstream syncs routinely bump dependency versions, and an offline build
   would fail on any freshly-introduced crate. Compile errors here are also
   the unconditional check that the fork's hook-emission compat patches still
   agree with upstream's hook-event enums after the merge.)

   Mechanical fork-extension fallout (missing struct fields at fork callsites,
   signature drift, lockfile version normalization) may be patched on the sync
   branch and committed as `fix(sync): reconcile upstream merge fallout`. Real
   regressions (removed upstream symbols the fork still calls, type errors in
   fork logic): stop and report. Do not open a PR.

2. Run fork-critical tests:

   ```bash
   cargo test -p xai-grok-hooks 2>&1 | tail -10
   ```

   If any test fails, stop and report. Do not merge the PR.

3. Verify the release build before the sync PR is merged:

   ```bash
   cargo build --release -p xai-grok-pager-bin 2>&1 | tail -5
   ```

   If the release build fails, stop and report. Do not merge the PR. This keeps
   `feat/claude-compat` from advancing to a commit that cannot produce the Kookr
   runtime binary.

## Phase 5: Open and merge the sync PR

1. Push the sync branch: `git push -u origin "$SYNC_BRANCH"` (normal push of a
   short-lived branch; never force-push `feat/claude-compat`).

2. Create or reuse a PR into `feat/claude-compat`:

   ```bash
   PR_URL=$(gh pr list \
       --repo jeanibarz/grok-build \
       --base feat/claude-compat \
       --head "$SYNC_BRANCH" \
       --state open \
       --json url \
       --jq '.[0].url')
   if [ -z "$PR_URL" ]; then
       PR_URL=$(gh pr create \
           --repo jeanibarz/grok-build \
           --base feat/claude-compat \
           --head "$SYNC_BRANCH" \
           --title "sync: merge upstream/main into feat/claude-compat ($DATE)" \
           --body "Daily upstream sync. Merges xai-org/grok-build upstream/main into feat/claude-compat with a normal merge commit. Verification: cargo check -p xai-grok-pager-bin -p xai-grok-hooks; cargo test -p xai-grok-hooks; cargo build --release -p xai-grok-pager-bin.")
   fi
   echo "$PR_URL"
   ```

3. Merge the PR only after local verification has passed, with a normal merge
   commit (never squash, never rebase), guarded against base movement:

   ```bash
   git fetch origin
   CURRENT_BASE_SHA=$(git rev-parse origin/feat/claude-compat)
   if [ "$CURRENT_BASE_SHA" != "$BASE_SHA" ]; then
       echo "origin/feat/claude-compat moved from $BASE_SHA to $CURRENT_BASE_SHA"
       echo "merge origin/feat/claude-compat into $SYNC_BRANCH, rerun Phase 4 verification, then retry Phase 5"
       exit 1
   fi
   gh pr merge "$PR_URL" --repo jeanibarz/grok-build --merge --delete-branch
   ```

   If GitHub refuses to merge because checks, permissions, or branch protection
   block it, stop and report the PR URL. Do not bypass protections.

## Phase 6: Fast-forward local feat/claude-compat and build the deployed binary

After the PR is merged, or when Phase 2 enters install-only recovery, update the
main checkout by fast-forward only:

```bash
cd "$KOOKR_GROK_CHECKOUT"
git fetch origin
git checkout feat/claude-compat
git pull --ff-only origin feat/claude-compat
```

If this cannot fast-forward, stop and report. Do not reset automatically.

Build and install from this final local `feat/claude-compat` tip, not from the
pre-merge sync branch:

```bash
export XDG_RUNTIME_DIR=/tmp
cargo build --release -p xai-grok-pager-bin 2>&1 | tail -5
TARGET_DIR=$(cargo metadata --format-version=1 --no-deps 2>/dev/null | jq -r .target_directory)
BIN="$TARGET_DIR/release/xai-grok-pager"
if [ ! -x "$BIN" ]; then
    echo "FAIL: xai-grok-pager binary not found at $BIN"
    exit 1
fi
install -m 755 "$BIN" "$KOOKR_GROK_BIN"
```

Sanity-check the installed binary:

```bash
"$KOOKR_GROK_BIN" version
git rev-parse --short feat/claude-compat
```

The `(<short-sha>)` commit stamp in the version output must match the final
`feat/claude-compat` short SHA (the fork's `build.rs` bakes it in at compile
time). If it does not match, or `grok version` fails to run, report and stop —
Kookr's preflight parses that output.

## Phase 7: Report

State clearly in the final summary:

- Starting `origin/feat/claude-compat` SHA and final merged SHA.
- How many upstream commits were absorbed.
- Sync branch name and PR URL.
- Base SHA verified before PR merge.
- Merge commit SHA.
- Conflict-resolution log, required even when there were zero conflicts —
  prominently flag any Tier-2 resolution that retired a fork compat patch
  because upstream absorbed the feature.
- Post-merge fix-up commits, if any.
- Test results with passed / failed / ignored counts.
- Installed binary path and the version stamp (`grok version` output).
- Whether the run performed a full sync PR or install-only recovery.
- That the production Kookr instance has **not** been auto-restarted; the user
  must run `pnpm prod:update` or `pnpm prod:restart` themselves to pick up the
  new binary in the running dashboard.

## Idempotency rules

- If `upstream/main` is already an ancestor of `origin/feat/claude-compat` and
  the installed binary's self-reported commit stamp matches that branch tip,
  the run is a no-op.
- If `upstream/main` is already contained but the installed binary is stale or
  missing, the run skips the PR workflow and performs install-only recovery.
- Same-day retries reuse clean dated sync branches/worktrees; task-owned
  interrupted merges are recovered per Phase 3's explicit checks.
- The persistent branch is never force-pushed.
- The local main checkout is updated only by `git pull --ff-only` after the PR
  is merged.

## Anti-patterns

- Do not rebase `feat/claude-compat`.
- Do not force-push `feat/claude-compat`.
- Do not squash merge or rebase merge the sync PR.
- Do not merge the sync PR before the release build passes on the sync branch.
- Do not build/install from the sync branch after the PR has been merged; build
  from the final local `feat/claude-compat` tip so the baked-in commit stamp
  matches.
- Do not auto-resolve Tier 3 conflicts.
- Do not amend fork commits as part of the sync.
- Do not reset the main checkout unless the user explicitly approves it.
- Do not push to `main` or to `upstream`.
- Do not restart the Kookr production instance.
