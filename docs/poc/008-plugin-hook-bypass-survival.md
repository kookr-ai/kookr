# PoC 008: Plugin Hook Bypass Survival

## Status

Validated on 2026-05-14.

## Question

Do plugin-bundled hooks registered through `plugin/hooks/hooks.json` fire when
Kookr launches agents with permission bypass enabled?

## Result

| Runtime | Mode | Result |
|---|---|---|
| Claude Code | normal | plugin hooks fire |
| Claude Code | `KOOKR_BYPASS_ALL_PERMISSIONS=true` | plugin hooks fire |
| Codex CLI | normal | plugin hooks do not fire via `--plugin-dir` |
| Codex CLI | bypass | plugin hooks do not fire via `--plugin-dir` |

The outcome is asymmetric. Claude Code loads plugin hooks from `--plugin-dir`
even when permission bypass is active. Kookr's Codex fork discovers plugin
skills from `--plugin-dir`, but it does not currently feed those plugin
directories into the plugin-hook loader.

## Implication

Plugin hooks are useful for Claude Code sessions today, including Kookr-spawned
Claude Code sessions in bypass mode. They are not a complete cross-runtime
guard until the Codex fork loads plugin hook sources from `cli_plugin_dirs`.

For Kookr's own repository, the push-time `hooks/skill-placement-gate.sh`
remains the cross-runtime catch-net because it inspects the final tree no matter
which agent runtime wrote the files.
