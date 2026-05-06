---
name: Codex CLI Daily Upstream Rebase
description: Sync the fork's feat/claude-compat branch with the latest openai/codex main, rebuild the binary, and report any conflicts that need human attention
cwd: $HOME/git/codex
checklist:
  - Working tree was clean before starting (or stopped early with a clear message)
  - Fetched upstream/main and checked for new commits
  - If no new upstream commits, stopped early with "no upstream changes" (success)
  - Tagged the pre-rebase tip with pre-rebase-{YYYY-MM-DD}
  - Rebased feat/claude-compat onto upstream/main (Tier 1/2 conflicts auto-resolved, Tier 3 aborted with report)
  - HOOK_EVENT_NAMES* arrays in hooks/src/lib.rs reconciled against matcher_pattern_for_event
  - cargo check --workspace passes (mechanical fork-extension fallout patched if it fired)
  - cargo test -p codex-core-skills -p codex-hooks passes
  - Any post-rebase fix-ups amended onto the rebase tip (no separate "chore: rebase fixups" commits)
  - Release binary built (path resolved via `cargo metadata … | jq -r .target_directory`)
  - Binary installed at $HOME/bin/codex
  - codex --version shows a +kookr.<sha> stamp matching the rebased tip
  - Pushed feat/claude-compat to origin with --force-with-lease
  - Final report includes a conflict-resolution log (tier | file | fork-commit | decision) — even if empty
---

## Objective

Keep the Codex fork's `feat/claude-compat` branch rebased on the latest `openai/codex` main. This is a daily catch-up so each rebase only spans a small upstream delta (typically 2–10 commits) instead of letting drift accumulate into a multi-hour cleanup. **No new functionality is added — this task only forwards the existing fork patches onto a newer base.**

## Context

- **Fork**: `jeanibarz/codex` — sibling checkout at `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` with `origin = jeanibarz/codex` and `upstream = openai/codex`.
- **Branch**: `feat/claude-compat` is the persistent fork branch; never push to `main`.
- **Rust toolchain**: pinned at 1.93.0 in `codex-rs/rust-toolchain.toml`. Available at `~/.rustup/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin/`.
- **WSL quirk**: `cargo` via `/snap/bin/cargo` fails because `/run/user/1000` is not writable. Always export `XDG_RUNTIME_DIR=/tmp` and put the rustup toolchain bin first on `PATH`.
- **Kookr integration**: the binary at `${KOOKR_CODEX_BIN:-$HOME/bin/codex}` is what Kookr spawns when the user runs Codex CLI tasks. Build version format is `0.125.0-alpha.3+kookr.<short-sha>` (or `.dirty` if the worktree is dirty at build time).
- **Skill reference**: see `~/git/kookr-prod/.claude/skills/codex-claude-compatibility/SKILL.md` for the broader fork operating model.

## Setup (every phase below assumes these env vars)

```bash
export XDG_RUNTIME_DIR=/tmp
export PATH=$HOME/.rustup/toolchains/1.93.0-x86_64-unknown-linux-gnu/bin:$PATH
export CARGO_PROFILE_RELEASE_LTO=thin
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
export CARGO_PROFILE_RELEASE_INCREMENTAL=true
export KOOKR_CODEX_CHECKOUT="${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}"
export KOOKR_CODEX_BIN="${KOOKR_CODEX_BIN:-$HOME/bin/codex}"
cd "$KOOKR_CODEX_CHECKOUT"
```

## Phase 1: Pre-flight

1. Confirm the working tree is clean and the current branch is a known state:

   ```bash
   git status --porcelain
   git rev-parse --abbrev-ref HEAD
   ```

   **Tracked-file dirtiness** (lines starting with `M `, ` M`, `A `, `D `, `R `, etc.) means the user has work in progress: **stop**. Do not stash, do not commit, do not discard. Report what files are dirty and exit.

   **Pure-untracked tool artifacts** (lines starting with `??` for known-safe paths like `graphify-out/`, `target/`, `*.png`, scratch dirs) are not real dirtiness — they're tool output. For these, add the offending paths to `.git/info/exclude` (local-only, doesn't pollute tracked `.gitignore`) and continue. One-liner:

   ```bash
   for p in $(git status --porcelain | awk '/^\?\? /{print $2}'); do
       grep -qxF "$p" .git/info/exclude || echo "$p" >> .git/info/exclude
   done
   git status --porcelain   # must now be empty before continuing
   ```

   If after the exclude there are *still* untracked entries that look unfamiliar (config files, source files, anything that could be in-flight work), stop and report — don't auto-exclude unknown content.

