---
name: kookr-codex-claude-compatibility
description: Make Codex CLI behave more like Claude Code for Kookr by preserving the known fork, branch, build, deploy, and live-verification workflow for Claude-compatible skills, agents, settings, hooks, and related UX.
keywords: codex, claude, compatibility, codex cli, claude code, skills, agents, subagents, settings, permissions, hooks, costs, kookr, deploy, rebuild, app-server
related: claude-code-permissions, claude-code-hooks, self-reflect, token-efficiency
---

# Codex Claude Compatibility

## When to Use

- The user asks to make Codex CLI more similar to Claude Code
- The task touches Claude-compatible `.claude/skills` or `.claude/agents` behavior in Codex
- The task involves Codex settings, permission semantics, hooks, cost surfacing, or Kookr integration
- You need to rebuild or redeploy the custom Codex binary used by Kookr
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

### Claude model alias mapping

Map Claude names to Codex model strings:

- `opus` -> `gpt-5.4`
- `sonnet` -> `gpt-5.4`
- `haiku` -> `gpt-5.4-mini`

Use the Codex model names exactly as hyphenated above. `gpt5.4` is not the right slug.

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

Build from the single fork checkout, on `feat/claude-compat`:

```bash
KOOKR_CODEX_CHECKOUT="${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}"
cd "$KOOKR_CODEX_CHECKOUT" && git checkout feat/claude-compat && git pull
cargo +1.93.0 build \
  --manifest-path "$KOOKR_CODEX_CHECKOUT/codex-rs/Cargo.toml" \
  -p codex-cli \
  --release
```

Or use the Kookr helper: `pnpm codex:rebuild` (runs `scripts/rebuild-codex.sh`, uses `CODEX_SRC=$HOME/git/codex`).

Install the built binary for Kookr use:

```bash
CODEX_SRC="${CODEX_SRC:-${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}}"
CODEX_INSTALL_DIR="${CODEX_INSTALL_DIR:-$HOME/bin}"
MANIFEST="$CODEX_SRC/codex-rs/Cargo.toml"
TARGET_DIR="$(cargo +1.93.0 metadata --manifest-path "$MANIFEST" --no-deps --format-version 1 | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));')"

install -m 755 "$TARGET_DIR/release/codex" "$CODEX_INSTALL_DIR/codex"
```

Do not assume the binary lives under `codex-rs/target/release`. Some machines set Cargo's target directory outside the repo, for example `/mnt/d/cargo-target`. Use `cargo metadata`'s `target_directory` value when locating the built binary.

Sanity check:

```bash
"${CODEX_INSTALL_DIR:-$HOME/bin}/codex" --version
```

Kookr should use `${KOOKR_CODEX_BIN:-${CODEX_INSTALL_DIR:-$HOME/bin}/codex}` as the deployed custom Codex binary.

If you had to use an alternate checkout or target dir for a one-off rebuild, do not leave that as the operating model. The final committed source of truth must still be `feat/claude-compat` in `${KOOKR_CODEX_CHECKOUT:-$HOME/git/codex}`.

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
cargo +1.93.0 run \
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
- **`codex_hooks` feature flag is off by default.** Enable via `-c features.codex_hooks=true` or `[features] codex_hooks = true` in `~/.codex/config.toml`.
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
