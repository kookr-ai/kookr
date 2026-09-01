# Codex CLI Setup

Kookr supervises both Claude Code and Codex CLI agents in one dashboard. **Codex CLI requires a maintained fork** — the upstream `openai/codex` is missing the hooks Kookr depends on to monitor Codex agents the same way it monitors Claude Code.

This page is the source of truth for installing the fork and verifying it works with Kookr.

## Why a custom fork

Kookr's supervisor logic uses the Claude Code hook surface — `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `SessionEnd`, and a few more. Upstream `openai/codex` ships with only a subset of these events. The fork at `jeanibarz/codex` on the `feat/claude-compat` branch adds:

- **`PermissionRequest` hook** — fired when Codex blocks on a permission prompt, so Kookr can surface it as a finding.
- **`Notification` hook** — fired when Codex idles, so Kookr can route attention to it.
- **`SubagentStart` / `SubagentStop` hooks** — fired when Codex spawns or finishes a subagent, so Kookr can track child sessions.
- **`SessionEnd` hook** — definitive signal that a Codex session terminated (used for crash recovery and queue cleanup).
- **`PostToolUseFailure` hook** — fired when a tool call exits non-zero, distinguished from a successful `PostToolUse`. Used for anomaly detection.
- **`.claude/skills` and `.claude/agents` loaders** — Codex picks up the same skill and agent files Claude Code uses, so a Kookr repo with `.claude/skills/*` works under both runtimes without duplication.
- **`--settings FILE` plumbing fixed** — upstream silently ignores the flag; the fork wires it through to the hook engine. Without this, Kookr cannot inject its per-session hook configuration.
- **Tolerant frontmatter parsing** — Claude-style YAML frontmatter (with list values, related-skill links, etc.) is accepted instead of rejected.

A deeper gap analysis lives in [`docs/poc/003-codex-compatibility-gaps.md`](poc/003-codex-compatibility-gaps.md).

## Step-by-step setup

### Prepare the fork checkout

Clone the maintained branch once. For an existing checkout, switch to this
branch and pull it instead.

```bash
git clone --branch feat/claude-compat \
  https://github.com/jeanibarz/codex.git "$HOME/git/codex"
```

### Install a development build

From a Kookr checkout, point the helper at a local checkout of the fork:

```bash
CODEX_SRC="$HOME/git/codex" \
CODEX_INSTALL_DIR="$HOME/bin" \
pnpm codex:rebuild
```

This runs `scripts/rebuild-codex.sh` with the `kookr-dev` profile. The profile
keeps release semantics while using faster local compiler settings. The source
checkout must already exist on `feat/claude-compat`; the helper does not change
its branch or pull commits.

If `KOOKR_CODEX_BIN` uses a custom basename, pass the same basename during a
manual rebuild. For example, `KOOKR_CODEX_BIN=$HOME/bin/codex-fork` requires
`CODEX_PUBLIC_CLI_NAME=codex-fork`; the daily sync playbook derives this value
automatically.

### Install a full release build

Set the release profile when preparing a build for long-lived use:

```bash
CODEX_SRC="$HOME/git/codex" \
CODEX_INSTALL_DIR="$HOME/bin" \
CODEX_BUILD_PROFILE=release \
pnpm codex:rebuild
```

