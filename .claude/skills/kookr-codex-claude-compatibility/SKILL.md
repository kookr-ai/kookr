---
name: kookr-codex-claude-compatibility
description: Make Codex CLI behave more like Claude Code for Kookr by preserving the known fork, branch, build, deploy, daily upstream sync, and live-verification workflow for Claude-compatible skills, agents, settings, hooks, and related UX.
keywords: codex, claude, compatibility, codex cli, claude code, skills, agents, subagents, settings, permissions, hooks, costs, kookr, deploy, rebuild, app-server, daily upstream sync, feat/claude-compat, upstream/main, gh pr create, pre-pr-review
related: claude-code-permissions, claude-code-hooks, self-reflect, token-efficiency, pre-pr-review
---

# Codex Claude Compatibility

## When to Use

- The user asks to make Codex CLI more similar to Claude Code
- The task touches Claude-compatible `.claude/skills` or `.claude/agents` behavior in Codex
- The task involves Codex settings, permission semantics, hooks, cost surfacing, or Kookr integration
- You need to rebuild or redeploy the custom Codex binary used by Kookr
- You need to sync `feat/claude-compat` with `upstream/main`
- You need the shortest path back into the Codex fork without rediscovering repo state

## Reference Principle

**Claude Code is the reference behavior.** Treat Codex CLI as the implementation being adapted toward Claude compatibility, not the other way around.

For parity work, prefer:

1. Confirm how Claude Code behaves
2. Find the corresponding Codex implementation point
3. Patch Codex to match the Claude-facing workflow and file formats where practical
4. Verify in a real Kookr-adjacent process, not just with unit-level reasoning

## Known Codex Fork Layout

### Single Claude-compat branch

All Claude-Code compatibility work lives on **`feat/claude-compat`** in the fork (`jeanibarz/codex`). The main fork checkout is configured with `KOOKR_CODEX_CHECKOUT` and defaults to `$HOME/git/codex`; it should remain the only persistent worktree.

Branch state (as of 2026-04-05 consolidation):

- `main` — fork's sync point with `openai/codex` upstream
- `feat/claude-compat` — the active Claude-compat branch, contains:
  - Claude skill loader (`.claude/skills`, frontmatter tolerance)
  - Claude agent loader (`.claude/agents`)
  - `PermissionRequest`, `Notification`, `PostToolUseFailure` hook events
  - Claude paths in docs/prompts/fixtures (replaces `.agents`/`.codex` defaults)
  - `.claude/plugins/marketplace.json` primary path with `.agents/` legacy fallback
  - the hook-parity compatibility batch including commit `af0c99a14`

Work directly on `feat/claude-compat`.

Operational rule:

- Do not create long-lived compat branches such as `feat/codex-hook-parity`
- Do not keep separate Codex build worktrees around after the task
- If you temporarily need a throwaway checkout for validation or merge recovery, merge the result back into `feat/claude-compat`, push it, and delete the temporary worktree before concluding the task

## Compatibility Already Implemented

### Claude skills

- Codex now loads repo and user skills from `.claude/skills`
- It no longer treats `.agents` as a skill root
- The skill loader tolerates Claude-style frontmatter extras that Codex does not model directly
- This specifically fixed failures caused by lines like `related: [[foo]], [[bar]]`

### Claude agents

- Codex now discovers markdown agents from `.claude/agents`
- It parses Claude-style markdown agent files with YAML frontmatter
- Imported Kookr roles were verified in a real live spawned subagent flow

### `spawn_agent` skill-workflow authorization (v1)

The v1 `spawn_agent` tool description originally restricted invocation strictly to "the user explicitly asks for sub-agents", which blocked legitimate skill-driven workflows. Kookr's pre-PR reviewer-specialist spawn was the canonical failure case — codex sessions hitting the `.hooks/pre-push` review-marker gate would refuse to call `spawn_agent` and fall back to fabricating the marker via shell instead, defeating the gate.

The fork's `multi_agents_spec.rs` now exposes two explicit authorization clauses:

- **(a)** the user explicitly asks for sub-agents, delegation, or parallel agent work, OR
- **(b)** a skill or workflow you are currently executing explicitly instructs you to spawn sub-agents — e.g. a pre-PR review skill that prescribes parallel reviewer-specialist sub-agents, or an agent role definition that names specific sub-agents to invoke.

Clause (a) preserves the original safety intent against reflexive delegation on free-form research tasks. Clause (b) authorizes the loaded-skill case. The pair is pinned by `spawn_agent_tool_v1_description_authorizes_skill_workflow_spawns` in `multi_agents_spec_tests.rs` so a future tightening cannot silently regress this.

