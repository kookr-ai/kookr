# PoC 008 — Plugin-bundled hook survival across runtimes (Claude Code + Codex CLI)

**Date:** 2026-05-14
**Author:** Jean Ibarz (with Claude)
**Triggered by:** rfc-unified-placement-picker §C and round-2 failure-mode-analyst R11 / delivery-pragmatist Critical PR3.

## Question

Does a plugin-bundled `PreToolUse` hook (registered via `plugin/hooks/hooks.json`) fire when launched via `--plugin-dir` under each of Kookr's runtime targets?

The placement-gate hook from PR #348 is most needed in autonomous (bypass-mode) sessions where supervision is lowest. A silent gate under bypass — or under Codex — defeats the gate's purpose.

## Result summary

| Runtime | Mode | Plugin hook fired? |
|---|---|---|
| **Claude Code** 2.1.141 | bypass (`--dangerously-skip-permissions --setting-sources ''`) | **YES** |
| **Codex CLI** 0.125.0-alpha.3 (kookr fork) | bypass (`--dangerously-bypass-approvals-and-sandbox`) | **NO** |
| **Codex CLI** 0.125.0-alpha.3 (kookr fork) | non-bypass (`--full-auto`) | **NO** |

The gap is **NOT bypass-specific**. The kookr Codex fork's `--plugin-dir` flag registers the plugin's `skills/` and `agents/` paths but NOT its `hooks/hooks.json` sidecar. Codex's plugin loader treats `--plugin-dir` as a skill root only.

This is documented in the fork's source at `codex-rs/core/src/config/mod.rs:1907-1909`:

```rust
/// Additional plugin directories from `--plugin-dir`. Each becomes an
/// extra skill root via its `skills/` subdirectory.
pub cli_plugin_dirs: Vec<PathBuf>,
```

## Method

Constructed a minimal probe plugin at `/tmp/probe-plugin-codex-4kdq/`:

```
.claude-plugin/plugin.json   (name: probe-plugin, version: 0.0.1)
hooks/probe-hook.sh          (appends to /tmp/probe-codex-diag.log, exits 0)
hooks/hooks.json             (PreToolUse Bash + Write|Edit matchers; absolute path)
```

### Run A — Claude Code bypass mode (REFERENCE)

```bash
claude -p \
  --dangerously-skip-permissions \
  --setting-sources '' \
  --plugin-dir /tmp/probe-plugin-codex-4kdq \
  "Use the Write tool to create <cwd>/probe-target-a.txt with content 'hello'"
```

