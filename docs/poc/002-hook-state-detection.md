# PoC 002: Hook-Based Agent State Detection

> **Date:** 2026-03-30
> **Extends:** PoC 001 (hook mechanism validation)
> **Environment:** Claude Code v2.1.87, tmux 3.2a, Linux (WSL2)

## Purpose

Validate all 25 Claude Code hook event types and determine which hooks provide reliable idle/active/error state signals for Kookr agent monitoring. PoC 001 validated 5 hooks — this PoC catalogs the complete set and empirically captures the payloads of state-relevant hooks.

## Complete Hook Event Inventory

All 25 event types confirmed present in the Claude Code v2.1.87 binary via `strings` extraction:

| # | Event | Occurrences in binary | Currently used by Kookr |
|---|-------|-----------------------|--------------------------|
| 1 | SessionStart | 103 | Yes |
| 2 | InstructionsLoaded | 37 | No |
| 3 | UserPromptSubmit | 74 | No |
| 4 | PreToolUse | 150 | Yes |
| 5 | PostToolUse | 233 | Yes |
| 6 | PostToolUseFailure | (via strings) | No |
| 7 | PermissionRequest | 198 | Yes |
| 8 | Notification | 562 | No |
| 9 | SubagentStart | 45 | No |
| 10 | SubagentStop | 65 | No |
| 11 | TaskCreated | 38 | No |
| 12 | TaskCompleted | 48 | No |
| 13 | Stop | 608 | Yes |
| 14 | StopFailure | 30 | No |
| 15 | TeammateIdle | 48 | No |
| 16 | ConfigChange | 44 | No |
| 17 | CwdChanged | 42 | No |
| 18 | FileChanged | 61 | No |
| 19 | WorktreeCreate | 90 | No |
| 20 | WorktreeRemove | 54 | No |
| 21 | PreCompact | 54 | No |
| 22 | PostCompact | 79 | No |
| 23 | Elicitation | 196 | No |
| 24 | ElicitationResult | 49 | No |
| 25 | SessionEnd | 53 | No |

## Empirically Captured Payloads

### Test Setup

Settings file configures all 25 hooks to append JSON to a single JSONL file:

```json
{
  "hooks": {
    "SessionStart":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "Stop":              [{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "StopFailure":       [{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "Notification":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "UserPromptSubmit":  [{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "SessionEnd":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }],
    "InstructionsLoaded":[{ "matcher": "", "hooks": [{ "type": "command", "command": "cat >> /tmp/kookr-poc-002/events.jsonl" }] }]
  }
}
```

Note on matchers: `Stop`, `StopFailure`, `Notification`, `UserPromptSubmit`, `SessionEnd` use empty matcher `""` (no tool name to match on). `SessionStart` uses `"*"`. `PreToolUse`/`PostToolUse` use `"*"` to match all tool names.

### Observed Event Sequence (interactive session)

```
 1. SessionStart              — session begins
 2. InstructionsLoaded        — CLAUDE.md (User)
 3. InstructionsLoaded        — CLAUDE.md (Project)
 4. UserPromptSubmit          — user sends "say hello"
 5. Stop                      — agent finishes responding
 6. Notification (idle_prompt)— agent has been idle for ~60s
 7. UserPromptSubmit          — user sends second prompt
 8. PreToolUse (Read)         — agent starts reading file
 9. PostToolUse (Read)        — agent finishes reading file
10. Stop                      — agent finishes responding
11. SessionEnd                — user types /exit
```

### New Payload Schemas (not in PoC 001)

**UserPromptSubmit** — fires when user submits a prompt, before processing begins:
```json
{
  "session_id": "8ee8ff7c-...",
  "transcript_path": "/home/jean/.claude/projects/.../8ee8ff7c-....jsonl",
  "cwd": "/home/jean/git/kookr",
  "permission_mode": "acceptEdits",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "say hello"
}
```

**Notification (idle_prompt)** — fires ~60s after agent becomes idle:
```json
{
  "session_id": "8ee8ff7c-...",
  "transcript_path": "/home/jean/.claude/projects/.../8ee8ff7c-....jsonl",
  "cwd": "/home/jean/git/kookr",
  "hook_event_name": "Notification",
  "message": "Claude is waiting for your input",
  "notification_type": "idle_prompt"
}
```