This applies to v1 only (`Feature::Collab`, default enabled). The v2 description (`Feature::MultiAgentV2`, default disabled) does not carry the original restriction.

### Claude model alias mapping

Map Claude agent aliases to the Kookr Codex fork's Luna model and role effort:

- `opus` -> `gpt-5.6-luna`, `model_reasoning_effort = "max"`
- `sonnet` -> `gpt-5.6-luna`, `model_reasoning_effort = "high"`
- `haiku` -> `gpt-5.6-luna`, `model_reasoning_effort = "medium"`

Kookr's top-level Codex launches default to `gpt-5.6-sol` with **no**
`model_reasoning_effort` override (model-native default). Override the model
with `KOOKR_CODEX_MODEL` (e.g. `gpt-5.6-luna`) and/or set `agentEffort.codex-cli`
in settings / per-task `--effort`. An explicit top-level `ultra` effort always
selects `gpt-5.6-sol`, because Luna's advertised reasoning ceiling is `max`.

## Build and Deploy Workflow

### Versioning rule for Kookr Codex builds

Do not leave the fork at `0.0.0`, and do not hardcode the commit SHA in `Cargo.toml`.

Use this scheme:

- Base version in `codex-rs/Cargo.toml` tracks upstream, e.g. `0.118.0`
- Build metadata is injected at build time from git
- Final deployed version format: `<upstream-version>+kookr.<short-sha>`
- If the worktree is dirty at build time, append `.dirty`

Examples:

- `0.118.0+kookr.4dfed7ea3`
- `0.118.0+kookr.4dfed7ea3.dirty`

Operational rule:

- Prefer a shared build-script implementation that derives the SHA from `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}`
- Make `codex --version` the primary sanity check after install
- Keep runtime/UI/app-server version surfaces aligned with the same build version where practical
- After changing versioning, rebuild and reinstall `${KOOKR_CODEX_BIN:-$HOME/bin/codex}` before concluding the task

Build from the single fork checkout, on `feat/claude-compat`. Use the Kookr
helper so the toolchain pinned in `codex-rs/rust-toolchain.toml` is selected
automatically and both wire-compatible executables are prepared before the
active installation changes:

```bash
KOOKR_CODEX_CHECKOUT="${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}"
cd "$KOOKR_CODEX_CHECKOUT" && git checkout feat/claude-compat && git pull --ff-only
cd "${KOOKR_ROOT:-$HOME/git/kookr}" && \
  CODEX_SRC="$KOOKR_CODEX_CHECKOUT" pnpm codex:rebuild
```

`scripts/rebuild-codex.sh` builds `codex` and `codex-code-mode-host` from the
same checkout. It stores them together in a versioned directory and switches
the `.codex-current` pointer only after both artifacts are ready. Never install
one of these executables independently: the code-mode wire schema can change
without a version bump, and a mixed pair can execute a command before failing
to decode its result.

For a custom `KOOKR_CODEX_BIN` basename, pass that basename as
`CODEX_PUBLIC_CLI_NAME`; the sync playbook does this automatically.

An official release host is a fallback only when its local git tag has the same
`code-mode-protocol`, `code-mode-host`, and `code-mode-runtime` sources as the
checkout. A similar release version is not proof of compatibility.

Do not assume the binary lives under `codex-rs/target/release`. Some machines set Cargo's target directory outside the repo, for example `/mnt/d/cargo-target`. Use `cargo metadata`'s `target_directory` value when locating the built binary.

Sanity checks:

```bash
CODEX_BIN_PATH="${CODEX_INSTALL_DIR:-$HOME/bin}/${CODEX_PUBLIC_CLI_NAME:-codex}"
"$CODEX_BIN_PATH" --version
CODEX_SOURCE_COMMIT=$(git -C "${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}" rev-parse HEAD)
node "${KOOKR_ROOT:-$HOME/git/kookr}/scripts/smoke-codex-code-mode.mjs" \
  --codex "$CODEX_BIN_PATH" \
  --expected-source-commit "$CODEX_SOURCE_COMMIT"
```

The expected source commit check requires both public executable paths to
resolve to the same runtime directory and verifies the manifest hashes before
the real IPC round trip.

Kookr should use `${KOOKR_CODEX_BIN:-${CODEX_INSTALL_DIR:-$HOME/bin}/codex}` as the deployed custom Codex binary.

