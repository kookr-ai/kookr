# ADR-006: Permission Mode Feasibility in Headless Mode

## Status

**Accepted** — **Revisited 2026-03-24.** Original conclusions were specific to headless mode. With managed terminal sessions ([ADR-007](007-managed-terminal-sessions.md)), the `PermissionRequest` hook provides a structured, real-time signal for permission blocks. **F2.4 (permission-block detection) is now feasible.** See [PoC 001](../poc/001-hook-mechanism-validation.md).

## Context

A PR review flagged that Phase 2 hard-codes `--permission-mode bypassPermissions`, but Phase 3 planned to switch to a permission mode that surfaces prompts, enabling Kookr to detect permission-blocked agents and route developer attention.

We conducted empirical testing (2026-03-23) to determine whether non-bypass permission modes are technically viable for headless agent management.

## Research Findings

### Claude Code (`-p` / headless mode)

Tested all permission modes with `--output-format stream-json`:

| Mode | Behavior | Useful for Kookr? |
|------|----------|-------------------|
| `bypassPermissions` | Everything auto-approved | Yes — full autonomy |
| `acceptEdits` | Everything auto-approved, including `rm -rf` | Equivalent to bypass in practice |
| `default` | Writes/edits **immediately denied** with error tool result | **No** — no pause, no approval mechanism |
| `plan` | Most tools denied | **No** — same immediate denial |

**Key finding**: In headless mode (`-p`), there is **no pause-and-wait** for human approval. When a tool is denied:

1. The tool call gets an immediate `tool_result` with `is_error: true` and message: *"Claude requested permissions to [action], but you haven't granted it yet."*
2. The agent sees the error, may retry or give up
3. The final `result` event includes a `permission_denials` array listing all denied tools

**There is no mechanism to inject an approval into a running headless session.** The `-p` flag note in Claude Code's help confirms: *"The workspace trust dialog is skipped when Claude is run with the -p mode."*

### Codex CLI (`exec` mode)

| Feature | Status |
|---------|--------|
| `--ask-for-approval` flag | **Not available** in `exec` mode — interactive only |
| `--sandbox read-only` | Denials appear as shell errors in agent messages, not structured events |
| Structured permission events | **None** in JSONL output |

Codex `exec` mode has no approval mechanism at all. Sandbox violations produce regular shell errors that the agent sees and reacts to.

### What "needs input" actually looks like

The only reliable "agent needs human input" signal in headless mode is when the agent explicitly uses the `AskUserQuestion` tool. This produces a structured JSONL event:

```json
{"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "AskUserQuestion", "input": {"question": "..."}}]}}
```

This is followed by a tool result, but in headless mode the question goes unanswered (the agent receives an empty or default response). This **is** detectable and could be a "needs input" signal — but it's the agent choosing to ask, not a permission system blocking it.

## Decision

> **SUPERSEDED (2026-03-24):** The decision below applied to headless mode (`-p`). With the move to interactive mode (ADR-007), F2.4 is now feasible via the `PermissionRequest` hook. `'permission_blocked'` is an active `AnomalyType` in the codebase. See the [Revisit section](#revisit-interactive-mode-2026-03-24) below.

**~~Remove permission-block detection (F2.4) from the feature set.~~** ~~It is not technically feasible in headless mode for either Claude Code or Codex CLI.~~

### Consequences

1. **Keep `bypassPermissions`** for Claude Code (`acceptEdits` behaves identically in practice)
2. **Remove** the Phase 3 roadmap item to "switch permission modes"
3. **Redefine "needs input"** (F2.1) as: agent used `AskUserQuestion` tool, not permission blocks
4. **Keep** other anomaly detections such as repeated errors and budget burn. Stuck-loop detection was later removed from the active anomaly type union and deferred to the V2 semantic supervisor.
5. **Permission-related signals** that remain useful:
   - `permission_denials` in the `result` event (post-hoc, for logging/display)
   - Agent text mentioning permission issues (heuristic, unreliable)

### What we lose

The original vision of Kookr detecting "agent is blocked on a permission" and letting the developer approve/deny from the GUI is **not possible** with current CLI architectures. Both CLIs treat headless mode as non-interactive by design — permissions are resolved at launch time, not at runtime.

### Possible future paths

- Claude Code or Codex could add a `--permission-callback` or webhook mechanism for headless sessions
- A custom permission mode that writes pending approvals to a file/socket instead of blocking on TTY
- Using `AskUserQuestion` as a proxy: agents could be instructed (via system prompt) to ask before risky operations

## Test Evidence

```bash
# Claude Code default mode — Write denied immediately, no pause
claude -p "create /tmp/test.txt" --output-format stream-json --permission-mode default
# → tool_result: is_error=true "Claude requested permissions to write...but you haven't granted it yet."
# → result: permission_denials: [{tool_name: "Write", ...}]

# Claude Code acceptEdits — rm -rf auto-approved (same as bypass)
claude -p "rm -rf /tmp/test" --output-format stream-json --permission-mode acceptEdits
# → tool_result: is_error=false (command executed)

# Codex exec — no --ask-for-approval flag available
codex exec --json --ask-for-approval untrusted - <<< "test"
# → error: unexpected argument '--ask-for-approval'

# Codex exec read-only sandbox — shell error, no structured event
codex exec --json --sandbox read-only - <<< "create /tmp/test.txt"
# → agent_message: "Read-only file system" (unstructured text)
```

---

## Revisit: Interactive Mode (2026-03-24)

ADR-007 moved agent execution to interactive mode in managed tmux sessions. This changes the permission detection picture entirely.

### Findings

Empirical testing ([PoC 001](../poc/001-hook-mechanism-validation.md)) confirmed that Claude Code's **`PermissionRequest` hook** fires in interactive mode when the agent needs permission approval. The hook payload includes:

- `tool_name`: which tool needs permission (e.g., `"Bash"`)
- `tool_input`: what the agent wants to do (e.g., `{"command": "mkdir -p /tmp/test"}`)
- `permission_suggestions`: how the permission could be resolved (e.g., add directories, change mode)

The hook fires **before** the permission dialog appears in the terminal, giving Kookr advance notice.

### Updated Decision

- **F2.4 (permission-block detection) is feasible** in interactive mode via the `PermissionRequest` hook
- The original decision to remove F2.4 applies only to headless mode (`-p`), which Kookr no longer uses
- Kookr can detect permission blocks with full context (tool name, input, suggestions) and surface them to the developer via the attention router
- The developer can resolve permission blocks by attaching to the tmux session directly or by Kookr sending keystrokes to approve/deny