Both profiles require a Rust toolchain via [`rustup`](https://rustup.rs). The
fork pins the exact version in `codex-rs/rust-toolchain.toml`, and the helper
uses that version automatically.

### Paired installation layout

The CLI sends local tool requests to the code-mode host over an inter-process
communication (IPC) protocol. The helper treats these executables as one
runtime pair: it prepares both files before changing the active install, then
creates this layout under `CODEX_INSTALL_DIR`:

```text
codex                    -> .codex-current/codex
codex-code-mode-host     -> .codex-current/codex-code-mode-host
.codex-current           -> .codex-releases/<pair-id>
.codex-releases/<pair-id>/codex-pair.json
```

The manifest records the source commit and hashes of both executables. Switching
`.codex-current` activates the complete pair atomically; three validated pairs
are kept by default for rollback. `CODEX_KEEP_RELEASE_PAIRS` changes that bound.

If the host cannot be built locally, the helper accepts a release artifact only
when the matching release tag contains the same code-mode implementation as the
checkout. `CODEX_HOST_FROM_RELEASE=1` requests this path directly, and
`CODEX_HOST_RELEASE_TAG` selects an explicit tag.

Make sure `CODEX_INSTALL_DIR` is on `PATH` (typically `$HOME/bin`).

## Verification

After installation, check the fork version and exercise one real local tool
request across the IPC boundary:

```bash
CODEX_BIN_PATH="${CODEX_INSTALL_DIR:-$HOME/bin}/${CODEX_PUBLIC_CLI_NAME:-codex}"
"$CODEX_BIN_PATH" --version
CODEX_SOURCE_COMMIT=$(git -C "${CODEX_SRC:-$HOME/git/codex}" rev-parse HEAD)
node scripts/smoke-codex-code-mode.mjs \
  --codex "$CODEX_BIN_PATH" \
  --expected-source-commit "$CODEX_SOURCE_COMMIT"
```

You should see output of the form:

```
codex-cli 0.118.0+kookr.<short-sha>
```

The `+kookr.<sha>` suffix confirms you're on the fork build, not upstream. If the worktree was dirty at build time the suffix becomes `+kookr.<sha>.dirty` — rebuild from a clean checkout for a release-quality binary.

If the version command reports anything else (especially `codex-cli 0.0.0` or a version without the `+kookr` suffix), the fork did not install correctly. Re-check `CODEX_INSTALL_DIR` and `CODEX_PUBLIC_CLI_NAME`, then confirm `KOOKR_CODEX_BIN` selects that path. With `--expected-source-commit`, the smoke first verifies that the public CLI and host resolve to one runtime directory and that the manifest source and executable hashes match; it then exercises the IPC round trip. Do not consider an update healthy unless it prints `code-mode IPC smoke passed`.

## Configuration

Kookr finds the Codex binary by checking, in order:

1. `KOOKR_CODEX_BIN` environment variable
2. `CODEX_INSTALL_DIR/codex` (defaults to `$HOME/bin/codex`)
3. `command -v codex` on the user's `PATH`

If your binary isn't on `PATH`, set `KOOKR_CODEX_BIN`:

```bash
export KOOKR_CODEX_BIN="$HOME/bin/codex"
```

Add this to your shell rc file (`~/.bashrc`, `~/.zshrc`) so Kookr inherits it across sessions.

Codex's own per-project configuration lives at `~/.codex/config.toml`. Kookr will inject a `trust_level = "trusted"` entry for any project workdir it launches Codex into, so the first-run trust prompt does not block hook events.

You must also enable the `codex_hooks` feature flag — Kookr passes this automatically when launching agents, but for manual `codex` runs add it explicitly:

```toml
# ~/.codex/config.toml
[features]
codex_hooks = true
```

## Compatibility status

The fork emits 8 of the 12 Claude Code hook events Kookr knows about. The following table reflects the current state (`feat/claude-compat` as of the most recent build):

| Hook event | Status | Notes |
|---|---|---|
| `SessionStart` | works | Fired on agent start |
| `UserPromptSubmit` | works | Fired on every user message |
| `PreToolUse` | works | Fired for shell tool calls (`Bash`) |
| `PostToolUse` | works | Fired on success |
| `PostToolUseFailure` | partial | Advertised but not yet emitted — currently emits regular `PostToolUse` with error text |
| `PermissionRequest` | works | Only fires when not in `--full-auto` mode |
| `Notification` | works | Idle / waiting-for-user signal |
| `Stop` | works | Fired on turn end |
| `StopFailure` | missing | Not yet emitted on API errors |
| `SubagentStart` | missing | Not yet emitted |
| `SubagentStop` | missing | Not yet emitted |
| `SessionEnd` | missing | Not yet emitted |

**Counts:** 8 events working, 1 partial, 3 missing.

For each missing or partial event Kookr applies a transcript-tailing fallback so agent supervision degrades gracefully rather than failing silently. The fallbacks are documented in [`docs/poc/003-codex-compatibility-gaps.md`](poc/003-codex-compatibility-gaps.md) (Gaps 3 and 4).

## Roadmap

The full gap inventory and recommended fix sequence is tracked in [`docs/poc/003-codex-compatibility-gaps.md`](poc/003-codex-compatibility-gaps.md). Top priorities for future fork work, in order:

1. Emit `SessionEnd` on shutdown.
2. Fix `PostToolUseFailure` dispatch (exit-code based).
3. Lazy-start MCP servers or emit `McpServerReady`.
4. Uniform `PreToolUse`/`PostToolUse` dispatch for non-shell tools (file ops, MCP calls, `apply_patch`).
5. Emit `SubagentStart` / `SubagentStop` for Codex's multi-agent mode (if it produces observable child sessions).

Contributions to the fork are welcome — open issues against `jeanibarz/codex` on the `feat/claude-compat` branch.

## Updating the fork

To pull the latest fork changes:

```bash
cd "$HOME/git/codex"
git checkout feat/claude-compat
git pull
cd /path/to/kookr
CODEX_SRC="$HOME/git/codex" pnpm codex:rebuild
```

Re-run both verification commands above to confirm the short SHA updated and
the installed pair can exchange a real tool result.

## Troubleshooting

- **`codex --version` reports `0.0.0`** — you're running upstream or a stale build. Rebuild from `feat/claude-compat`.
- **`codex` not found** — confirm `$CODEX_INSTALL_DIR` is on `PATH`, or set `KOOKR_CODEX_BIN` explicitly.
- **Codex agents launch but Kookr sees no events** — confirm `[features] codex_hooks = true` in `~/.codex/config.toml`. Kookr also passes `-c features.codex_hooks=true` on launch, but the config-file entry helps for manual debugging.
- **Codex hangs forever in MCP server startup** — known issue (Gap 10 in the PoC). Kookr's adapter parses the TUI status text to avoid firing a "stuck agent" anomaly during this phase; if you see it on a manual run, wait or relaunch with `--no-mcp` if available.
- **Trust prompt blocks the first Codex run in a new directory** — Kookr writes the trust entry automatically. For manual runs, add `[projects."/abs/path"] trust_level = "trusted"` to `~/.codex/config.toml`.

## Related

- [`docs/poc/003-codex-compatibility-gaps.md`](poc/003-codex-compatibility-gaps.md) — full empirical gap inventory
- [Architecture](architecture.md) — where the Codex adapter sits in the system
- [Getting Started](getting-started.md) — Kookr install and first agent
- Fork on GitHub: https://github.com/jeanibarz/codex/tree/feat/claude-compat
