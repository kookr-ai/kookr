# PoC 001: Hook Mechanism Validation

> **Date:** 2026-03-24
> **Resolves:** Pre-implementation gaps 1, 2, and 4
> **Environment:** Claude Code v2.1.81, tmux 3.2a, Linux (WSL2)

## Purpose

Empirically validate the Claude Code hook mechanism in interactive tmux sessions to resolve three blocking gaps before V1 implementation:

1. **Gap 1:** How does Kookr inject hooks per managed agent?
2. **Gap 2:** What signal indicates "agent is waiting for input" in interactive mode?
3. **Gap 4:** Can Kookr detect permission blocks in interactive mode?

## Test Setup

Settings file used for hook injection:

```json
{
  "hooks": {
    "PreToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc/pre-tool-use.jsonl" }] }],
    "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc/post-tool-use.jsonl" }] }],
    "Stop":              [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc/stop.jsonl" }] }],
    "SessionStart":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc/session-start.jsonl" }] }],
    "PermissionRequest": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc/permission-request.jsonl" }] }]
  }
}
```

Sessions launched via:
```bash
tmux new-session -d -s <name> -x 200 -y 50 "claude --settings /tmp/kookr-poc/settings.json"
```

## Results

### Gap 1: Hook Configuration Mechanism

| Question | Result |
|----------|--------|
| Does `--settings <file>` exist? | **Yes.** CLI flag confirmed in `claude --help`. |
| Do hooks fire in interactive mode? | **Yes.** All tested hooks fired correctly. |
| Are hooks additive? | **Yes.** `--settings` loads "additional" settings per CLI docs. User hooks from `~/.claude/settings.json` are not replaced. |
| Can hooks write to arbitrary files? | **Yes.** `cat >> /path/to/file.jsonl` appends hook JSON to any writable path. |
| Does `session_id` appear in payloads? | **Yes.** Every hook event includes `session_id` (UUID format). |
| Does `transcript_path` appear in payloads? | **Yes.** Full path to transcript JSONL file, e.g., `~/.claude/projects/<project>/<session_id>.jsonl`. |

**Conclusion:** Kookr generates a per-agent settings JSON file with hook definitions that append to agent-specific JSONL files in `~/.kookr/hooks/`. The file is passed via `--settings` at agent launch. No merge with user settings is needed — hooks are additive.

### Gap 2: "Waiting for Input" Detection

The **`Stop` hook** fires when the agent finishes its turn in interactive mode and returns control to the user.

**Stop hook payload (observed):**
```json
{
  "session_id": "ecdffeda-e0fc-490d-9efe-3347d80fb85e",
  "transcript_path": "~/.claude/projects/-home-jean-git-kookr/ecdffeda-e0fc-490d-9efe-3347d80fb85e.jsonl",
  "cwd": "$HOME/git/kookr",
  "permission_mode": "acceptEdits",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "There are **4 hook types** in this file: ..."
}
```

**Key fields for Kookr:**
- `stop_hook_active`: whether a stop hook is actively deciding to block
- `last_assistant_message`: the agent's final message before stopping — useful for supervisor context

**Conclusion:** The `Stop` hook is the reliable, structured signal for "agent finished its turn." No heuristics or silence detection needed.

### Gap 4: Permission Block Detection

The **`PermissionRequest` hook** fires when the agent needs permission approval in interactive mode.

**PermissionRequest hook payload (observed):**
```json
{
  "session_id": "e5a32157-98b3-4b34-95be-173437f1dc13",
  "transcript_path": "~/.claude/projects/-home-jean-git-kookr/e5a32157-98b3-4b34-95be-173437f1dc13.jsonl",
  "cwd": "$HOME/git/kookr",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "mkdir -p /tmp/kookr-poc",
    "description": "Create parent directory"
  },
  "permission_suggestions": [
    {
      "type": "addDirectories",
      "directories": ["/tmp/kookr-poc"],
      "destination": "session"
    },
    {
      "type": "setMode",
      "mode": "acceptEdits",
      "destination": "session"
    }
  ]
}
```

**Key fields for Kookr:**
- `tool_name` + `tool_input`: what the agent wants to do
- `permission_suggestions`: how the permission could be resolved

**Conclusion:** F2.4 (permission-block detection) is fully feasible in interactive mode. The `PermissionRequest` hook provides a structured, real-time signal with full context. ADR-006's headless-mode limitation does not apply.

### Hook Firing Order (observed)

```
SessionStart
  → [user sends prompt]
  → PreToolUse + PermissionRequest  (both fire before the permission dialog)
  → [user approves permission]
  → PostToolUse
  → Stop  (agent done, waiting for input)
```

### Complete Hook Payload Fields (common to all events)

| Field | Type | Present in |
|-------|------|-----------|
| `session_id` | UUID string | All events |
| `transcript_path` | Absolute path | All events |
| `cwd` | Absolute path | All events |
| `permission_mode` | String | All except SessionStart |
| `hook_event_name` | String | All events |
| `source` | `"startup"` | SessionStart only |
| `model` | String | SessionStart only |
| `tool_name` | String | PreToolUse, PostToolUse, PermissionRequest |
| `tool_input` | Object | PreToolUse, PostToolUse, PermissionRequest |
| `tool_use_id` | String | PreToolUse, PostToolUse |
| `tool_response` | Object | PostToolUse only |
| `stop_hook_active` | Boolean | Stop only |
| `last_assistant_message` | String | Stop only |
| `permission_suggestions` | Array | PermissionRequest only |

### Additional Hook Types (from documentation, not tested in this PoC)

The Claude Code documentation lists these additional hook event types that Kookr may use in future:

| Event | Blocking | Potential Kookr Use |
|-------|----------|---------------------|
| `SubagentStop` | Yes | Detect subagent completion |
| `PostToolUseFailure` | No | Detect tool errors for anomaly detection |
| `UserPromptSubmit` | Yes | Detect when user responds (via Kookr or direct attach) |
| `PreCompact` / `PostCompact` | No | Detect context window pressure |
| `Notification` | No | Forward async notifications |

## Implications for Kookr Design

1. **Adapter implementation is unblocked.** The `--settings` + hook mechanism provides everything needed.
2. **Transcript path discovery is trivial.** The first hook event (SessionStart) provides `transcript_path` — no scanning or heuristic matching needed.
3. **Three detection signals are now defined:**
   - "Needs input" → `Stop` hook
   - "Permission blocked" → `PermissionRequest` hook
   - "Tool activity" → `PreToolUse` / `PostToolUse` hooks
4. **F2.4 should be promoted to "must have" or kept as "nice to have" with a clear implementation path.**
5. **No ANSI terminal parsing is needed** for any monitoring logic.
