# ADR-009: Interactive Terminal in the Browser GUI

## Status

**Accepted** (2026-03-24, by Jean Ibarz)

> **Revisit 2026-04-24 (ADR-014 impact):** The core decision — use node-pty + xterm.js + a binary WebSocket to embed an interactive terminal — is still current. The **persistence layer described in this ADR (node-pty spawning `tmux attach -t <name>`) was replaced by dtach per ADR-014 (Main B)**. `SessionBridge` now spawns `dtach -a <sock> -E`; `tmux capture-pane` polling was removed along with the tmux backend (`src/server/start.ts` hard-rejects `KOOKR_BACKEND=tmux`). The `/ws/terminal/:tmuxName` route still exists by that parameter name but attaches to a dtach socket. Ignore tmux-specific mechanism details below; refer to ADR-014 for the current implementation.

## Context

Kookr's GUI currently displays terminal output as read-only snapshots via `tmux capture-pane`, polled every 2 seconds. Developers interact with agents either by typing responses in Kookr's input box (delivered as `tmux send-keys`) or by attaching to the tmux session from an external terminal (`tmux attach -t kookr-xxx`).

This works but creates friction for interactive permission prompts and menu navigation:

1. **Permission approval requires leaving the GUI.** When Claude Code asks for permission (arrow-key selection menu), the developer must either `tmux attach` from a separate terminal or blindly type `y` via `send-keys`. The capture-pane snapshot shows the menu but the developer can't navigate it.
2. **Context switching is expensive.** The developer sees the anomaly explanation + conversation in Kookr, then must open a terminal, run `tmux attach`, interact, detach, and return to Kookr. This breaks the triage loop.
3. **F4.6 is partially satisfied.** The feature spec says "Open an agent's managed terminal session directly — from the GUI (e.g., a button that prints the attach command)." Currently, attaching requires copy-pasting a tmux command. An in-browser terminal would fully satisfy F4.6.

### Relationship to ADR-007

ADR-007 evaluated and **rejected node-pty as the session management layer** (Option E). The rejection was correct — node-pty alone fails two critical requirements:
- Sessions die when Kookr crashes
- User cannot attach from outside Kookr

**This proposal does not revisit that decision.** tmux remains the session management layer. The proposal is to use node-pty (or equivalent) as a **display bridge** — spawning `tmux attach -t <name>` inside a browser-connected PTY. This is architecturally similar to how VS Code's terminal works: it doesn't replace the underlying shell/multiplexer, it provides a browser window into it.

```
                  ADR-007 scope (unchanged)
                  ┌─────────────────────────────┐
Browser           │  tmux                        │
┌──────────┐      │  ┌───────────────────────┐   │
│ xterm.js │◄─WS─►│  │ tmux attach -t name   │   │
│          │      │  │   (via node-pty)       │   │
└──────────┘      │  └───────────┬───────────┘   │
                  │              │                │
                  │  ┌───────────▼───────────┐   │
                  │  │ kookr-xxx session     │   │
                  │  │   claude --settings... │   │
                  │  └───────────────────────┘   │
                  └─────────────────────────────┘
```

If Kookr crashes: the tmux session survives (ADR-007 guarantee preserved). The xterm.js connection drops, but the developer can still `tmux attach` from any terminal. When Kookr restarts, it reconnects.

## Options

### Option A: xterm.js + node-pty bridge (recommended)

Add a WebSocket endpoint (`/ws/terminal/:tmuxName`) that:
1. Spawns `tmux attach -t <tmuxName>` via node-pty
2. Streams PTY output → WebSocket → xterm.js in browser
3. Streams browser keystrokes → WebSocket → PTY stdin

The right panel of the P33 layout replaces the static `capture-pane` div with an xterm.js `Terminal` instance.

**Pros:**
- Full interactive terminal: arrow keys, Tab, Ctrl+C, ANSI colors, cursor, alternate screen
- Developer can approve permissions, navigate menus, scroll — all from the GUI
- No new session management — tmux still owns the session lifecycle
- Battle-tested stack (VS Code, Theia, Gitpod all use xterm.js + node-pty)
- F4.6 fully satisfied — "attach to terminal" is seamless, no context switch
- `@xterm/addon-fit` handles resize, `@xterm/addon-web-links` makes URLs clickable

**Cons:**
- node-pty is a native C++ module — adds build complexity (node-gyp / prebuild)
- Adds ~3 dependencies: `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`
- Each browser terminal tab holds an open PTY + tmux client process
- Terminal WebSocket is separate from the data WebSocket (two connections per active terminal)

### Option B: Keep capture-pane snapshots (status quo)

Continue polling `tmux capture-pane` every 2 seconds. Developers attach via external terminal for interactive input.

**Pros:**
- No new dependencies
- Simpler architecture
- No native module build complexity

**Cons:**
- Cannot interact with permission prompts or menus from the GUI
- 2-second polling delay — not real-time
- No ANSI colors, no cursor, no scrollback
- F4.6 only partially satisfied — requires external terminal
- Context switch breaks the triage flow

### Option C: tmux pipe-pane streaming + send-keys (enhanced status quo)

Replace polling with real-time output via `tmux pipe-pane`. Keep `send-keys` for input.

**Pros:**
- Real-time output (no polling delay)
- No native module dependency

**Cons:**
- Still cannot handle interactive menus (arrow keys via send-keys don't work reliably for UI navigation)
- Raw terminal output requires ANSI parsing to render properly
- send-keys is fire-and-forget — no feedback on whether input was received
- More complex than capture-pane polling but still less capable than xterm.js

## Evaluation

| Criterion | Weight | A: xterm.js | B: capture-pane | C: pipe-pane |
|-----------|--------|-------------|-----------------|--------------|
| Interactive prompts (arrow keys, menus) | Critical | Yes | **No** | **No** |
| Real-time output | High | Yes | No (2s poll) | Yes |
| ANSI colors + cursor | High | Yes | No | Partial |
| No native module | Medium | **No** (node-pty) | Yes | Yes |
| Build simplicity | Medium | Fair | Excellent | Good |
| F4.6 fully satisfied | High | Yes | **No** | **No** |
| Preserves ADR-007 guarantees | Critical | Yes | Yes | Yes |

## Recommendation

**Option A: xterm.js + node-pty bridge.**

The interactive terminal is critical for the triage workflow — developers need to approve permissions and navigate Claude Code's interactive menus without leaving Kookr. The native module dependency (node-pty) is a known trade-off, but it's the same dependency used by VS Code, the most widely-deployed code editor. Prebuilt binaries are available for Linux and macOS.

The implementation preserves all ADR-007 guarantees: tmux manages sessions, sessions survive crashes, developers can attach externally. xterm.js is purely a display/input bridge.

## Implementation Notes

If accepted:

1. **Dependencies:** `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
2. **New WebSocket endpoint:** `ws://host:port/ws/terminal/:tmuxName` — one per active terminal view
3. **PTY lifecycle:** Spawn on WebSocket connect, kill on disconnect. If browser tab closes, PTY dies but tmux session continues.
4. **Resize protocol:** Browser sends `{ type: 'resize', cols, rows }` messages. Server calls `pty.resize(cols, rows)`.
5. **Frontend:** Replace `terminal-body` div in DetailPanel with xterm.js `Terminal` mount. Keep conversation panel unchanged.
6. **Fallback:** If node-pty fails to load (e.g. missing native build), fall back to capture-pane polling with a "full terminal requires native module" notice.