**StopFailure** — fires when the turn ends due to API error:
```json
{
  "session_id": "43871e1c-...",
  "transcript_path": "/home/jean/.claude/projects/.../43871e1c-....jsonl",
  "cwd": "/home/jean/git/kookr",
  "hook_event_name": "StopFailure",
  "error": "billing_error",
  "last_assistant_message": "Credit balance is too low"
}
```

Known `error` values (from documentation + binary): `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`.

**SessionEnd** — fires when the session terminates:
```json
{
  "session_id": "8ee8ff7c-...",
  "transcript_path": "/home/jean/.claude/projects/.../8ee8ff7c-....jsonl",
  "cwd": "/home/jean/git/kookr",
  "hook_event_name": "SessionEnd",
  "reason": "prompt_input_exit"
}
```

Known `reason` values: `clear`, `resume`, `logout`, `prompt_input_exit`, `bypass_permissions_disabled`, `other`.

**InstructionsLoaded** — fires for each CLAUDE.md loaded at session start:
```json
{
  "session_id": "8ee8ff7c-...",
  "transcript_path": "/home/jean/.claude/projects/.../8ee8ff7c-....jsonl",
  "cwd": "/home/jean/git/kookr",
  "hook_event_name": "InstructionsLoaded",
  "file_path": "/home/jean/.claude/CLAUDE.md",
  "memory_type": "User",
  "load_reason": "session_start"
}
```

Known `load_reason` values: `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact`.

## Agent State Machine (derived from hooks)

The hook events define a reliable, observable state machine for agent lifecycle:

```
                    ┌─────────────────────────────────────────────┐
                    │                                             │
  SessionStart ──► INITIALIZING ──► UserPromptSubmit ──► ACTIVE  │
                    │                      ▲                │    │
                    │                      │                ▼    │
                    │               UserPromptSubmit      Stop   │
                    │                      ▲                │    │
                    │                      │                ▼    │
                    │                   ACTIVE ◄── ... ── IDLE   │
                    │                                       │    │
                    │                                       ▼    │
                    │                              Notification  │
                    │                             (idle_prompt)  │
                    │                                       │    │
                    │                                       ▼    │
                    │                              CONFIRMED_IDLE│
                    │                                            │
                    └──── StopFailure ──► ERRORED               │
                    └──── SessionEnd  ──► TERMINATED            │
                    └──── PermissionRequest ──► BLOCKED         │
                                                                │
                         PreToolUse ──► TOOL_RUNNING            │
                         PostToolUse ──► (back to ACTIVE)       │
```

### State Definitions

| State | Entry Signal | Exit Signal | Kookr Meaning |
|-------|-------------|-------------|----------------|
| **INITIALIZING** | `SessionStart` | `UserPromptSubmit` | Agent is loading, not yet processing |
| **ACTIVE** | `UserPromptSubmit` or `PostToolUse` | `Stop`, `StopFailure`, `PreToolUse` | Agent is thinking/responding |
| **TOOL_RUNNING** | `PreToolUse` | `PostToolUse`, `PostToolUseFailure` | Agent is executing a tool |
| **IDLE** | `Stop` | `UserPromptSubmit`, `SessionEnd` | Agent finished, waiting for input |
| **CONFIRMED_IDLE** | `Notification(idle_prompt)` | `UserPromptSubmit`, `SessionEnd` | Agent has been idle for ~60s (high-confidence idle) |
| **ERRORED** | `StopFailure` | `UserPromptSubmit`, `SessionEnd` | Turn failed due to API error |
| **BLOCKED** | `PermissionRequest` | `PostToolUse` (after approval) | Agent needs permission |
| **TERMINATED** | `SessionEnd` | (terminal state) | Session is over |

### Key Insight: Two-Stage Idle Detection

Claude Code provides two levels of idle detection:

1. **`Stop` hook** — immediate signal that the agent finished its turn. This is the "soft idle" signal. The agent is idle but the developer might send a follow-up promptly.

2. **`Notification(idle_prompt)`** — delayed signal (~60s after Stop) confirming the agent is genuinely idle and the developer hasn't responded. This is the "confirmed idle" signal.

For Kookr, this means:
- On `Stop`: mark agent as "needs_input" (info severity)
- On `Notification(idle_prompt)`: escalate to "confirmed idle" or auto-proceed if configured
- On `UserPromptSubmit`: clear idle state, mark agent as active

## Hooks Relevant for Kookr State Monitoring

### Must-Have (implement next)

