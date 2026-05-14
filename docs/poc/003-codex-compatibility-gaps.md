# PoC 003: Codex CLI vs Claude Code Compatibility Gaps

> **Date:** 2026-04-04
> **Purpose:** Empirically identify every feature that works with Claude Code but breaks with Codex CLI under Kookr's supervisor model
> **Environment:** Claude Code v2.1.92, Codex CLI v0.0.0 (fork `feat/codex-hook-parity`), Linux (WSL2)
> **Artifact:** `003-codex-compatibility-gaps/run-poc.sh` + raw results in `/tmp/poc-codex-compat/`

## Purpose

Kookr's supervisor agent relies on Claude Code hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `PermissionRequest`, `Notification`, `UserPromptSubmit`, `SessionEnd` …) to know what managed agents are doing. The Codex CLI adapter (`src/adapters/codex-cli-adapter.ts`) launches Codex with the same `--settings FILE` flag Claude Code uses, assuming hook parity. This PoC tests that assumption end-to-end by running both CLIs with identical hook settings, capturing every hook event, and diffing behaviour.

## Test harness

`run-poc.sh` launches, in the same temp workdir, the same prompt through four paths:

1. **Claude Code `--print` (non-interactive)** — baseline reference
2. **Codex `exec --json` (non-interactive)** — the closest Codex equivalent
3. **Claude Code interactive in tmux** — the Kookr-managed mode
4. **Codex CLI interactive in tmux** — the Kookr-managed mode (exactly as `CodexCliAdapter.launch()` does)

Each path uses a 12-event hook settings file (the full Claude Code surface) that appends raw JSON to a per-agent JSONL file. A Python script then counts and diffs the events.

Prompt used: `Read the file test.txt and tell me what it contains. Then create a file called output.txt with the text "done".`

## Findings

### Hook event coverage

| Event | Claude Code (`--print`) | Codex `exec --json` (via hooks.json) | Codex interactive (via hooks.json) |
|---|---|---|---|
| `SessionStart` | ✅ fired | ✅ fired | ✅ fired |
| `UserPromptSubmit` | ✅ fired | ✅ fired | ✅ fired |
| `PreToolUse` | ✅ fired (PascalCase tools: `Read`, `Write`) | ✅ fired (PascalCase tool: `Bash`) | ⚠️ didn't complete in POC (blocked on MCP startup) |
| `PostToolUse` | ✅ fired | ✅ fired | ⚠️ idem |
| `PostToolUseFailure` | ✅ would fire on failure | ❌ **advertised but never fires** (see Gap 4) | ❌ idem |
| `PermissionRequest` | ✅ available | ✅ available (only fires when not `--full-auto`) | ✅ available |
| `Notification` | ✅ fires on idle | ✅ supported | ✅ supported |
| `Stop` | ✅ fired | ✅ fired | ⚠️ idem |
| `StopFailure` | ✅ available | ❌ **not emitted** | ❌ not emitted |
| `SubagentStart` | ✅ available | ❌ **not emitted** | ❌ not emitted |
| `SubagentStop` | ✅ available | ❌ **not emitted** | ❌ not emitted |
| `SessionEnd` | ✅ fired | ❌ **not emitted** | ❌ not emitted |

**Summary:** Codex supports 8/12 events at the schema level (`supported_events` advertised on `SessionStart`); of those, 7 actually fire (Notification is idle-only and not observed in short turns); 4 Claude-surface events are entirely missing.

### Hook payload format

Good news: the payload format is **remarkably close** to Claude Code's.