2. Make sure local `feat/claude-compat` is checked out and synced with `origin`:

   ```bash
   git checkout feat/claude-compat
   git fetch origin
   git status -sb
   ```

   If local is ahead of `origin/feat/claude-compat`, that is fine (we'll force-push after the rebase). If local is *behind* origin, fast-forward first:

   ```bash
   git pull --ff-only origin feat/claude-compat
   ```

   If pull is not fast-forward, **stop and report**: someone else has rewritten the remote and a manual merge is needed.

3. Fetch upstream:

   ```bash
   git fetch upstream
   ```

## Phase 2: Idempotency check — skip if there is nothing to do

```bash
NEW_COMMITS=$(git log --oneline feat/claude-compat..upstream/main | wc -l)
echo "new upstream commits: $NEW_COMMITS"
```

- If `NEW_COMMITS == 0`: **success path, no work needed.** Report "feat/claude-compat is already at upstream/main tip — no rebase needed today" and exit. Do **not** run cargo, do **not** rebuild, do **not** push. This is the most common outcome on a quiet upstream day.
- If `NEW_COMMITS > 0`: continue to Phase 3.

## Phase 3: Tag a backup, then rebase

1. Tag the current tip so we can recover if the rebase goes sideways:

   ```bash
   TAG="pre-rebase-$(date -u +%Y-%m-%d)"
   git tag -f "$TAG" feat/claude-compat
   echo "backup tag: $TAG -> $(git rev-parse "$TAG")"
   ```

2. Rebase onto the new upstream tip:

   ```bash
   git rebase upstream/main 2>&1 | tail -20
   ```

3. **If the rebase reports conflicts**: classify each conflict region and resolve per the tiered policy below. Append one line to the in-memory conflict-resolution log for every conflict (emitted in the Phase 7 report). After resolving, `git add` the file(s) and `GIT_EDITOR=true git rebase --continue`.

   **Tier 1 — auto-resolve. Disjoint additive collisions in the same hunk.**
   - Both sides add different `use ...` imports → keep both.
   - Both sides add disjoint helper functions / struct impls / consts in the same area → keep both.
   - Both sides add disjoint test functions inside one `#[tokio::test]`-anchored block → reconstruct as sequential tests, each with its own `#[tokio::test]` annotation and its own closing brace.
   - Upstream extends a constant array (e.g. `HOOK_EVENT_NAMES`) and the fork side has unrelated re-exports in the same hunk → keep both, with the array first then the re-exports.

   **Tier 2 — auto-resolve, log a one-line rationale. One side is the new upstream API, the other is the older form the fork patched.**
   - Constructor signature change (e.g. `EnvironmentManager::new(...).await` upstream vs `EnvironmentManager::new(...)` sync fork) → take upstream's new signature, layer fork-specific data captures (e.g. `let settings_file = ...;`) on top of it.
   - Fork-redundant code (upstream now provides what the fork used to add — e.g. `auth_manager` defined earlier in the same function before the conflict region) → drop the fork's redundant redefinition. Verify by greping the file for the symbol *outside* the conflict region before deleting.

   **Tier 3 — abort and report. Genuinely semantic divergence.**
   - Same logic reimplemented differently on both sides (not disjoint, not a signature rename).
   - Upstream removes a symbol the fork actively extends, OR upstream renames a field/function the fork uses → cannot pick a side automatically.
   - Conflict region is more than ~50 lines per side, OR more than 3 hunks in a single file.
   - `git rebase --abort`, then report each conflict (file, fork commit SHA, classification reason) and exit. The user resolves manually OR escalates to a subagent merge draft (see "Tier 3 escalation pattern" below).

   **Source of truth for hooks-crate conflicts**: when extending `HOOK_EVENT_NAMES` / `HOOK_EVENT_NAMES_WITH_MATCHERS` arrays, the canonical event list is the `match` arms in `codex-rs/hooks/src/events/common.rs::matcher_pattern_for_event`. Events whose arm returns `matcher` go in `HOOK_EVENT_NAMES_WITH_MATCHERS`; all variants go in `HOOK_EVENT_NAMES`.

4. **If the rebase succeeds** (with no conflicts, or after Tier 1/2 auto-resolution): continue. Tier 3 abort exits here.

### Tier 3 escalation pattern (subagent-drafted candidate merge)

When Tier 3 fires and the user has approved escalation (don't do this unprompted — it costs a subagent run), spawn a `general-purpose` subagent to draft a hand-merged candidate. The agent produces full files at `/tmp/codex-merge-<commit-short-sha>/<filename>` plus a `RATIONALE.md`. On the next rebase pass, the user resolves the same Tier 3 conflict by `cp`ing the candidate files in instead of resolving from scratch.

**Subagent briefing template**: include all THREE sources of truth (pre-rebase fork file, upstream/main file, the fork commit's diff via `git show`) and the EXACT semantic intent of the merge ("keep fork's refactor; honor upstream's new guard; preserve upstream's new helper; thread X through Y"). Tell the agent NOT to run cargo (cargo state is per-worktree and the agent shouldn't pollute), NOT to modify the working tree of `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}`, and to deliver candidate files + rationale to `/tmp/codex-merge-<commit>/`. See the conversation history of the 2026-04-30 rebase (PR #31 / commit `42a54090a8`) for a worked example briefing.

**Re-applying the candidate**: when the rebase reaches the same conflict next pass, `cp /tmp/codex-merge-<commit>/<file> codex-rs/<file>` for each file, `git add` them, then `git rebase --continue`. The candidate often produces compile errors that surface in Phase 4 — those are typically mechanical fallout (signature drift) and patch-and-amend per the broadened classification in Phase 4.

### Known recurring conflict points

These surfaces conflict on most rebase days because the fork extends arrays/imports/functions upstream keeps modifying. Resolutions tend to be the same week after week — apply them without re-deriving.

- `codex-rs/hooks/src/lib.rs` (commit `043ca19fa9 wip: rebase phase 2`) — Tier 1. Auto-merge collides fork's `events::notification::*` re-exports against an empty HEAD section. Keep both. Verify HOOK_EVENT_NAMES arrays still match `matcher_pattern_for_event` (Phase 4 step 1).
- `codex-rs/hooks/src/registry.rs` (commit `753facd759` FileChanged) — Tier 1. Disjoint imports: HEAD adds `engine::HookListEntry`, fork adds `events::file_changed::*`. Keep both.
- `codex-rs/linux-sandbox/src/bwrap.rs` (commit `d28cefbeae phase 4`) — was Tier 2 on 2026-04-30 (took upstream's `synthetic_mount_targets` mechanism, dropped fork's `return Ok(())` defensive block). Should NOT recur unless the fork re-introduces its bwrap workaround. If it does conflict again, classify fresh.
- `codex-rs/core-plugins/src/loader.rs` + `codex-rs/core/src/plugins/manager_tests.rs` (commit `42a54090a8` PR #31) — **persistent Tier 3**. The fork's `load_plugin_from_root` extraction interacts with whatever upstream is iterating on in `load_plugin`. Either pre-stage a candidate at `/tmp/codex-merge-31/` (re-runnable from the 2026-04-30 conversation log briefing) or escalate fresh. **Long-term fix**: see "Occasional maintenance" below.

## Phase 4: Verify the workspace compiles, reconcile fork-extension surfaces, and run fork-critical tests

**Amend convention (applies to every fix-up in this phase)**: any compile fix or array reconciliation needed to make the rebase land cleanly is staged and amended onto the LAST fork commit (the rebase tip) — not committed as a separate "chore: rebase fixups" commit. This keeps the fork commit count stable so day-over-day rebase mechanics stay predictable. After staging the fix-ups: `git commit --amend --no-edit`.

1. **Reconcile HOOK_EVENT_NAMES with matcher_pattern_for_event** (proactive sync; upstream may have added new events that the fork's arrays don't list yet):

   The canonical fork event taxonomy is encoded in the `match` arms of `codex-rs/hooks/src/events/common.rs::matcher_pattern_for_event`. The two arrays in `codex-rs/hooks/src/lib.rs` must mirror it:
   - `HOOK_EVENT_NAMES`: every variant (both arms of the match).
   - `HOOK_EVENT_NAMES_WITH_MATCHERS`: only variants whose arm returns `matcher` (i.e. dispatches against a tool / source / path matcher).

   Read both arms of `matcher_pattern_for_event`, derive both arrays, and diff against the current `lib.rs` content. If the arrays diverge, edit `lib.rs` and stage for amending in step 4 below.

2. `cargo check --workspace`:

   ```bash
   cd "${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}/codex-rs"
   cargo check --workspace --offline 2>&1 | tail -30
   ```

   **If it fails, classify the error before rolling back:**

   - **Mechanical fork-extension fallout** — any of these patterns:
     1. **Missing field in upstream-new crate's literal**: `missing field X in initializer of Y` where Y is a `Config` / `HooksConfig` / similar fork-extended struct, AND the failing literal is in a crate that didn't exist on the pre-rebase branch (confirm with `git log --diff-filter=A pre-rebase-$(date -u +%Y-%m-%d).. -- <crate-path>`). Add the missing field with the fork's default value (e.g. `Config.settings_file: None`).
     2. **Missing field at fork-extension callsite of an upstream-extended struct**: same `missing field X` error, but in a *fork-modified* file (e.g. `hooks/src/engine/discovery.rs`). Upstream added a field to a struct (e.g. `HookHandlerSource.plugin_id`) and the fork's older callsite didn't pass it. Add the field with the fork-side default (typically `None` for `Option<T>`, `false` for `bool`, `Vec::new()` for collections).
     3. **Function-signature drift at fork callsite**: `this function takes N arguments but M were supplied` — upstream added a parameter to a function (e.g. `append_hook_events` gained `&mut Vec<HookListEntry>` as 2nd arg) and the fork's older callsite is one arg short. Insert the missing arg, sourcing it from the surrounding context (e.g. `&mut result.hook_entries` if the field exists on the local struct). The error message itself usually shows where to wire it from.
     4. **Cargo.lock version normalization**: `cargo check` rewrites placeholder `0.0.0` versions for crates that upstream just renamed/added. Always expected — stage and amend.

     For all four: patch the fix and re-run `cargo check`. Stage the fix for amending in step 4. If `cargo check` is now clean, continue.

   - **Real regression** — anything else (type errors in fork code, missing methods on fork-extended traits, removed upstream symbols the fork still calls, removed types the fork imports, fork code calling a renamed function, etc.). Roll back: `git rebase --onto "$TAG" upstream/main feat/claude-compat`. Report the failing crate and the first error message. Exit.

3. **Cargo.lock normalization is expected.** When upstream adds new crates, `cargo check` rewrites placeholder `0.0.0` versions in `Cargo.lock` to the workspace version. Don't be surprised by `Cargo.lock` showing as dirty after step 2 — stage it for amending in step 4.

4. **Amend the rebase tip with all step-1/step-2/step-3 fix-ups**:

   ```bash
   git status --short                # confirm only the expected files are dirty
   git add <files>                   # only the fix-up files, not anything unexpected
   git commit --amend --no-edit
   ```

   If `git status` shows files you did not touch in this phase, **stop and report** — don't amend unknown changes.

5. Fork-critical unit tests (hook events + skill loader + version test):

   ```bash
   cargo test --offline -p codex-core-skills -p codex-hooks 2>&1 | tail -10
   cargo test --offline -p codex-cli --test version 2>&1 | tail -5
   ```

   If any test fails: roll back to `$TAG` (same recovery as the real-regression cargo check failure) and report which test failed. Test failures here are not "mechanical fallout" — they signal the fork's behavior diverged from upstream's expectations.

## Phase 5: Build and install the release binary

1. Build:

   ```bash
   cargo build --offline --release -p codex-cli --bin codex 2>&1 | tail -5
   ```

   This typically takes 8–15 minutes (longer than 12 if upstream invalidated significant incremental cache). If the build fails, report the error, leave the branch as-is (do not push), and exit.

2. Install. The cargo target dir is set in `codex-rs/.cargo/config.toml` (`build.target-dir = "/mnt/d/cargo-cache/target"`), NOT in `$CARGO_TARGET_DIR`. **Always ask cargo where it put the binary** rather than guessing — `cargo metadata` is the source of truth and respects all four override channels (config.toml, env var, workspace default, command-line). Resolve defensively:

   ```bash
   TARGET_DIR=$(cargo metadata --format-version=1 --no-deps --offline 2>/dev/null | jq -r .target_directory)
   BIN="$TARGET_DIR/release/codex"
   if [ ! -x "$BIN" ]; then
       echo "FAIL: codex binary not found at $BIN"
       echo "  cargo reported target_directory: $TARGET_DIR"
       echo "  CARGO_TARGET_DIR env: ${CARGO_TARGET_DIR:-<unset>}"
       echo "  Did the build actually finish? Re-check the build log."
       exit 1
   fi
   install -m 755 "$BIN" "$KOOKR_CODEX_BIN"
   ```

3. Sanity-check:

   ```bash
   "$KOOKR_CODEX_BIN" --version
   ```

   The output must be `codex-cli 0.125.0-alpha.3+kookr.<short-sha>`. Verify the `<short-sha>` matches:

   ```bash
   git rev-parse --short=9 feat/claude-compat
   ```

   If the SHAs do not match, the build picked up a stale binary path. Report the mismatch and stop before pushing.

## Phase 6: Force-push to origin

1. Capture the expected origin SHA so `--force-with-lease` is precise (cheaper than the bare flag):

   ```bash
   ORIGIN_SHA=$(git rev-parse origin/feat/claude-compat)
   git push --force-with-lease="feat/claude-compat:$ORIGIN_SHA" origin feat/claude-compat 2>&1 | tail -5
   ```

   `--force-with-lease` (with explicit expected SHA) protects against an unexpected concurrent push to the remote. If it rejects, report and stop — do **not** retry with a plain `--force`.

## Phase 7: Report

State clearly in the final summary:

- The starting tip SHA (the backup-tag commit) and the new tip SHA.
- How many upstream commits were absorbed and how many fork commits were replayed.
- **Conflict-resolution log** — required even when there were zero conflicts (state "no conflicts" then). Format: a small table or list with one row per resolved conflict:

  ```
  Tier | File                              | Fork commit | Decision
  -----|-----------------------------------|-------------|--------------------------------------------
  1    | codex-rs/hooks/src/lib.rs         | cfb7791fb3  | kept upstream HOOK_EVENT_NAMES + fork notification re-exports
  2    | codex-rs/app-server/src/lib.rs    | 973cb9ce95  | took upstream's async EnvironmentManager::new + fork's settings_file capture
  ...
  ```

- **Post-rebase fix-ups amended onto the tip**, if any (e.g. `Config.settings_file: None` added to upstream-new sample crate; HOOK_EVENT_NAMES synced; Cargo.lock version normalization).
- Test results (counts: passed / failed / ignored for each crate).
- The new `+kookr.<sha>` version stamp.
- That the binary is installed at `${KOOKR_CODEX_BIN:-$HOME/bin/codex}` but the production Kookr instance has **not** been auto-restarted — the user must run `pnpm prod:update` (or `pnpm prod:restart`) themselves to pick up the new binary in their running dashboard.

## Idempotency rules

- The Phase 2 short-circuit makes a same-day rerun a no-op (most common outcome).
- The pre-rebase tag uses today's UTC date, so reruns on the same day overwrite the tag (`git tag -f`) rather than accumulating tags.
- Never delete tags from earlier days — they are the recovery path if something the rebase shipped is later found broken.
- The force-push uses `--force-with-lease=feat/claude-compat:<expected-origin-sha>`, so concurrent fork pushes from elsewhere will be detected instead of overwritten.

## Occasional maintenance (NOT part of the daily playbook)

The daily rebase friction is dominated by the fork's eight `wip: rebase phase N` commits (`e47fa41004`, `043ca19fa9`, `ed70096187`, `d28cefbeae`, `003540deda`, `453d689199`, `e3cb465fb6`, `5f34f29b73`). They were authored as ad-hoc rebase fixups months ago and never squashed; each rebase day they re-conflict against newer upstream code in the same regions. **A one-time cleanup that squashes them into 5–7 logical fork commits would substantially reduce daily friction**.

Suggested squash plan (rough — refine before executing):
- All "phase N" commits that touch `hooks/` → squash into one `feat(hooks): add 4 new events + FileChanged + matcher reconciliation`.
- All commits that touch `cli/main.rs` `--settings` plumbing → squash into one `feat(cli): add --settings FILE flag, propagated to hook discovery`.
- All commits that touch `core-plugins/` Claude marketplace + Claude plugin loading → squash into one `feat(core-plugins): support Claude marketplace manifests + enabled plugin roots`.
- Drop the bwrap workaround entirely (commit `d28cefbeae`'s bwrap chunk became redundant on 2026-04-30 when upstream PR #19852 landed; the daily playbook's Tier 2 already drops the chunk every replay).

This is a ONE-TIME rewrite of `feat/claude-compat` — high-friction (force-push of a fully-rewritten history), but it pays back across every future rebase. Don't do this from inside the daily playbook; it's a separate, deliberate, tagged operation.

## Anti-patterns — do not do these

- **Do not** auto-resolve Tier 3 (semantic) conflicts. Tier 1/2 are authorized; Tier 3 must abort and report. When in doubt about classification, treat as Tier 3.
- **Do not** create a separate "chore: rebase fixups" or "fix: post-rebase" commit. Rebase-induced compile fixes and array reconciliations are amended onto the rebase tip via `git commit --amend --no-edit`. The fork commit count must stay stable across rebases.
- **Do not** roll the branch back on a `cargo check` failure without first classifying the error. Mechanical fork-extension fallout (missing fields in upstream-new crates' literals) is patchable; only real regressions warrant a roll-back.
- **Do not** modify any file outside `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` — no Kookr code, no scripts, no docs.
- **Do not** create a Kookr child task for the rebuild — this playbook is the rebuild.
- **Do not** push to `main` or to upstream. The only valid push target is `origin/feat/claude-compat`.
- **Do not** delete the backup tags created on previous days, even if disk pressure suggests it. The tags are the recovery path.
- **Do not** restart the Kookr production instance (no `pnpm prod:update`, no `pnpm prod:restart`). The deployed binary at `${KOOKR_CODEX_BIN:-$HOME/bin/codex}` is updated, but Kookr itself uses whatever it cached at start-up; deciding when to restart is the user's call.
- **Do not** retry a `--force-with-lease` rejection by switching to plain `--force`. A rejection means someone else pushed; investigate before overwriting.
- **Do not** assume the binary is at `codex-rs/target/release/codex`. Always resolve via `cargo metadata --format-version=1 --no-deps --offline | jq -r .target_directory`. The repo's `codex-rs/.cargo/config.toml` sets `build.target-dir = "/mnt/d/cargo-cache/target"`, which `${CARGO_TARGET_DIR:-…}` does NOT see — `CARGO_TARGET_DIR` env-var fallback is wrong here.
- **Do not** amend unknown working-tree changes onto the rebase tip. Before `git commit --amend`, `git status --short` must show only the files you intentionally edited in Phase 4. Unexpected files mean an upstream change you didn't account for — stop and report.
