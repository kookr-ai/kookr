# ADR-004: Agent Interaction Mechanisms

## Status

**Superseded** — The "headless-only for V1" decision is superseded by [ADR-007](007-managed-terminal-sessions.md) (managed terminal sessions), and the tmux-specific terminal persistence details in ADR-007/008 were later superseded by [ADR-014](014-local-dtach-backend.md). The research findings below (CLI capabilities, session files, JSONL formats) remain valid reference material.

Originally: Proposed (replaces the deprecated abstract protocol design — now based on concrete research)

## Context

Kookr must discover, monitor, and send input to AI coding agents. Research into Claude Code and Codex CLI reveals specific, concrete mechanisms available. This ADR documents what's actually possible and recommends a strategy.

## Research Findings

### Claude Code

| Capability | Mechanism | Notes |
|-----------|-----------|-------|
| **Discover running sessions** | Read `~/.claude/sessions/{pid}.json` files | Contains `pid`, `sessionId`, `cwd`, `startedAt`. Verify PID alive with `kill -0`. |
| **Launch in headless mode** | `claude -p "prompt" --output-format stream-json --verbose --permission-mode bypassPermissions` | One-shot: runs to completion, streams JSONL events. Stdin closed immediately. `bypassPermissions` is the only viable mode — see [ADR-006](006-permission-mode-feasibility.md). |
| **Monitor output (real-time)** | Parse JSONL from stdout | Events: `system`, `assistant` (with `content[]` blocks for tool calls), `user`, `result`. |
| **Send follow-up input** | `claude --resume <sessionId> -p "new prompt" --output-format stream-json --verbose` | Spawns a NEW process that resumes the conversation. Not stdin injection — new subprocess. |
| **Inject input into running interactive session** | **NOT POSSIBLE** via documented API | Interactive mode uses raw TTY. No programmatic stdin injection. |

### Codex CLI

| Capability | Mechanism | Notes |
|-----------|-----------|-------|
| **Discover sessions** | List `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` files | Date-partitioned directory. First line is `session_meta` JSON with UUID `id`, `cwd`, `timestamp`. **No PID field** — liveness can only be inferred from filesystem mtime. |
| **Launch in headless mode** | `codex exec --json -C <dir> -m <model> -` (prompt via stdin) | Streams JSONL events. Different event schema than Claude Code. |
| **Monitor output (real-time)** | Parse JSONL from stdout | Events: `session_meta`, `response_item`, `event_msg` (with sub-types for user/agent messages, tool calls, turn lifecycle). |
| **Send follow-up input** | `codex exec resume --json <threadId> -` (prompt via stdin) | Same pattern as Claude Code: new subprocess, resumes session. |
| **Inject input into running interactive session** | **NOT POSSIBLE** in exec mode | TUI mode is interactive but not programmatically controllable. |

### Key Insight

Both agents use the same pattern: **one-shot headless execution + session resume for follow-ups**. Neither supports injecting input into an already-running process. This means:

1. **Kookr-launched agents** (headless mode): Kookr spawns them, monitors JSONL, and uses `--resume` to send follow-ups.
2. **Externally-launched agents** (interactive mode in terminals): Kookr can **discover** them (via session files) and see metadata, but **cannot send them input**. The developer must switch to that terminal.

## Options

### Option A: Headless-only (Kookr launches all agents)

Kookr always launches agents in headless mode (`-p` + `--output-format stream-json`). For follow-ups, it uses session resume (`--resume`).

**Pros:**
- Full control: structured JSONL output, session IDs, cost tracking
- Input delivery works via `--resume`
- Proven pattern (exactly what aegiscore does)

**Cons:**
- Cannot interact with agents the developer started manually in terminals
- Agents run "headless" — no interactive terminal experience

### Option B: Discover + Headless hybrid (recommended)

Two modes:
1. **Kookr-launched agents**: Spawned in headless mode. Full monitoring + input delivery via `--resume`.
2. **Discovered agents**: Found via `~/.claude/sessions/` (PID, cwd, start time) and `~/.codex/sessions/` (UUID, cwd, start time — **no PID**, liveness inferred from file mtime). Kookr shows their existence and available metadata. But monitoring is **read-only** — Kookr cannot see their output or send them input. It shows a "switch to terminal" action.