If you had to use an alternate checkout or target dir for a one-off rebuild, do not leave that as the operating model. The final committed source of truth must still be `feat/claude-compat` in `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}`.

## Daily Upstream Sync Gotchas

When keeping `feat/claude-compat` current with `upstream/main`, use the auditable sync-PR workflow rather than rebasing or force-pushing the integration branch.

### Pre-PR review must happen before `gh pr create`

The local `pr-workflow-gate` hook blocks `gh pr create` unless the `pre-pr-review` skill has created its gate marker. Run the pre-PR review after the sync branch passes local verification and before the first `gh pr create` attempt.

For a pure upstream sync, focus reviewer specialists on the merge-resolution and sync fix-up commits, not on re-reviewing every upstream commit. Ask them to inspect:

- conflicted files resolved in the merge commit
- generated schema reconciliation
- any post-merge fix-up commits
- release/version/install behavior touched by the sync

Fix blocking reviewer findings, rerun the affected local verification, and push the updated sync branch before creating the PR.

### Use a literal `--head` branch in `gh pr create`

Do not pass the sync branch to `gh pr create` through a shell variable such as `--head "$SYNC_BRANCH"`. The local `pr-workflow-gate` parses the raw shell command text before shell expansion, so a variable can make it look for the wrong gate marker.

Use a literal head branch in the actual `gh pr create` command:

```bash
gh pr create \
  --repo jeanibarz/codex \
  --base feat/claude-compat \
  --head sync/upstream-main-YYYYMMDD \
  --title "sync: merge upstream/main into feat/claude-compat (YYYY-MM-DD)" \
  --body "..."
```

If you need shell variables to assemble text, expand them before the command or write the final literal command explicitly.

### Treat `gh pr merge` local git failures as ambiguous

`gh pr merge --merge --delete-branch` can merge the PR remotely and still exit nonzero while doing local git cleanup. One known failure is:

```text
fatal: 'main' is already checked out at '...'
```

If `gh pr merge` exits nonzero after contacting GitHub, do not retry blindly and do not stop for user intervention. First inspect the remote PR:

```bash
gh pr view "$PR_URL" --json state,mergedAt,mergeCommit,url
git ls-remote --heads origin feat/claude-compat "$SYNC_BRANCH"
```

If the PR state is `MERGED`, continue with Phase 6 from the remote merge commit:

1. `git fetch origin`
2. Fast-forward the main checkout's `feat/claude-compat`
3. Build and install from the final integration branch
4. Delete the remote sync branch manually if `--delete-branch` did not do it:

```bash
git push origin --delete "$SYNC_BRANCH"
```

Only stop if the PR is still open or the base branch did not advance to the reported merge commit.

## Real Verification Workflow

Do not stop at static inspection when the change affects runtime compatibility.

### For skills

- Start Codex against the target repo/workspace
- Confirm the expected `.claude/skills` entries are present in the available skill list
- If skills fail to load, inspect the Codex loader before blaming the skill files

### For agents and subagents

Use a real spawned imported role, not a generic agent with copied instructions.

1. Start app-server from the deployed binary:

```bash
KOOKR_CODEX_BIN="${KOOKR_CODEX_BIN:-$(command -v codex)}"
"$KOOKR_CODEX_BIN" app-server --listen ws://127.0.0.1:4222
```

2. Drive it with the Codex app-server test client:

```bash
KOOKR_CODEX_CHECKOUT="${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}"
cargo +1.95.0 run \
  --manifest-path "$KOOKR_CODEX_CHECKOUT/codex-rs/Cargo.toml" \
  -p codex-app-server-test-client \
  -- \
  --url ws://127.0.0.1:4222 \
  send-message-v2 --experimental-api 'Spawn the `failure-mode-analyst` subagent. Ask it to reply with exactly one short sentence identifying itself as the failure-mode-analyst role. Then report back with that sentence and nothing else.'
```

3. Verify the spawned child thread with `thread-resume`

The proof surface is the child thread metadata, not just the parent response. A real imported role should show:

- `agentRole` set to the imported Claude role name
- `source` set to `SubAgent(...)`
- child turn history containing the role-specific reply

Known live verification already succeeded with Kookr:

- parent thread: `019d57b4-4557-7b30-96aa-31e617bdcbfa`
- child thread: `019d57b4-6731-7d61-9f10-ffd45f1f9145`
- imported role: `failure-mode-analyst`
- child reply: `I am the failure-mode analyst.`

This proved Codex was using the imported `.claude/agents` role metadata in a real process.

