---
description: Claude Code hook system — all 25 event types, payloads, matchers, state machine, and integration patterns for agent monitoring
triggers:
  - hook
  - hooks
  - hook event
  - agent state
  - idle detection
  - StopFailure
  - Notification
  - UserPromptSubmit
  - SessionEnd
  - generateSettings
---

# Claude Code Hook System (v2.1.87+)

Empirically validated knowledge about Claude Code's hook system, distilled from PoC 001 and PoC 002.

## All 25 Hook Event Types

### Session Lifecycle
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `SessionStart` | `source`: startup, resume, clear, compact | No | `source`, `model` |
| `InstructionsLoaded` | `load_reason`: session_start, nested_traversal, path_glob_match, include, compact | No | `file_path`, `memory_type` (User/Project), `load_reason` |
| `SessionEnd` | (none) | No | `reason`: clear, resume, logout, prompt_input_exit, bypass_permissions_disabled, other |

### User Input
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `UserPromptSubmit` | (none) | Yes (exit 2 blocks) | `prompt`, `permission_mode` |

### Tool Execution
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `PreToolUse` | tool name | Yes (`permissionDecision`) | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | tool name | Partial | `tool_name`, `tool_input`, `tool_use_id`, `tool_response` |
| `PostToolUseFailure` | tool name | No | `tool_name`, `tool_input`, `tool_use_id`, `error` |
| `PermissionRequest` | tool name | Yes (`behavior`) | `tool_name`, `tool_input`, `permission_suggestions`, `permission_mode` |

### Turn Completion
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `Stop` | (none) | Yes (`decision: "block"`) | `stop_hook_active`, `last_assistant_message`, `permission_mode` |
| `StopFailure` | error type | No | `error`: rate_limit, authentication_failed, billing_error, invalid_request, server_error, max_output_tokens, unknown; `last_assistant_message` |
| `Notification` | (none — fires for all types) | No | `notification_type`: idle_prompt, permission_prompt, auth_success, elicitation_dialog; `message` |

### Subagent Lifecycle
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `SubagentStart` | agent type | No | agent type name |
| `SubagentStop` | agent type | Yes | `last_assistant_message`, `agent_transcript_path` |

### Task Lifecycle (Agent Teams)
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `TaskCreated` | (none) | Yes (exit 2) | task info |
| `TaskCompleted` | (none) | Yes (exit 2) | task info |
| `TeammateIdle` | (none) | Yes (exit 2 sends feedback) | `teammate_name`, `team_name` |

### Context Management
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `PreCompact` | trigger: manual, auto | No | compaction trigger |
| `PostCompact` | trigger: manual, auto | No | compaction trigger |

### Environment Changes
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `ConfigChange` | config source | Yes | source: user_settings, project_settings, local_settings, policy_settings, skills |
| `CwdChanged` | (none) | No | new cwd |
| `FileChanged` | filename (basename) | No | changed filename |
| `WorktreeCreate` | (none) | Yes (non-zero exit fails) | worktree info |
| `WorktreeRemove` | (none) | No | worktree info |

### MCP Elicitation
| Event | Matcher | Blocking | Payload fields |
|-------|---------|----------|----------------|
| `Elicitation` | MCP server name | Yes (`action`) | MCP server, input request |
| `ElicitationResult` | MCP server name | Yes | user response |

## Common Payload Fields (all events)

```json
{
  "session_id": "uuid-string",
  "transcript_path": "/absolute/path/to/session.jsonl",
  "cwd": "/current/working/directory",
  "hook_event_name": "EventName",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions"
}
```

## Matcher Configuration Rules