**Pros:**
- Immediately useful for the aegiscore use case (discover agents spawned by another system)
- Full control over Kookr-launched agents
- Honest about limitations — no fake interactivity with external agents

**Cons:**
- Two tiers of agent support (full vs discovery-only)
- Discovered agents are "second-class" — limited info

### Option C: PTY/tmux wrapper

Wrap all agents in a PTY or tmux session that Kookr controls. Send input via tmux `send-keys` or PTY write.

**Pros:**
- Could theoretically work with any CLI tool
- Supports interactive mode

**Cons:**
- Requires tmux or PTY library dependency
- Parsing unstructured terminal output is extremely fragile
- No structured JSONL — back to pattern matching
- tmux may not be installed; adds system dependency
- Terminal escape codes, colors, progress bars make parsing nightmarish

### Option D: Combination of B + limited C

Use Option B as the default. For discovered agents that Kookr didn't launch, offer a "take over" action that:
1. Sends `--resume <sessionId>` to continue the session under Kookr's control
2. The original terminal process may need to be terminated first

**Pros:**
- Best of both worlds
- "Take over" gives a path from discovery-only to full control

**Cons:**
- Resuming may duplicate or conflict if original process is still running
- Need to handle the "two processes, same session" problem carefully

## Decision

~~**Option A** (headless-only) for V1, with **Option B** (discover + headless) as a future enhancement.~~

**Superseded by [ADR-007](007-managed-terminal-sessions.md) and [ADR-014](014-local-dtach-backend.md).** Agents now run in interactive mode inside managed dtach-backed sessions, not headless mode. Input is delivered to the running process through the terminal backend, not `--resume`. The research findings in this ADR (CLI capabilities, JSONL formats, session file locations) remain valid reference material.

Agent discovery remains deferred from V1 — see [ADR-005](005-discovered-agent-degradation.md).

## Consequences

- Agent launching from Kookr GUI becomes important early (can't fully interact with discovered agents)
- The `--resume` pattern means each "response" spawns a new short-lived process
- Session IDs must be tracked (returned in JSONL `result` event)
- Two levels of agent support in the UI: "managed" (full) and "discovered" (limited)
- Future: investigate if Claude Code adds a `--attach` mode or WebSocket control plane

## Implementation Notes

### Discovery

```typescript
// Claude Code: read ~/.claude/sessions/
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

function discoverClaudeCodeSessions(): AgentInfo[] {
  const sessionsDir = join(homedir(), '.claude', 'sessions');
  const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

  return files.map(f => {
    const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'));
    const isAlive = isProcessAlive(data.pid);
    return {
      type: 'claude-code',
      pid: data.pid,
      sessionId: data.sessionId,
      cwd: data.cwd,
      startedAt: data.startedAt,
      alive: isAlive,
      managed: false,  // discovered, not launched by Kookr
    };
  }).filter(a => a.alive);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
```

### Launching (headless)

```typescript
// Reuse aegiscore pattern
const proc = spawn('claude', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
  ...(model ? ['--model', model] : []),
  ...(systemPrompt ? ['--append-system-prompt', systemPrompt] : []),
], {
  cwd: workingDir,
  env: { ...process.env, CLAUDECODE: undefined },
  stdio: ['pipe', 'pipe', 'pipe'],
});
proc.stdin?.end();
// Parse JSONL from proc.stdout
```

### Sending follow-up input (session resume)

```typescript
const proc = spawn('claude', [
  '--resume', sessionId,
  '-p', userInput,
  '--output-format', 'stream-json',
  '--verbose',
  '--permission-mode', 'bypassPermissions',
], {
  cwd: workingDir,
  env: { ...process.env, CLAUDECODE: undefined },
  stdio: ['pipe', 'pipe', 'pipe'],
});
proc.stdin?.end();
// Parse JSONL, extract new sessionId from result event
```