## Known Gaps — Empirically Mapped

**Before starting any new compatibility work, read `docs/poc/003-codex-compatibility-gaps.md`.**

That PoC runs both CLIs with identical hook settings and documents 10 concrete gaps with their exact fix locations (fork vs Kookr) and severity. Each gap is tracked as a GitHub issue on `kookr-ai/kookr` for one-at-a-time execution in the recommended sequence. Search issues with label `codex-compat` for the current list.

Top findings to know before editing the adapter or the fork:

- **`--settings FILE` was previously silently broken in the installed binary.** The hook-parity batch fixed the root CLI plumbing and added regressions; if this regresses again, treat it as a critical blocker because Kookr loses hook coverage.
- **Settings parsing regressed again on 2026-06-12 via upstream sync — strict `HooksFile`.** Upstream parses settings JSON with `#[serde(deny_unknown_fields)]` and only a `hooks` member; Kookr settings files carry `permissions` alongside `hooks`, so the whole file was rejected (warning only: `unknown field "permissions", expected "hooks"`) and every codex session launched after the binary swap ran with zero hooks. Fixed in fork commit `8f21230e8d` (tolerant `ClaudeSettingsHooks` struct in `codex-rs/hooks/src/engine/discovery.rs`, used for `--settings` files and `.claude/settings.json` layers; codex-native `hooks.json` stays strict). Regression tests: `settings_file_with_claude_top_level_keys_still_loads_hooks`, `claude_settings_with_top_level_permissions_still_load_hooks`. **After every upstream sync, smoke-test hooks with a production-shaped settings file (one that includes `permissions`), in TUI mode, not just `exec`.**
- **Hook-coverage debugging gotchas (from the 2026-06-12 incident):** a missing `~/.kookr/hooks/<session>.jsonl` has at least three distinct causes — (1) settings file rejected by the strict parser (above); (2) untrusted project directory: the TUI blocks on the trust onboarding screen before any session starts, so headless dtach launches in a never-seen cwd produce no session and no hooks (`codex exec` does not show this screen); (3) running sessions keep their in-memory binary — swapping `~/bin/codex` only fixes *new* launches, existing hook-silent sessions must be restarted. Also note `codex exec --dangerously-bypass-approvals-and-sandbox` persists a `[projects."<cwd>"]` trust entry in `~/.codex/config.toml`, which can silently change repro behavior between runs in the same scratch dir.
- **`codex_hooks` feature flag graduated.** The key is now `hooks`, **stable and enabled by default**; `codex_hooks` is a deprecated legacy alias that prints a startup deprecation warning. The adapter's `-c features.codex_hooks=true` is harmless but obsolete and can be dropped.
- **Codex emits 8/12 hook events.** Missing: `SessionEnd`, `StopFailure`, `SubagentStart`, `SubagentStop`.
- **Payload format is ~95% compatible.** Same event names, same field names, same PascalCase, same `tool_name: "Bash"`, `tool_input.command` is a **string** (not an array as earlier RFCs guessed).

When patching the fork, patch `feat/claude-compat` directly. Do not resurrect older compatibility branches or use a sync branch as the primary place where the work lives.

## Areas Still Worth Pursuing

When the user asks for more Claude compatibility, check these next:

- permission semantics and config parity with Claude settings
- hook and settings compatibility, especially `.claude/settings.json` behavior
- Claude-style UX around permission prompting and default modes
- cost and usage surfacing so Kookr can show Codex spend similarly to Claude sessions
- any file-format or frontmatter differences that Claude accepts but Codex still rejects

## Working Pattern for New Compatibility Fixes

1. Reproduce the gap using the real deployed binary or the main `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` checkout on `feat/claude-compat`
2. Inspect the Codex implementation in `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}`
3. Patch the minimal compatibility layer instead of rewriting Claude assets
4. Add a regression test in the Codex fork whenever the issue is deterministic
5. Build and deploy `${KOOKR_CODEX_BIN:-$HOME/bin/codex}`
6. Re-verify in a live Kookr-adjacent process
7. Commit, push, and record the new behavior here if it is reusable

## Notes

- `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` on `feat/claude-compat` is the only persistent Codex checkout to rely on
- If `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` is dirty, either work carefully with those changes or stop and resolve the ownership conflict before proceeding
- Before ending a task, make sure `git worktree list` for `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}` only shows the main checkout unless the user explicitly asked to keep an extra worktree
- If a future compatibility fix produces reusable operational knowledge, update this skill rather than leaving the knowledge in chat history