- **Tool events** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`): matcher is tool name, use `"*"` for all tools
- **`SessionStart`**: matcher is `source` field value, use `"*"` for all sources
- **Events with no matcher** (`Stop`, `StopFailure`, `Notification`, `UserPromptSubmit`, `SessionEnd`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `CwdChanged`): use `""` (empty string)
- **`InstructionsLoaded`**: matcher is `load_reason`
- **`SubagentStart`/`SubagentStop`**: matcher is agent type name
- **`PreCompact`/`PostCompact`**: matcher is trigger type
- **`ConfigChange`**: matcher is config source
- **`FileChanged`**: matcher is filename basename
- **`Elicitation`/`ElicitationResult`**: matcher is MCP server name
- **The `if` field** (v2.1.85+): permission-rule syntax for argument filtering, e.g. `"if": "Bash(git *)"`. Only for tool events.

## Agent State Machine (from hooks)

```
SessionStart ──► INITIALIZING
                      │
              InstructionsLoaded (1..N)
                      │
              UserPromptSubmit ──► ACTIVE ◄─── UserPromptSubmit (from IDLE)
                                     │
                              ┌──────┴──────┐
                        PreToolUse    (thinking)
                              │              │
                      TOOL_RUNNING          Stop ──► IDLE
                              │                        │
                        PostToolUse             Notification(idle_prompt)
                              │                        │
                           ACTIVE              CONFIRMED_IDLE
                                                       │
                                               UserPromptSubmit ──► ACTIVE
                                                  (or SessionEnd ──► TERMINATED)

  StopFailure ──► ERRORED (from any active state)
  PermissionRequest ──► BLOCKED (from ACTIVE/TOOL_RUNNING)
  SessionEnd ──► TERMINATED (from any state)
```

### Two-Stage Idle Detection

1. **`Stop`** — immediate "finished turn" signal (soft idle)
2. **`Notification(idle_prompt)`** — fires ~60s later (confirmed idle, developer hasn't responded)

Use Stop for "needs_input" (info). Use Notification(idle_prompt) for escalation or auto-proceed.

### Idle→Active Transition

`UserPromptSubmit` is the definitive signal. Clears all idle-related anomalies.

## Hook Handler Types

| Type | Description | Default timeout |
|------|-------------|-----------------|
| `command` | Shell command, JSON on stdin | 600s |
| `http` | POST to URL endpoint | 30s |
| `prompt` | Single-turn LLM evaluation | 30s |
| `agent` | Multi-turn subagent with tools | 60s |

## Settings File Locations

| Location | Scope |
|----------|-------|
| `~/.claude/settings.json` | User-global |
| `.claude/settings.json` | Project (committable) |
| `.claude/settings.local.json` | Project (gitignored) |
| `--settings <file>` flag | Per-launch (additive to above) |

Hooks from `--settings` are **additive** — they don't replace user or project hooks.

## Example: per-agent settings for managed-agent supervisors

When you're building a supervisor that spawns Claude Code child agents and wants to capture every hook event for monitoring, generate a per-agent `--settings <file>` with all hook events wired to a single dispatcher command. The dispatcher can dual-write (e.g. append-to-JSONL for replay AND HTTP POST for live UI updates):

```typescript
// Hooks that match tool names use "*"
// Hooks without matcher semantics use ""
const TOOL_MATCHER = '*';
const NO_MATCHER = '';

const hookEntries = {
  SessionStart:      [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
  PreToolUse:        [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
  PostToolUse:        [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
  PostToolUseFailure: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
  Stop:               [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  StopFailure:        [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  PermissionRequest:  [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCmd }] }],
  Notification:       [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  UserPromptSubmit:   [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  SubagentStart:      [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  SubagentStop:       [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
  SessionEnd:         [{ matcher: NO_MATCHER,   hooks: [{ type: 'command', command: hookCmd }] }],
};
```

## Empirical Validation

All payloads and event names documented above were captured from live sessions (Claude Code v2.1.81–v2.1.87), not from the docs. Heuristic for any future event: spawn a session with a hook wired to every documented event and `cat` the stdin payload it actually receives — the binary is the source of truth.

### Debunked: TaskStop, Heartbeat, ToolError

These strings appear in the binary but are NOT hook events:
- **TaskStop** — tool name for the "Stop Task" tool (like Bash, Read)
- **Heartbeat** — internal worker lease extension for cloud/remote sessions
- **ToolError** — custom Error class; tool failures surface via `PostToolUseFailure` hook

The binary validates hook names at startup — invalid names cause a settings error dialog. The definitive enum has exactly 26 valid hook event names.
