# PoC 006: KOOKR_BYPASS_ALL_PERMISSIONS must skip user setting sources

> **Date:** 2026-05-06
> **Resolves:** Issue #60
> **Environment:** Claude Code v2.1+, Linux (WSL2)

## Purpose

Empirically validate that `--dangerously-skip-permissions` alone does NOT bypass user `permissions.ask` rules in `~/.claude/settings.json`, and that adding `--setting-sources ""` does.

## Background

Claude Code's documented permission evaluation order is:

```
1. deny   → BLOCKED unconditionally
2. ask    → user PROMPTED for confirmation
3. allow  → APPROVED without prompting
4. mode   → fallback to defaultMode behavior
```

`--dangerously-skip-permissions` sets the permission *mode* (rule #4). User `ask` rules match at rule #2, so the prompt fires before bypass mode is consulted. The autonomous Ralph playbook stalled for ~8 hours on a `gh pr create` permission prompt despite the bypass flag being set (issue #60, task `7104c620`).

## Test setup

Synthetic user settings with an `ask` rule on `Bash(echo *)`:

```json
{ "permissions": { "ask": ["Bash(echo *)"] } }
```

Test prompt: `"Run bash command: echo permcheck"`. Both invocations are non-interactive (`--print`).

## Test A: bypass alone

```bash
claude --print --dangerously-skip-permissions --allowedTools "Bash" \
       --output-format json "Run bash command: echo permcheck-A"
```

Result excerpt:

```json
{
  "is_error": false,
  "result": "Permission for Bash was not granted, so the command did not run.",
  "permission_denials": [{ "tool_name": "Bash", "tool_input": { "command": "echo permcheck-A" } }],
  "stop_reason": "end_turn"
}
```

**The `ask` rule fired even with `--dangerously-skip-permissions`. Bypass mode is rule #4; the `ask` match at rule #2 wins first.**

## Test B: bypass + `--setting-sources ""`

```bash
claude --print --setting-sources "" --dangerously-skip-permissions --allowedTools "Bash" \
       --output-format json "Run bash command: echo permcheck-B"
```

Result excerpt:

```json
{
  "is_error": false,
  "result": "permcheck-B",
  "permission_denials": [],
  "stop_reason": "end_turn"
}
```

**With user/project/local settings skipped, the `ask` rule never loads, so rule #4 (bypass mode) auto-approves the call.**

## Conclusion

`KOOKR_BYPASS_ALL_PERMISSIONS=true` requires both flags to actually bypass prompts:

```
--dangerously-skip-permissions   (sets mode = bypassPermissions)
--setting-sources ""             (skips file-based ask/deny/allow sources)
```

Per-task `--settings <path>` (used to inject hooks and Kookr's per-launch allow list) is a CLI-flag rank source and continues to load even when `--setting-sources` is empty.

## Trade-off

Spawned sessions no longer see user-level `deny` rules, project hooks, or `.claude/settings.local.json` overrides. Acceptable because the user has already opted into "no safety net" by setting the env var; the per-task settings file still carries Kookr's hooks and any allow list derived from `agent-launch-context`.

## Rejected alternatives

| Mechanism | Why rejected |
|---|---|
| `--allowedTools <wide list>` alone | Rule #3 (allow) loses to rule #2 (ask) in evaluation order. Doesn't help. |
| Inject `permissions.ask: []` into the per-task `--settings` file | `--settings` MERGES with file-based settings (does not replace them). The user `ask` array survives the merge. |
| Document the limitation only | The autonomous Ralph use case requires the bypass to actually work, not just be documented as broken. |
