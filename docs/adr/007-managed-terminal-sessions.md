# ADR-007: Agent Execution via Managed Terminal Sessions

## Status

**Accepted — persistence layer superseded by [ADR-014](014-local-dtach-backend.md)** (2026-04-22). The core decision (agents run in managed, persistent, interactive terminal sessions) still stands and is in force in the code; only the terminal-persistence *backend* changed — ADR-014 documents the switch from tmux to dtach (V8 tmux removal). The original `rfc-v8-tmux-removal.md` was archived when `docs/rfc/` was reset for the kookr cutover; ADR-014 now carries the load-bearing decision record.

<!-- Updated 2026-08-13: reconciled this header with the README index and ADR-014's "(persistence layer only)" scope — the previous blunt "Superseded by ADR-014" contradicted this ADR's own body ("the managed-interactive-session principle stands"). -->

*Original status:* **Accepted** (2026-03-24, by Jean Ibarz) — superseded ADR-004's "headless-only for V1" decision.

## Context

ADR-004 decided on headless-only execution for V1: agents launched with `-p` + `--output-format stream-json`, input delivered via `--resume <sessionId>`. While technically functional, this approach has significant limitations that became clear during design-phase analysis:

1. **No crash recovery**: if Kookr crashes, all headless agent processes are orphaned with no way to reattach. Developer loses visibility and control.
2. **No direct access**: the developer cannot "drop into" an agent's session to interact directly — everything must go through Kookr's GUI.
3. **Forced non-interactive mode**: agents are designed primarily for interactive terminal use. Headless mode is a secondary execution path with different behavior (no permission prompts, non-blocking `AskUserQuestion`, different output format).
4. **Input model overhead**: `--resume` spawns a new process per response, carrying full conversation history each time (issue #6). Context grows linearly with interactions.
5. **Resume complexity**: per-session serialization required (issue #9), session ID tracking across error cases (issue #5), and the "agent behavioral contract" needed to work around `AskUserQuestion` being non-blocking in headless mode (issue #3).

Running agents in **managed terminal sessions** (tmux) resolves all of these issues by keeping agents in their native interactive mode while giving Kookr programmatic control.

## Key Benefits of Managed Terminal Sessions

1. **Crash recovery**: terminal sessions survive Kookr crashes. Developer can reattach or restart Kookr — agents keep running.
2. **Direct access**: developer can attach to any agent's terminal at any time, even outside Kookr. Critical escape hatch.
3. **Native interactive mode**: agents run exactly as they were designed for humans. No behavioral contracts, no headless quirks, no `--resume` overhead.
4. **Natural input delivery**: send keystrokes to the session instead of spawning new processes. No context duplication.
5. **Better agent compatibility**: any CLI agent that works in a terminal works in a managed session — no need for agent-specific headless flags.

## Options

### Option A: tmux (recommended)

Most widely-used terminal multiplexer. Available on Linux and macOS.

**Programmatic API:**
- `tmux new-session -d -s <name> <command>` — create detached session running a command
- `tmux send-keys -t <name> "text" Enter` — send keystrokes
- `tmux capture-pane -t <name> -p -S -N` — capture N lines of scrollback
- `tmux pipe-pane -t <name> -o 'cat >> file'` — stream raw output to file
- `tmux has-session -t <name>` — check session existence
- `tmux kill-session -t <name>` — terminate session
- User attaches via `tmux attach -t <name>`

**Pros:**
- Ubiquitous on Linux; available via Homebrew on macOS
- Best-in-class programmatic API — named sessions, output streaming, input delivery
- Sessions survive parent process crashes (the entire point)
- User can attach/detach at will from any terminal
- Battle-tested, massive community, extensive documentation
- `pipe-pane` enables real-time output streaming to Kookr

**Cons:**
- External dependency (must be installed; not always pre-installed on macOS)
- Output includes ANSI escape codes — needs stripping for analysis
- Adds a layer between Kookr and the agent process

### Option B: GNU Screen

Older terminal multiplexer, often pre-installed on Linux.

**Programmatic API:**
- `screen -dmS <name> <command>` — create detached session
- `screen -S <name> -X stuff "text\n"` — send input
- `screen -S <name> -X hardcopy /tmp/output` — snapshot output

**Pros:**
- Often pre-installed on Linux
- Sessions survive crashes

**Cons:**
- **No streaming output capture** (only point-in-time snapshots via `hardcopy`)
- `stuff` command has buffering quirks with long inputs
- Weaker programmatic API than tmux
- Less active development
- Less flexible session management

### Option C: Zellij

Modern Rust-based terminal multiplexer with a plugin system.

**Pros:**
- Modern design, plugin architecture
- Active development
- Could enable deep integration via plugins

**Cons:**
- Not widely installed (explicit install required on most systems)
- Smaller community and less documentation
- Plugin API is Rust/WASM-based — harder to drive from Node.js
- Less mature programmatic control compared to tmux

### Option D: dtach / abduco (minimal detach)

Lightweight tools providing session detachment only, no multiplexing.

**Pros:**
- Minimal footprint — does one thing
- Sessions survive crashes

**Cons:**
- **No output capture API** — cannot stream or snapshot terminal content
- **No input sending API** beyond raw socket writes
- Not widely installed
- Tiny communities
- Would need a separate solution for monitoring

### Option E: node-pty (direct PTY management)

Use Node.js `node-pty` library to manage pseudo-terminals directly.

**Pros:**
- No external tool dependency
- Full control over PTY read/write from Node.js
- Structured access to terminal I/O

**Cons:**
- **Sessions die when Kookr crashes** — defeats the primary goal
- **User cannot attach from outside Kookr** — defeats the second goal
- Native C++ module — adds build complexity, potential compatibility issues
- Essentially recreates the headless approach but worse

## Evaluation

| Criterion | Weight | tmux | Screen | Zellij | dtach | node-pty |
|-----------|--------|------|--------|--------|-------|----------|
| Sessions survive Kookr crash | Critical | Yes | Yes | Yes | Yes | **No** |
| User can attach from outside | Critical | Yes | Yes | Yes | Limited | **No** |
| Programmatic input delivery | Critical | Excellent | Adequate | Good | Poor | Excellent |
| Streaming output capture | High | Yes (`pipe-pane`) | **No** | Plugin | **No** | Yes |
| Linux + macOS availability | High | Good | Good | Poor | Poor | Excellent |
| Community / maturity | Medium | Excellent | Good | Growing | Niche | Good |
| No native build dependency | Medium | Yes | Yes | Yes | Yes | **No** |

## Decision

**Use managed tmux sessions for agent execution.** Accepted by Jean Ibarz on 2026-03-24.

tmux wins on every critical criterion and has the best streaming output capture (`pipe-pane`). Screen lacks streaming capture. Zellij and dtach lack availability. node-pty fails the two most critical requirements. PoC validation (2026-03-24) confirmed that structured monitoring data is available via hooks and transcript JSONL — no ANSI terminal parsing needed.

## Empirical Validation (2026-03-24)

### Key Finding: Structured Data Available in Interactive Mode

Testing confirmed that Claude Code interactive mode in tmux provides **three structured data sources simultaneously** — eliminating the terminal parsing concern:

1. **Hooks** (`PreToolUse`, `PostToolUse`, `Stop`): Fire in interactive mode. Receive full JSON on stdin with `session_id`, `tool_name`, `tool_input`, `tool_response`, `last_assistant_message`. Real-time, pushed as events happen.

2. **Transcript JSONL** (`~/.claude/projects/<project>/<session_id>.jsonl`): Written during interactive sessions. Contains user messages, assistant responses, tool calls, tool results, progress events — essentially the same structured data as `--output-format stream-json`. File-watchable for tailing.

3. **`tmux capture-pane`**: Clean ANSI-stripped text snapshot of current terminal state. Suitable for GUI display.

### What Was Tested

| Test | Result |
|------|--------|
| `--output-format stream-json` without `-p` | **Fails.** Implicitly activates `--print` (headless). Error: "Input must be provided when using --print" |
| `--output-format stream-json` is interactive-compatible? | **No.** JSON streaming and interactive mode are mutually exclusive in Claude Code |
| Interactive mode in tmux | **Works.** Full TUI renders correctly. `send-keys` delivers input. `capture-pane` reads screen state |
| `pipe-pane` for raw output | Works but gives raw ANSI escape codes — not suitable for structured parsing |
| Hooks in interactive mode | **Work.** Receive structured JSON on stdin: session_id, tool_name, tool_input, tool_response |
| Transcript JSONL file | **Exists.** Written at `~/.claude/projects/<project>/<session_id>.jsonl` with full conversation structure |
| Codex CLI `--json` in interactive | **No.** Only in `codex exec` mode |
| Codex CLI interactive in tmux | **Works.** Full TUI. Session files written to `~/.codex/sessions/YYYY/MM/DD/` |

### Monitoring Strategy (validated)

For Claude Code, the recommended monitoring approach is:
- **Anomaly detection**: Tail the transcript JSONL file (structured data, same format as headless output) + hooks for real-time event notification
- **GUI display**: `tmux capture-pane` for terminal snapshot
- **No ANSI parsing needed** for monitoring logic — hooks and transcript provide structured data

For Codex CLI, session files in `~/.codex/sessions/` provide similar structured data.

## Consequences

### Changes from the headless approach (ADR-004)

| Aspect | ADR-004 (headless) | ADR-007 (managed terminal) |
|--------|--------------------|-----------------------------|
| Agent execution mode | Headless (`-p` + `--output-format stream-json`) | Interactive (native mode) inside managed terminal session |
| Output format | Structured JSONL on stdout | Hooks (real-time structured JSON) + transcript JSONL (file-watchable) + `capture-pane` (display) |
| Input delivery | `--resume <sessionId> -p "input"` (spawns new process) | `send-keys` to existing session (keystrokes) |
| Crash recovery | None — orphaned processes | Full — sessions survive in tmux |
| Developer access | None — must use Kookr GUI | `tmux attach -t <session>` from any terminal |
| Session continuity | New process per response | Single long-lived process |
| Context cost | Grows linearly per resume (issue #6) | No duplication — single continuous session |
| Permission mode | Forced `bypassPermissions` (ADR-006) | Configurable — interactive prompts work natively |
| `AskUserQuestion` | Non-blocking, needs behavioral contract (issue #3) | Blocking (native interactive behavior) — no contract needed |
| Resume serialization | Required per session (issue #9) | Not applicable — no resume subprocess |

### Issues resolved by this change

| Issue | Resolution |
|-------|-----------|
| **#3** `AskUserQuestion` non-blocking in headless | No longer relevant — interactive mode is blocking. Agent waits for input naturally |
| **#5** Session ID mismatch on resume errors | No longer relevant — no `--resume` subprocess |
| **#6** Resume cost accumulation | No longer relevant — single continuous session, no context duplication |
| **#9** Resume race conditions / serialization | No longer relevant — no concurrent resume processes |

### New capabilities enabled

- **F2.4 (permission block detection)** becomes feasible again — permission prompts appear in the terminal and can be detected via output monitoring. ADR-006 should be revisited.
- **Direct terminal access** — developer can attach to any agent session, even if Kookr is down.
- **Agent-agnostic execution** — any CLI agent that works in a terminal works in a managed session. No need for agent-specific headless flags.

### New challenges introduced

| Challenge | Mitigation |
|-----------|-----------|
| **Monitoring**: `--output-format stream-json` is incompatible with interactive mode | Validated alternative: hooks provide real-time structured events; transcript JSONL file provides full session history; `capture-pane` provides clean display snapshots. No ANSI parsing needed for monitoring logic |
| **External dependency**: tmux (or chosen tool) must be installed | Check at startup, provide clear install instructions. tmux is widely available on target platforms |
| **Output parsing fragility**: agent output format may change across versions | Use conservative pattern matching; prefer hooks or structured side-channels over terminal scraping where available |
| **Terminal dimensions**: agent behavior may depend on terminal size | Set consistent terminal dimensions when creating sessions |

### Supersedes

- **ADR-004** "headless-only for V1" decision is superseded. The research findings (CLI capabilities, session file formats) remain valid reference material.
- **ADR-006** conclusions should be revisited — `bypassPermissions` is no longer the only viable mode.

### Does NOT affect

- **ADR-005** (discovered agent degradation) — still deferred from V1. The tiered degradation concept applies to managed terminal sessions too.
- **Supervisor agent** design — still detects anomalies and generates explanations, but consumes different input (parsed terminal output instead of JSONL events).
- **Attention router** design — unchanged. Still manages priority queue, skip/snooze, auto-advance.
- **Task lifecycle** — unchanged. Tasks still track goals across agent sessions.

## Open Questions

| Question | Notes |
|----------|-------|
| ~~What is the best monitoring mechanism for interactive agents?~~ | **Answered (2026-03-24):** Hooks + transcript JSONL tailing for structured events. `capture-pane` for display. Validated by PoC 2026-03-24 |
| ~~Should Kookr require tmux or bundle an alternative?~~ | **Decided (2026-03-24):** Require tmux. Check at startup, provide clear install instructions |
| How to handle terminal dimensions for consistent agent behavior? | Set via `tmux` options at session creation; allow override in config |
| ~~Can Claude Code hooks provide structured events alongside interactive mode?~~ | **Answered (2026-03-24):** Yes. Hooks fire in interactive mode with full JSON on stdin. Validated by PoC |
| ~~How to configure hooks per managed agent?~~ | **Answered (2026-03-24):** Kookr generates a per-agent settings JSON file with hook definitions (appending to agent-specific JSONL files in `~/.kookr/hooks/`). Passed via `--settings <path>` at agent launch. Hooks are additive — user's own hooks from `~/.claude/settings.json` still fire. The `PermissionRequest` hook also fires in interactive mode, enabling F2.4 (permission-block detection). See [PoC 001](../poc/001-hook-mechanism-validation.md) |
