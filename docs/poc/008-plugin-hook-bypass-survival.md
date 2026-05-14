# PoC 008 — Plugin-bundled hook survival under bypass mode

**Date:** 2026-05-14
**Author:** Jean Ibarz (with Claude)
**Triggered by:** rfc-unified-placement-picker §C and round-2 failure-mode-analyst R11 / delivery-pragmatist Critical PR3.

## Question

Does a plugin-bundled `PreToolUse` hook (registered via `plugin/hooks/hooks.json`) fire when Claude Code is launched with kookr's bypass-mode flag combo (`KOOKR_BYPASS_ALL_PERMISSIONS=true`)?

Kookr's `ClaudeCodeAdapter` builds bypass-mode argv as:

```
claude --dangerously-skip-permissions --setting-sources '' [...] --plugin-dir <kookr>/plugin [...]
```

The memory note `project_kookr_bypass_strips_file_agents` confirms `--setting-sources ''` strips file-based agents (`<repo>/.claude/agents/`, `~/.claude/agents/`). The same flag's effect on `--plugin-dir`-loaded **hooks** was undocumented.

This matters because the placement-gate hook from PR #348 is most needed in autonomous (bypass-mode) sessions where supervision is lowest. A silent gate under bypass defeats the gate's purpose.

## Method

Constructed a minimal probe plugin at `/tmp/probe-plugin-O13D/`:

```
/tmp/probe-plugin-O13D/
├── .claude-plugin/plugin.json     (name: probe-plugin, version: 0.0.1)
├── hooks/probe-hook.sh            (touches /tmp/probe-marker-$$ and exits 0)
└── hooks/hooks.json               (registers probe-hook.sh for PreToolUse Write|Edit)
```

Invoked Claude Code in non-interactive mode with the full bypass flag set:

```bash
claude -p \
  --dangerously-skip-permissions \
  --setting-sources '' \
  --plugin-dir /tmp/probe-plugin-O13D \
  "Use the Write tool now to create a file at <cwd>/probe-target-a.txt with the single word: hello"
```

Then inspected `/tmp/probe-marker-*` for evidence that the hook script ran.

## Result

**VERIFIED — plugin hook fires under full bypass.**

```
$ ls -la --time-style=full-iso /tmp/probe-marker-* /tmp/probe-fired-*
-rw-r--r-- 1 jean jean 43 2026-05-14 22:19:01 /tmp/probe-fired-via-stderr-1259775
-rw-r--r-- 1 jean jean  0 2026-05-14 22:19:01 /tmp/probe-fired-via-stdout-1259775
-rw-r--r-- 1 jean jean 58 2026-05-14 22:19:01 /tmp/probe-marker-1259776
```

Marker contents:

```
[probe] fired at 2026-05-14T22:19:01+02:00
[probe] tool:
```

The marker was written at the same timestamp as Claude's "Created." response, confirming the hook fired in-process during the `Write` tool call.

## Implication

- `--setting-sources ''` strips file-based **agents and settings hooks** but NOT `--plugin-dir`-loaded **plugin hooks**. The two subsystems are loaded by different code paths in Claude Code.
- PR #348's `plugin/hooks/placement-gate.sh` will fire in autonomous (`KOOKR_BYPASS_ALL_PERMISSIONS=true`) sessions.
- The rfc-unified-placement-picker §C's "fall-back-and-document" plan is unnecessary; the gate has real coverage in bypass mode.

## Companion edits

After this PoC concluded:
- `plugin/hooks/README.md` — change "Empirically untested" to "Verified to fire under bypass mode (PoC 008)".
- `plugin/skills/placement-picker/SKILL.md` (in PR #349) — same update if it mentions bypass coverage.

## Limitations

- Tested only Claude Code (2.1.141). Codex CLI bypass-mode hook survival is a separate question; Codex emits `PreToolUse` only for `Bash` per PoC 003 §Gap 6 so the relevant probe there is "does the Bash matcher fire under Codex bypass." Not tested here.
- Tested non-interactive (`claude -p`) only. Interactive mode (TUI) is structurally equivalent but unverified.
- The probe hook's `tool:` field shows empty (no stdin read) — `${CLAUDE_PLUGIN_ROOT}` substitution worked but the redirect-to-file form in `hooks.json` consumed stdin before the script could read it. The fact that the script ran AT ALL is the verdict signal; deeper stdin payload inspection would need a different harness.

## Reproduction

The probe plugin tree was cleaned up after the test. To re-run, recreate the three files above and invoke `claude -p` with the same flags from any temporary cwd. Look for `/tmp/probe-marker-*` after the call returns.
