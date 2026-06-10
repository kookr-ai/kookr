---
name: claude-code-permissions
description: Claude Code permission system — modes, allow/deny/ask rules, pattern syntax, settings precedence, and optimal configuration for minimal prompts with safety guardrails
keywords: permissions, settings, allow, deny, ask, defaultMode, acceptEdits, bypassPermissions, dontAsk, allowedTools, settings.json, permission prompt, auto-approve
related: shell-subprocess-safety, token-efficiency
---

# Claude Code Permissions

## When to Use

- Configuring Claude Code permissions to reduce or eliminate prompts
- Debugging why a tool call is being blocked or prompted
- Setting up managed / worker agents (e.g. a supervisor that spawns Claude Code children) with correct permissions
- Understanding how `--settings`, `--allowedTools`, `--disallowedTools` interact
- Designing safe-by-default permission configs for autonomous agents

## Permission Modes

| Mode | `defaultMode` value | Auto-approves | Notes |
|---|---|---|---|
| Ask Permissions | `default` | Read only | Most restrictive |
| Auto Accept Edits | `acceptEdits` | Read + Edit | **Recommended baseline** |
| Plan Mode | `plan` | Read only, blocks all writes/execution | Exploration only |
| Don't Ask | `dontAsk` | Only tools in `allow` list | Fully non-interactive; unlisted tools silently skipped |
| Bypass Permissions | `bypassPermissions` | Everything | No safety net, not recommended |

## Rule Evaluation Order

**First match wins, checked in this order:**

```
1. deny   → BLOCKED unconditionally
2. ask    → user PROMPTED for confirmation
3. allow  → APPROVED without prompting
4. mode   → fallback to defaultMode behavior
```

`deny` always beats `allow`. Safe to broadly allow + specifically deny.

## Pattern Syntax

### Tool matching

```json
"Bash"              // ALL bash commands (bare tool name)
"Write"             // ALL file writes
"Read"              // ALL file reads
"Agent"             // ALL agent spawns
"WebFetch"          // ALL web fetches
```

### Bash command patterns

```json
"Bash(npm run build)"       // exact command only
"Bash(npm run *)"           // npm run + any args
"Bash(git push *)"          // git push with any args
"Bash(git push --force *)"  // force push specifically
"Bash(git push * --force*)" // --force anywhere in args
"Bash(* --version)"         // any command with --version
```

**Word boundary:** Space before `*` enforces word boundary.
- `Bash(ls *)` matches `ls -la` but NOT `lsof`
- `Bash(ls*)` matches both `ls -la` AND `lsof`

### File path patterns (Read/Edit/Write)

```json
"Read(./.env)"              // relative to current dir
"Read(./.env.*)"            // glob pattern
"Read(~/.ssh/**)"           // home directory recursive
"Read(//usr/local/secret)"  // absolute path (// prefix)
"Read(/src/**/*.ts)"        // relative to project root
```

### Web patterns

```json
"WebFetch(domain:github.com)"    // specific domain
```

### MCP tool patterns

```json
"mcp__playwright__browser_navigate"    // specific tool
"mcp__playwright__*"                    // all tools from server
```

## Settings Precedence (first wins)

1. **Managed** — IT/org-level, cannot be overridden
2. **CLI flags** — `--settings`, `--allowedTools`, `--disallowedTools`, `--permission-mode`
3. **Local project** — `.claude/settings.local.json` (gitignored)
4. **Shared project** — `.claude/settings.json` (version-controlled)
5. **User** — `~/.claude/settings.json`

**`--settings` merges** with loaded settings (does not replace them).
**`--setting-sources ""`** skips all file-based settings.

## --print Mode Behavior

In `--print` mode (non-interactive), permissions differ from interactive:

| Rule type | Behavior in --print |
|---|---|
| `deny` | Enforced (tool blocked) |
| `ask` | Effectively blocks (no way to prompt) |
| `allow` | Works as expected |
| Permission mode | Mostly irrelevant — tools auto-approved regardless of mode |
| `plan` mode | Still blocks writes/execution |

**Implication:** `--print` mode tests validate deny/allow rules but NOT permission mode enforcement. Interactive mode (tmux, direct CLI) is where modes matter.

## Common Anti-Pattern: Specific Bash Patterns

**Wrong approach** — whack-a-mole, prompts for every new command:
```json
{
  "allow": [
    "Bash(git status*)",
    "Bash(git log *)",
    "Bash(npm *)",
    "Bash(ls *)",
    // ... 60+ patterns and growing
  ]
}
```

**Correct approach** — bare tool name + targeted deny:
```json
{
  "allow": ["Bash"],
  "deny": [
    "Bash(rm -rf /)",
    "Bash(git push --force *)",
    "Bash(git reset --hard*)"
  ]
}
```

## Recommended Configuration

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": [
      "Bash",
      "Read",
      "Edit",
      "Write",
      "WebFetch",
      "WebSearch",
      "Agent",
      "NotebookEdit",
      "EnterPlanMode",
      "ExitPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "TaskCreate",
      "TaskUpdate",
      "TaskOutput",
      "TaskStop"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(rm -rf /*)",
      "Bash(rm -rf ~)",
      "Bash(rm -rf ~/*)",
      "Bash(rm -rf .)",
      "Bash(rm -rf ./*)",
      "Bash(git push --force *)",
      "Bash(git push * --force*)",
      "Bash(git push -f *)",
      "Bash(git push * -f)",
      "Bash(git push * -f *)",
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(git checkout -- .)",
      "Bash(git restore .)",
      "Bash(shutdown *)",
      "Bash(reboot *)",
      "Bash(mkfs *)",
      "Bash(dd if=*)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)"
    ],
    "ask": []
  }
}
```

## Example: managed-agent worker permissions

A supervisor that spawns Claude Code children (e.g. via `claude --settings <path> ...`) typically passes hook definitions only via `--settings` and lets permission rules come from the standard cascade. Workers then inherit permissions from:

1. `~/.claude/settings.json` (user global)
2. `.claude/settings.json` (project shared)
3. `.claude/settings.local.json` (project local)

To change permissions for all spawned workers, edit `~/.claude/settings.json`. The `--settings` flag merges additively — permissions in the per-launch file are unioned with the cascade above, not replaced.

## Testing Permissions

```bash
# Spawn isolated Claude instance with specific settings
env -u ANTHROPIC_API_KEY claude \
    --print \
    --setting-sources "" \
    --settings '{"permissions":{"defaultMode":"acceptEdits","allow":["Bash"],"deny":["Bash(rm -rf /)"]}}' \
    --model haiku \
    --output-format json \
    "Run: echo test"

# Key flags:
# --setting-sources ""  → skip all settings files
# --settings <json>     → inject test config
# --bare                → skip hooks/LSP/OAuth (needs API key)
# --output-format json  → structured output with metadata
# env -u ANTHROPIC_API_KEY → force OAuth when API key has low credits
```

## Validated Behaviors (from POC 2026-03-30)

- `"Bash"` (bare) in allow list auto-approves ALL bash commands
- `deny` rules override `allow` — safe to broadly allow + specifically deny
- `deny` rules enforced in all modes including `--print`
- `ask` rules effectively block in `--print` mode (no way to prompt)
- `--settings` merges with file-based settings (does not replace)
- `plan` mode restricts available tools even in `--print` mode
- Model has its own safety layer (refuses `rm -rf /` independently of permissions)
- `bypassPermissions` mode does NOT respect deny rules reliably