Result: marker `/tmp/probe-marker-1259776` created at 22:19:01 (same timestamp as Claude's "Created." reply). **VERIFIED: plugin hooks fire on Claude Code under bypass.**

### Run G — Codex CLI bypass mode

```bash
codex exec --skip-git-repo-check -C $WORK \
  --dangerously-bypass-approvals-and-sandbox \
  --plugin-dir /tmp/probe-plugin-codex-4kdq \
  -c features.codex_hooks=true \
  "Run: echo g > $WORK/p-g.txt"
```

Codex's stdout printed `hook: PreToolUse` x3 and `hook: PreToolUse Completed` x3 — but `/tmp/probe-codex-diag.log` was never created. The probe hook **did not execute**.

The 3 `hook: PreToolUse` firings were the 3 PreToolUse `Bash`-matching hooks from `~/.claude/settings.json` (which Codex auto-loads per the comment in `~/.codex/hooks.json`), not from the plugin.

### Run H — Codex CLI non-bypass mode (`--full-auto`)

Same probe, swapped bypass flag for `--full-auto`. Same result: probe hook did not execute. **The gap is not bypass-specific.**

### Source verification

Traced the kookr Codex fork (`feat/claude-compat` HEAD `6b5d557d2`):

- `codex-rs/core/src/config/mod.rs:1907` — `cli_plugin_dirs` documented as "skill root via `skills/` subdirectory" only.
- `codex-rs/core/src/session/mod.rs:3418` — `let plugin_hooks_enabled = config.features.enabled(Feature::PluginHooks);` then calls `plugins_manager.plugins_for_config(...)` to enumerate `plugin_hook_sources`.
- `codex-rs/features/src/lib.rs:970-975` — `Feature::PluginHooks` is `default_enabled: true`, so the feature flag is on.
- `codex-rs/core-plugins/src/loader.rs:51` — `DEFAULT_HOOKS_CONFIG_FILE = "hooks/hooks.json"` (the path I used).

The plugin-hooks loader IS implemented. The gap is at the wiring: `--plugin-dir` populates `cli_plugin_dirs` but those entries don't reach the plugin-hook discovery path — they're treated as skill roots only.

## Impact on PR #348

The placement-gate hook from PR #348:

- **Fires on Claude Code** under both supervised and bypass modes. Covers Kookr's Claude-Code-spawned tasks.
- **Does NOT fire on Codex CLI** sessions, regardless of mode.

Concrete impact on the original motivation: across 859 Codex CLI sessions in May 2026, 38 hit Kookr's `.hooks/pre-push` review-marker gate and 36 fabricated the marker. **None of those would have been intercepted by the new plugin-bundled placement-gate**, because Codex doesn't load `--plugin-dir`-bundled hooks. The gate's value proposition needs to be reframed:

- It catches Claude Code-side placement errors in advance (advisory) of `git push`.
- The push-time tree-scanner (`<repo>/hooks/skill-placement-gate.sh`) remains the catch-net for **all** runtimes, including Codex.
- For Codex coverage of the new in-session gate, the kookr fork needs an extension (see "Follow-up" below).

## Implication for the RFC

`rfc-unified-placement-picker.md` should be updated to reflect:

- §C "Bypass-mode handling" — replace "empirically untested" with the verified Claude Code result and the falsified Codex result.
- §C "Bash matcher scope" — note that on Codex CLI, the Bash matcher is moot because `--plugin-dir` doesn't register plugin hooks. The matcher only matters once the codex fork extension lands.
- §"Surface inventory" — clarify that Plugin hooks (row 9) ship via plugin-dir but the runtime visibility is "Claude Code: yes; Codex CLI: NOT via `--plugin-dir` until fork extension."

## Companion edits made in this PR

- `plugin/hooks/README.md` — updated "Bypass-mode coverage" section to reflect the asymmetry.

## Follow-up — codex fork extension (in progress)

### Phase 1 (landed): wiring patch

Commit [`b3f847e304`](https://github.com/jeanibarz/codex/commit/b3f847e304) (`feat/claude-compat`) adds `include_cli_plugin_hook_sources` in `codex-rs/core/src/skills.rs` and a call site in `session/mod.rs:3425`. CLI-injected plugins get a synthetic marketplace name (`cli`) for well-formed PluginId. Mirrors `include_cli_plugin_skill_roots`. Unit test `include_cli_plugin_hook_sources_registers_hooks_json_from_cli_plugin_dir` passes.

### Phase 2 (landed, partial): `rebuild_preserving_session_layers` fix

Commit [`10a9efd48b`](https://github.com/jeanibarz/codex/commit/10a9efd48b) (`feat/claude-compat`) adds `cli_plugin_dirs: self.cli_plugin_dirs.clone()` to the `ConfigOverrides` block in `Config::rebuild_preserving_session_layers` (codex-rs/core/src/config/mod.rs:1229-1241).

Empirical motivation: post-phase-1, the probe was STILL silent. A two-pass debug-eprintln instrumentation revealed that `load_config_with_layer_stack` is called 3 times per `codex exec --plugin-dir <dir>` invocation:
- 1st call (from `exec/lib.rs:440` via `ConfigBuilder.build()`): `cli_plugin_dirs=[/tmp/...]` ✓
- 2nd + 3rd calls (session-internal refreshes): `cli_plugin_dirs=[]` ✗

The session-internal rebuilds construct fresh `ConfigOverrides` with `..Default::default()` — `cli_plugin_dirs` defaults to `vec![]` because it's a runtime-only override that doesn't come from any config TOML layer.

### Remaining gap (known, not yet fixed)

**Phase 2 closes one rebuild path but THREE others remain**. Each constructs `ConfigOverrides` from a previous Config without copying `cli_plugin_dirs` forward:

| Site | File | Function |
|---|---|---|
| 1 | `codex-rs/core/src/agent/role.rs:264` | `reload_overrides` (role/agent system refresh) |
| 2 | `codex-rs/app-server/src/request_processors/thread_processor.rs:1224` | thread-start ConfigOverrides builder |
| 3 | `codex-rs/app-server/src/request_processors/turn_processor.rs:386` | turn-start ConfigOverrides builder |

A `codex exec --plugin-dir <dir>` invocation triggers some of these refreshes during normal session lifecycle, so the partial fix is **not sufficient on its own** for the in-session Bash-matcher gate to fire reliably. Empirical verification of the partial fix showed the probe hook still silent after Phase 2 — at least one of the 3 remaining sites is on the hot path.

### Phase 3 options (not yet landed)

- **Whack-a-mole** — add `cli_plugin_dirs: <prev_config>.cli_plugin_dirs.clone()` to each of the 3 remaining sites. Low risk but fragile against future Config-rebuild sites.
- **Architectural** — thread `cli_plugin_dirs` through `ConfigManager` (`codex-rs/app-server/src/config_manager.rs:28`) as persistent state, injected into every `ConfigOverrides` passed to `load_with_cli_overrides`. Single point of truth; survives all rebuild paths. Larger refactor.

Until Phase 3 lands, **the in-session plugin-hook gate from PR #348 covers Claude Code Kookr tasks reliably and Codex CLI Kookr tasks NOT reliably**. The push-time tree-scanner gate at `<repo>/hooks/skill-placement-gate.sh` remains the cross-runtime catch-net.

## Limitations of this PoC

- Tested only one Claude Code version (2.1.141) and one Codex fork build (`0.125.0-alpha.3+kookr.6b5d557d2.dirty`). The gap is structural in the fork's source, so it applies to all builds of that source.
- The probe used absolute paths in `hooks.json` to remove the `${CLAUDE_PLUGIN_ROOT}` substitution variable. The hook still didn't fire — confirming the issue is upstream of command-string substitution.
- Probed `PreToolUse Bash` matcher only. Other event types (`UserPromptSubmit`, `Stop`, etc.) may have different loading paths; not tested.