| Field | Claude Code | Codex CLI | Same? |
|---|---|---|---|
| `session_id` | UUID | UUID v7 | ✅ |
| `transcript_path` | `~/.claude/projects/<hash>/<uuid>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-<...>.jsonl` | ✅ (both JSONL, different paths) |
| `cwd` | absolute path | absolute path | ✅ |
| `hook_event_name` | PascalCase string | PascalCase string | ✅ |
| `permission_mode` | `bypassPermissions` / `default` / `plan` | `bypassPermissions` / `default` | ✅ |
| `tool_name` | `Bash`, `Read`, `Write`, `Edit` … | **`Bash`** for shell commands | ✅ for shell, ❌ for file ops (see Gap 6) |
| `tool_input.command` | **string** for Bash | **string** for Bash | ✅ (disproves the RFC's "array" assumption) |
| `tool_response` | structured (e.g. `{"type":"text","file":{"filePath":...}}`) | **plain string** (e.g. `"Hello World\n"`) | ❌ (Gap 5) |
| `turn_id` | not present | present | Codex adds |
| `model` | not present | present (e.g. `"gpt-5.4"`) | Codex adds |

Extra Codex-only fields (`turn_id`, `model`) are harmless — the current `parseHookEvent()` ignores unknown keys.

`SessionStart` additionally carries `codex_hook_capabilities` with `supported_events` and `handler_features` — useful for feature-detection in the adapter.

### Gap inventory

#### Gap 1 — **CRITICAL: `--settings FILE` silently fails to load hooks**

**Observed:** Passing a valid hooks JSON via `--settings` to either `codex` or `codex exec` does NOT load the hooks. The flag is accepted without error; the hook discovery code path is never hit. `~/.codex/hooks.json` at the user config location DOES work, and a definitive A/B test (remove hooks.json → pass --settings → zero events; add hooks.json → remove --settings → 7 events) proved the flag is a no-op.

**Evidence:**
- Binary `~/bin/codex` is md5-identical to `$HOME/git/codex-hook-parity/codex-rs/target/release/codex` (the `feat/codex-hook-parity` build)
- Plumbing exists in source: `main.rs:87` → `config_override.rs:44` → `config.rs:1853` → `engine/discovery.rs:123` has `load_hooks_from_file()`
- `codex features list` confirms `codex_hooks = true` (after manually enabling in `config.toml`)
- `RUST_LOG=trace` logs contain zero mentions of `settings_file`, `discover_handlers`, or `ClaudeHooksEngine` during the `--settings` path
- Same binary + `~/.codex/hooks.json` + no `--settings` → hooks fire correctly

**Why it's critical for Kookr:** `CodexCliAdapter.launch()` (line 72) passes `--settings <per-session-path>`. **Every Codex session launched through Kookr today has zero hook coverage** — Kookr sees no `SessionStart`, no `Stop`, no `PreToolUse`. The supervisor is blind to Codex agents.

**Fix location:** **Codex fork.** The discovery function signature was extended but something in the call chain between CLI parsing and `ClaudeHooksEngine::new()` isn't threading `settings_file` through. Needs a single regression test: `codex exec --settings <file>` → assert one hook fires.

**Workaround:** Kookr can drop a session-specific `hooks.json` into a per-session config-layer folder that Codex already scans, bypassing `--settings` entirely.

---

#### Gap 2 — `codex_hooks` feature flag is disabled by default

**Observed:** Even with a valid `hooks.json` and a working `--settings`, hooks do not fire unless the `codex_hooks` feature is enabled via:
- `[features] codex_hooks = true` in `~/.codex/config.toml`, OR
- `-c features.codex_hooks=true` on the CLI, OR
- `--enable codex_hooks`

**Source:** `hooks/src/engine/mod.rs:86-92` — if `enabled=false`, `ClaudeHooksEngine::new()` returns with an empty handlers list.

**Why it matters:** Kookr users who install Codex fresh will have hooks silently disabled. Kookr's adapter cannot assume user config has the flag set.

**Fix location:** **Kookr adapter.** Append `-c features.codex_hooks=true` to every Codex launch command. Two lines in `src/adapters/codex-cli-adapter.ts:72`.

---

#### Gap 3 — Four Claude hook events not implemented in Codex

**Observed:** Codex fork emits 8 of Claude Code's 12 hook event types. These four do not exist:

| Missing event | Kookr uses it for |
|---|---|
| `StopFailure` | API error detection (rate_limit, billing, auth) |
| `SubagentStart` | Track subagent activity (F1.x) |
| `SubagentStop` | Track subagent lifecycle |
| `SessionEnd` | Definitive "session terminated" signal for crash recovery |

**Impact:** Kookr cannot reliably detect Codex session termination, cannot distinguish API errors from idle, cannot track Codex's parallel-agent execution (if any).

**Fix location:** **Codex fork.** Ordered by value to Kookr:
1. `SessionEnd` — 1-line emit at `codex.rs` shutdown path. Highest value.
2. `StopFailure` — fires when a turn ends with an API error. Needs error-path instrumentation.
3. `SubagentStart`/`SubagentStop` — only if Codex's multi-agent mode produces observable child sessions. Lowest priority.

**Kookr-side fallback:** Infer session-end from tmux session death (already done) + transcript-file inactivity. Infer API errors from stderr parsing of `ThreadError` / `TurnFailed` JSONL items.

---

#### Gap 4 — `PostToolUseFailure` advertised but never emitted

**Observed:** `SessionStart.codex_hook_capabilities.supported_events` lists `PostToolUseFailure`, but deliberately running `ls /nonexistent/dir` emits a regular `PostToolUse` with the error text inside `tool_response: "ls: cannot access ..."`, not `PostToolUseFailure`.

**Why it matters:** Kookr's `PostToolUseFailure` handler (in `parseHookEvent`) is a dedicated anomaly signal. Codex collapsing everything into `PostToolUse` means failed commands can only be inferred by string-matching error messages.

**Fix location:** **Codex fork.** `hook_runtime.rs` should dispatch `PostToolUseFailure` when exit code != 0 OR stderr is non-empty. Currently it dispatches `PostToolUse` for both success and failure.

**Kookr-side fallback:** In the Codex adapter, post-process `tool_result` events: if `tool_response` contains known error patterns (`command not found`, `No such file`, `exit code:`) emit a synthetic `tool_error` event.

---

#### Gap 5 — `tool_response` is a bare string, not a structured object

**Observed:**

| CLI | Payload example |
|---|---|
| Claude Code | `"tool_response": {"type":"text","file":{"filePath":"...","content":"Hello World\n","numLines":2,...}}` |
| Codex CLI | `"tool_response": "Hello World\n"` |

**Why it matters:** Claude's structured payloads are self-describing (Kookr can show "file created / edited / read N lines"). Codex's plain-string payloads force Kookr to parse raw text to infer what happened.

**Fix location:** **Kookr.** The hook parser already handles both (`parseHookEvent` doesn't assume a type). The frontend may need a conditional render. **No Codex-fork change necessary.**

---

#### Gap 6 — Hooks only fire for shell tool calls (file ops have none)

**Observed:** `pre_tool_use_payload` is implemented only in `tools/handlers/shell.rs` and `tools/handlers/unified_exec.rs`. File-system operations, MCP tool calls, `apply_patch`, and `web_search` do not fire `PreToolUse`/`PostToolUse` hooks.

**In practice this is less severe than it sounds**, because Codex does most filesystem work by synthesising `bash -lc` commands — so a `cat file.txt` or `mkdir -p x` still fires hooks. But `apply_patch` (Codex's native patch mechanism) is invisible to hooks, and MCP tool calls (Playwright browser, etc.) emit no hook events.

**Fix location:** **Codex fork.** Extend every `ToolHandler` impl with a `pre_tool_use_payload()` / `post_tool_use_payload()` method. Or better: do it once at the dispatch layer so all tools are covered uniformly.

**Kookr-side fallback:** Tail the Codex `rollout-*.jsonl` transcript (listed in `transcript_path` on every hook event) to see `file_change`, `apply_patch`, and `mcp_tool_call` items.

---

#### Gap 7 — Interactive Codex renders hook status to the TUI

**Observed:** In interactive mode the TUI prints the name of each running hook to the user-visible panel:

```
• Running SessionStart hook
SessionStart hook (completed)
• Running UserPromptSubmit hook
UserPromptSubmit hook (completed)
```

**Why it matters:** Kookr captures the tmux pane for display. These messages clutter the user-facing view and change the visual profile of Codex vs Claude sessions.

**Fix location:** **Codex fork.** Add a `--quiet-hooks` flag, or silence hook status when stdout is not a TTY, or suppress status text for external/supervisor hooks.

**Kookr-side fallback:** Filter these lines when rendering the terminal snapshot.

---

#### Gap 8 — Workspace trust prompt blocks first-run interactive

**Observed:** Both `claude` and `codex` (interactive) present a full-screen "do you trust this folder?" dialog on first launch in a given workdir. In tmux this dialog waits for keystroke input. Kookr's current adapter just launches and walks away, so the first Codex/Claude session in any new workdir **hangs forever** with zero hook events.

**Fix location:** **Kookr.**
- For Codex: programmatically add `[projects."/abs/path"] trust_level = "trusted"` to `~/.codex/config.toml` before launch.
- For Claude Code: Claude doesn't persist trust the same way; investigate `--add-dir` / auto-answer options, or pre-approve via keystroke injection.

**Fix location (alt):** **Codex fork.** Add `--trust-workspace` flag to skip the prompt for supervised launches.

---

#### Gap 9 — Codex installed binary version is out of date

**Observed:** `codex --version` → `codex-cli 0.0.0`. Upstream latest: 0.118.0 (shown in TUI banner). The fork has never synced a real version string into the build.

**Why it matters:** Mostly cosmetic, but also means upstream hook-related fixes (e.g. `[c4d9887f9] add non-streaming (non-stdin style) shell-only PostToolUse support`) may be missing from Kookr's build.

**Fix location:** **Codex fork.** Stamp the build with the upstream version + a fork identifier (e.g. `0.118.0+kookr`).

---

#### Gap 10 — Interactive mode hangs on MCP server startup before any agent work

**Observed:** `codex --full-auto 'Run ls'` in tmux fired `SessionStart` + `UserPromptSubmit`, then sat for >60s showing `Starting MCP servers (1/2): playwright (4s • esc to interrupt)`. The actual prompt was never executed in the POC window.

**Why it matters:** Kookr's idle detection will see a Codex session emit two hooks, then silence, then eventually a `Stop` much later. This will look like a stuck agent to the supervisor unless MCP startup delay is modelled.

**Fix location:**
- **Codex fork:** make MCP servers lazy-start (only when a tool is called). Or add a hook event for `McpServerReady` / `McpServerStartTimeout`.
- **Kookr:** parse the TUI text and display "MCP starting" as an explicit status; don't fire "stuck" anomaly during this phase.

---

#### Gap 11 — `--plugin-dir` registers skills+agents but NOT plugin hooks

**Observed:** Launching the kookr Codex fork (`0.125.0-alpha.3+kookr.6b5d557d2`) with `--plugin-dir <path-to-plugin-with-hooks-json>` discovers and loads the plugin's `skills/` and `agents/`, but does NOT load its `hooks/hooks.json` sidecar. The plugin's PreToolUse hook never fires.

Tested under both bypass (`--dangerously-bypass-approvals-and-sandbox`) and non-bypass (`--full-auto`) modes — same result. The 3 `hook: PreToolUse` lines Codex prints in such sessions come from `~/.claude/settings.json` PreToolUse hooks (which Codex auto-loads), not from the plugin.

**Why it matters:** Plugin-bundled hooks are the cross-user distribution mechanism for kookr-toolkit. Per `rfc-unified-placement-picker.md` (PR #347), the placement-gate hook ships via `plugin/hooks/placement-gate.sh` + `plugin/hooks/hooks.json`. Until this gap is closed, that gate is silent on every Codex CLI Kookr task. Across the 859 Codex CLI sessions in May 2026 measured in `rfc-unified-placement-picker.md` §"Problem", 38 hit `<repo>/.hooks/pre-push`'s review-marker gate and 36 fabricated the marker via shell — exactly the population the in-session placement-gate was meant to protect.

**Source trace (kookr fork `feat/claude-compat` HEAD `6b5d557d2`):**

- `codex-rs/core/src/config/mod.rs:1907-1909` — `cli_plugin_dirs` documented as "extra skill root via `skills/` subdirectory" only.
- `codex-rs/core/src/session/mod.rs:3418` — `let plugin_hooks_enabled = config.features.enabled(Feature::PluginHooks);` then `plugins_manager.plugins_for_config(...).effective_plugin_hook_sources()`. The plugin manager doesn't ingest `cli_plugin_dirs` for hook discovery.
- `codex-rs/features/src/lib.rs:970-975` — `Feature::PluginHooks` is `default_enabled: true`, so the flag isn't the problem.
- `codex-rs/core-plugins/src/loader.rs:51` — `DEFAULT_HOOKS_CONFIG_FILE = "hooks/hooks.json"`. The loader IS implemented; only the source enumeration is missing.

**Fix location:** **Codex fork.** Extend `plugins_for_config` (or the call site at `session/mod.rs:3418`) to walk `cli_plugin_dirs` and register their `hooks/hooks.json` as `PluginHookSource` entries alongside the skill-root registration that already happens. The kookr fork added `--plugin-dir` in PR #57 (skills/agents); this is the parallel patch for hooks.

**Kookr-side fallback:** None reliable. The push-time tree-scanner at `<repo>/hooks/skill-placement-gate.sh` provides cross-runtime coverage at git-push time, but in-session protection against misplaced writes during a Codex task requires the fork extension.

**Empirical evidence:** `docs/poc/008-plugin-hook-bypass-survival.md` (in PR #348) documents the probe — Claude Code Run A fired the hook, Codex Runs G + H did not.

---

### What works today (keep documenting)

- Hook payload schema is ~95% compatible (same field names, same event names, PascalCase).
- `session_id`, `transcript_path`, `cwd`, `permission_mode`, `tool_name`, `tool_input` all present on Codex events.
- `tool_input.command` is a **string** on both CLIs (the "Codex uses array" claim in rfc-agent-comparison-framework.md is wrong).
- Codex `Bash` tool name matches Claude Code's (both use `Bash`, not `local_shell`).
- Once hooks actually load, the file-based JSONL ingestion model Kookr uses works unchanged for Codex.

## Where fixes should land

| # | Gap | Fork? | Kookr? | Severity |
|---|---|---|---|---|
| 1 | `--settings` silently ignored | **FORK** (primary) | Workaround via hooks.json | **CRITICAL** |
| 2 | `codex_hooks` disabled by default | — | **KOOKR** (add `-c` flag) | HIGH |
| 3 | 4 missing hook events | **FORK** | Inference fallbacks | MEDIUM |
| 4 | `PostToolUseFailure` never fires | **FORK** | Error-string inference | MEDIUM |
| 5 | `tool_response` as string, not object | — | **KOOKR** (already handles) | LOW |
| 6 | Hooks only on shell tool | **FORK** (preferred) | Transcript tailing | MEDIUM |
| 7 | TUI hook-status text clutter | **FORK** (add `--quiet-hooks`) | Line-filter | LOW |
| 8 | Trust prompt blocks first run | Both possible | **KOOKR** (write trust entry) | HIGH |
| 9 | Fork version stuck at 0.0.0 | **FORK** | — | LOW |
| 10 | MCP startup delay looks stuck | Both possible | **KOOKR** (parse TUI) | MEDIUM |
| 11 | `--plugin-dir` skips plugin hooks | **FORK** (primary) | Push-time tree-scanner only | HIGH |

**Total**: **7 fork-side fixes**, **3 Kookr-side fixes**, **1 either-or**.

## Recommended action sequence

1. **Fork, Gap 1** — Fix `--settings` file loading. This unblocks every other Codex compatibility effort. Single regression test: `codex exec --settings x.json` fires one hook. (~half day)
2. **Kookr, Gap 2** — Append `-c features.codex_hooks=true` in `CodexCliAdapter.launch()`. (1 hour)
3. **Kookr, Gap 8** — Write the trust entry before launching Codex interactively. (1 hour)
4. **Fork, Gap 3** — Emit `SessionEnd` on shutdown. Stripe the other 3 missing events as follow-ups.
5. **Fork, Gap 4** — Fix `PostToolUseFailure` emission (dispatch based on exit code).
6. **Fork, Gap 10** — Lazy MCP start OR emit `McpServerReady` hook.
7. **Fork, Gap 6** — Uniform hook dispatch for all tools.
8. **Cleanup** — Items 7, 9, 5 are polish.

Once Gaps 1–3 are resolved, Kookr's current Codex adapter code changes are minimal (~5 lines). The bulk of the compatibility work is in the Codex fork, as the user requested.

## Raw data

- Hook event captures: `/tmp/poc-codex-compat/hooks/*.jsonl`
- CLI outputs: `/tmp/poc-codex-compat/results/`
- Terminal captures: `/tmp/poc-codex-compat/results/*-display.txt`
- POC script: `003-codex-compatibility-gaps/run-poc.sh`