| Hook | Why | Impact |
|------|-----|--------|
| **`Notification`** (matcher: `idle_prompt`) | Confirmed idle signal — most reliable "waiting for input" indicator | Replaces watchdog-based stale detection for idle |
| **`UserPromptSubmit`** | Transition from idle→active. Clears anomalies without watchdog heuristics | Direct state transition, no guessing |
| **`StopFailure`** | Detects API errors (rate limit, billing, auth) that kill the turn | New anomaly type: `api_error` with specific sub-types |
| **`SessionEnd`** | Definitive "agent is gone" signal | Clean session lifecycle — no phantom sessions |

### Should-Have (implement for completeness)

| Hook | Why | Impact |
|------|-----|--------|
| **`SubagentStart`/`SubagentStop`** | Track subagent spawning (Agent tool) | Better activity attribution |
| **`PostToolUseFailure`** | Tool-level errors (distinct from PostToolUse) | Better error detection |
| **`PreCompact`/`PostCompact`** | Context window pressure indicator | Could surface as info-level anomaly |
| **`InstructionsLoaded`** | Session initialization tracking | Observability |

### Nice-to-Have (defer)

| Hook | Why | Reason to defer |
|------|-----|-----------------|
| `TaskCreated`/`TaskCompleted` | Agent team task lifecycle | Kookr manages its own tasks |
| `TeammateIdle` | Agent team monitoring | Not yet using agent teams |
| `WorktreeCreate`/`WorktreeRemove` | Worktree lifecycle | Low-frequency event |
| `ConfigChange` | Settings mutation tracking | Audit only |
| `CwdChanged`/`FileChanged` | Filesystem events | Already tracked via PostToolUse CWD field |
| `Elicitation`/`ElicitationResult` | MCP input prompts | No MCP servers in managed agents yet |

## Implementation Plan

### Phase 1: Add 4 must-have hooks

1. Extend `HookEventName` type with `'Notification' | 'UserPromptSubmit' | 'StopFailure' | 'SessionEnd'`
2. Add corresponding `AgentEvent` variants: `notification`, `user_prompt`, `stop_failure`, `session_end`
3. Update `hook-parser.ts` to parse these events
4. Update `generateSettings()` to include these 4 hooks in settings files
5. Update `anomaly-detector.ts`:
   - `StopFailure` → new `api_error` anomaly type
   - `Notification(idle_prompt)` → escalate existing `needs_input` or add `confirmed_idle`
6. Update `watchdog.ts`:
   - `UserPromptSubmit` → clear stale state
   - `SessionEnd` → unregister agent

### Phase 2: Add should-have hooks

7. Add `SubagentStart`, `SubagentStop`, `PostToolUseFailure`, `PreCompact`, `PostCompact`
8. Update anomaly detection with subagent awareness

## Matcher Configuration

Important discovery: different hooks use different matcher patterns:

| Hook | Matcher | Why |
|------|---------|-----|
| `SessionStart` | `"*"` | Matches the `source` field (startup, resume, etc.) |
| `PreToolUse`, `PostToolUse`, `PermissionRequest` | `"*"` | Matches tool name |
| `Stop`, `StopFailure` | `""` | No matcher field — empty string means "always fire" |
| `Notification` | `""` | Fires for all notification types (idle_prompt, permission_prompt, etc.) |
| `UserPromptSubmit` | `""` | No matcher support |
| `SessionEnd` | `""` | No matcher support |
| `InstructionsLoaded` | `""` | Matches load reason |
| `SubagentStart`, `SubagentStop` | `""` | Matches agent type |

The current `generateSettings()` uses `"*"` for all hooks, which works but is slightly incorrect for non-tool hooks. Using `""` (empty matcher) is the correct approach for hooks without matcher semantics.

## Conclusion

The Claude Code hook system provides a complete, structured, real-time state machine for agent monitoring. The 5 hooks currently used by Kookr cover the core tool-execution lifecycle but miss critical state transitions:

1. **Idle→Active transition** (UserPromptSubmit) — currently inferred by watchdog heuristics
2. **Confirmed idle** (Notification/idle_prompt) — not detected at all
3. **API errors** (StopFailure) — not distinguished from normal stops
4. **Session termination** (SessionEnd) — not detected, leaving phantom sessions

Adding these 4 hooks eliminates the need for most watchdog heuristics and provides definitive state signals instead of probabilistic inference.
