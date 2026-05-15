# PoC 008: Plugin Hook Bypass Survival

## Status

Validated on 2026-05-14. Updated 2026-05-15 — the Codex CLI gap is now closed
(see Update below).

## Question

Do plugin-bundled hooks registered through `plugin/hooks/hooks.json` fire when
Kookr launches agents with permission bypass enabled?

## Result

As probed on 2026-05-14:

| Runtime | Mode | Result |
|---|---|---|
| Claude Code | normal | plugin hooks fire |
| Claude Code | `KOOKR_BYPASS_ALL_PERMISSIONS=true` | plugin hooks fire |
| Codex CLI | normal | plugin hooks did not fire via `--plugin-dir` |
| Codex CLI | bypass | plugin hooks did not fire via `--plugin-dir` |

At probe time the outcome was asymmetric: Claude Code loaded plugin hooks from
`--plugin-dir` even under permission bypass, while Kookr's Codex fork discovered
plugin *skills* from `--plugin-dir` but did not feed those plugin directories
into the plugin-hook loader. This is resolved as of 2026-05-15 — see Update.

## Implication

Plugin hooks are usable on Claude Code sessions, including Kookr-spawned
Claude Code sessions in bypass mode.

For Kookr's own repository, the push-time `hooks/skill-placement-gate.sh`
remains the cross-runtime catch-net because it inspects the final tree no matter
which agent runtime wrote the files.

## Update (2026-05-15) — Codex CLI gap closed

The kookr Codex fork now loads `--plugin-dir`-bundled `hooks/hooks.json` and
preserves `cli_plugin_dirs` across the `codex exec` config-rebuild path, via
`feat/claude-compat` commits `b3f847e304`, `10a9efd48b`, and `73d041358b`
(jeanibarz/codex).

Verified by the end-to-end test `exec_plugin_dir_hooks_fire_for_shell_command`
(`codex-rs/exec/tests/suite/hooks.rs`), which launches `codex exec --plugin-dir`
against a mock model and asserts the plugin's `PreToolUse` hook fires and blocks
the command, plus a live installed-binary smoke
(`codex-cli 0.125.0-alpha.3+kookr.73d041358`).

Plugin-bundled hooks now fire on both Claude Code and Codex CLI for ordinary
`codex exec` Kookr tasks. Two residual `ConfigOverrides` sites
(`codex-rs/core/src/agent/role.rs:264`,
`codex-rs/app-server/src/request_processors/turn_processor.rs:386`) still drop
`cli_plugin_dirs` on cold paths — role/agent reload and per-turn permission
changes — and are tracked as residual; the push-time catch-net covers them.
