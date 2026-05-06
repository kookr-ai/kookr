# Report — Why wheel scroll doesn't show Claude Code's past output, even under dtach

**Date:** 2026-04-22
**Author:** Jean Ibarz (with Claude)
**Context:** post-v7 (PRs #337, #340, #342, #343). v7 replaced tmux with dtach and fixed the wheel-cycles-prompt-history bug. Wheel in a Kookr terminal now sends zero bytes to the agent — the cycling regression is dead. But wheel still visibly does nothing over Claude Code's conversation area. This report explains why, documents the empirical evidence, summarizes what Ink/React-TUI rendering means for browser terminal UX, and maps the real options forward against the findings in `~/git/deepresearch/`.

## TL;DR

Claude Code renders its UI with `\e[2J` (erase entire display) + repaint on every frame — a standard Ink/React-TUI pattern. xterm.js only accumulates scrollback from content that scrolls off the top via newlines, not from content erased via `\e[2J`. We set `scrollOnEraseInDisplay: true` expecting it to save the cleared frame into scrollback, but **empirical testing shows scrollback still does not populate**, independent of backend (tmux or dtach).

This is a terminal-emulator-layer limitation. No amount of tmux/dtach/xterm config work gives the user a "wheel up to read Claude's earlier output" UX as long as Claude Code uses Ink-style rendering.

Two realistic paths forward:

1. **Server-side scrollback buffer** — maintain an authoritative terminal state model on the server (e.g. `vt100` or `alacritty_terminal` crate), intercept wheel events, and serve history to the frontend on demand. Medium-size engineering (1–2 weeks), unlocks scroll that is independent of agent rendering pattern.
2. **Accept the limitation** — document it, use Claude Code's built-in `Ctrl+O` (expand collapsed output) and scrollback-via-transcript-log as the official UX. Zero engineering.

Deepresearch report 4 (`~/git/deepresearch/deepresearch_report4.md`) directly informs path 1: `vt100` is the simplest, `alacritty_terminal` is the safest production choice, `wezterm-term` has the richest semantics.

## What we shipped in v7

- **PR #337** — capture-phase wheel handler in `TerminalPanel.tsx` (blocks `\eOA`/`\eOB` from reaching the agent)
- **PR #340/#342/#343** — `LocalDtachBackend`, `SessionBridge` with 64 KB ring buffer, flipped default to dtach
- **Frontend xterm.js config** — `fastScrollSensitivity: 5`, `scrollSensitivity: 1`, `scrollOnEraseInDisplay: true`, `scrollOnUserInput: false`

All of that still stands. It **is** progress — the architecture is cleaner, cycling bug is dead, byte-transparency is achieved, future agent-side terminal features (kitty graphics, OSC 52, mouse-when-agents-adopt-it) work automatically. It just doesn't deliver wheel-up-scroll-through-past-output for Ink-rendered TUIs.

## Empirical evidence (reproducible)

### 1. Claude Code's rendering pattern

Captured `~2 KB` of raw output from `/tmp/kookr-dtach/1000/port-4800/kookr-c1c8bcc4.sock` via `dtach -a` while Claude was actively rendering:

```
[H[J[?2026h[2D[3B[2J[H[2CLINE[1C146
[2CLINE[1C147
...
```

Modes emitted: `?2026h` (DECSET 2026 sync-output), `?2026l`. **No `?1049h` (alt-buffer).** Claude Code stays in normal buffer. But uses `\e[2J` (erase entire display) + absolute cursor positioning to rebuild the frame on every refresh. This matches the output pattern of any Ink / React-TUI library: mutate a virtual DOM, diff it, clear + repaint.

### 2. xterm.js `scrollOnEraseInDisplay` is set but doesn't populate scrollback

Deployed bundle `$HOME/git/kookr-prod/dist/frontend/assets/index-DgB7C9lK.js` contains `scrollOnEraseInDisplay:!0,scrollOnUserInput:!1` (set by `TerminalPanel.tsx`).

Relevant xterm.js source at `node_modules/.../@xterm/xterm/lib/xterm.mjs`:

```js
case 2: if (this._optionsService.rawOptions.scrollOnEraseInDisplay) {
  for (r = this._bufferService.rows, ...; r-- && !this._activeBuffer.lines.get(...)?.getTrimmedLength(); ) ;
  for (; r >= 0; r--) this._bufferService.scroll(this._eraseAttrData())
}
```

Case 2 == `\e[2J`. The intent is: scroll current viewport rows into scrollback before erasing. But our empirical observation after Claude has rendered 200 lines of `LINE N` output:

```js
{ vpScrollTop: 0, vpScrollHeight: 797, vpClientHeight: 797, rowCount: 56 }
```

`scrollHeight === clientHeight` → **no scrollable content**. First visible row is `LINE 154`; lines 1–153 are neither visible nor in scrollback. Either (a) the scroll-to-scrollback code paths don't trigger for Claude's specific sequence (e.g. DECSET 2026 defers the case-2 save until the batch ends, then an `\e[H` overwrites before xterm renders), or (b) the scroll happens but immediately gets overwritten by the next batch. Either way: **the net behavior is no scrollback, independent of the backend.**

### 3. Wheel emits zero bytes and changes nothing visible

With 200 lines on screen:

```js
{ bytesSentOnWheel: 0 }  // 0 ESC-prefixed writes across 20 wheel events
```

Before vs after 20 wheel-up ticks → three pixel-identical screenshots (`/tmp/dtach-scroll-0-bottom.png`, `/tmp/dtach-scroll-1-up.png`, `/tmp/dtach-scroll-2-further-up.png`). Wheel correctly doesn't cycle prompt history (PR #337 works under dtach too), but there's nothing for xterm.js to scroll to.

## Why no terminal-layer tweak fixes this

Ink / React-TUI rendering is a design choice by the agent: "I own the full viewport; I redraw on every state change." This is distinct from classical terminal UIs that emit lines and advance the cursor. In the first pattern, the terminal emulator sees a stream of "clear + redraw everything" operations. xterm.js's normal-buffer scrollback is populated when content scrolls off the top via newlines or explicit `IND`/`NEL`, not when the screen is cleared via `ED 2`.

This is not xterm-specific. Per deepresearch report 4:

> **libvte says alt-screen has no scrollback** — explicit documented behavior. *(Claude is in normal buffer, not alt-buffer, so this isn't directly the limit here — but it's the same kind of unavoidable architectural cliff.)*

Native terminals (alacritty, iTerm2, kitty) behave the same way for Ink-rendered apps — try wheel-scrolling in a native terminal running `claude` and you see the same limitation. This is a property of how Ink renders, not of any specific terminal emulator.

## What deepresearch report 4 says matters

I cross-read `~/git/deepresearch/deepresearch_report4.md` (Rust terminal cores for web embedding) against this problem. Relevant findings:

### Option A — Server-side authoritative terminal state

Report 4's recommendation for a Rust terminal core behind a browser frontend:

> If you want **a lightweight, deterministic screen model** for replay, diffs, tests, or AI extraction, choose `vt100`. It processes `&[u8]`, keeps an in-memory screen with scrollback, exposes alt-screen state and xterm mouse modes/encodings, and can emit formatted full-screen state or diffs.
>
> If you want **Rust authoritative terminal state over the web**, choose `alacritty_terminal` — best blend of active maintenance, published-crate ergonomics, and real benchmark evidence.

What this buys us:

- **Server-side emulator tracks every byte.** When Claude clears with `\e[2J`, the server-side terminal model ALSO sees the clear — but it can additionally preserve the pre-clear state into an unbounded history buffer.
- **Client-side wheel requests scrollback frames.** Frontend intercepts wheel events when scrolled-up, asks the server for snapshot N frames back. Server returns the grid state as a frame or diff.
- **Independent of Ink rendering.** Works for any agent, no upstream changes needed.

The server-side vt100 / alacritty_terminal lives as a new Rust subprocess or compiled-to-WASM module. It receives the byte stream from dtach (we have that), emits a sequence of "frames" (full grid or diff), and keeps the last N frames in memory. Frontend shows the live frame by default; on wheel-up-while-at-bottom it requests frame N-k and renders it alongside or in place of the live frame.

### Option B — xterm.js addon-serialize + headless-terminal replay

Same pattern as Option A, but purely in JS. xterm.js ships `@xterm/headless` (parses streams into an in-memory grid) and `@xterm/addon-serialize` (emits the grid as ANSI bytes). The server-side ring buffer already exists in `SessionBridge` (64 KB). We could extend it to a larger scrollback tier, or maintain a headless-xterm instance per session server-side.

Report 4 evaluates this path:

> xterm.js headless/serialize, `tty-web` session/sharing features, and `par-term-emu-core-rust` replay/snapshot tooling are useful here, but they do not eliminate the need for a true session host if server restarts are in scope.

For our case, server restart is already handled by dtach. We only need replay for scroll-back UX. `@xterm/headless` running on the Node server as a sibling to the live xterm.js browser instance is a plausible architecture, probably simpler than a Rust-core subprocess.

### Option C — WezTerm's wheel-to-arrow fallback

Report 4 highlights WezTerm's behavior:

> WezTerm documents wheel-to-arrow fallback in alt-screen when mouse reporting is not active.

WezTerm synthesizes Up/Down arrow keys on wheel events when the app is in alt-screen and hasn't requested mouse reporting. This matches what xterm.js already did for us, but WezTerm triggers it in alt-screen specifically. We already block that translation via PR #337 to prevent cycling Claude's input history — the byte interpretation by Claude is wrong.

Not applicable here.

### Option D — Different terminal core entirely

Report 4 evaluates replacing xterm.js with a Rust core compiled to WASM:

> For a web application in 2026, there is still **no Rust-native terminal core that is both production-proven in the browser and clearly superior to xterm.js as a browser-rendered frontend**.

Not recommended. xterm.js is the right browser renderer; the lever we have is what lives server-side between dtach and xterm.

## Recommended paths forward

### Path 1 — Ship a server-side scrollback protocol (the real fix)

Architecture:

- **`SessionBridge` keeps an in-memory xterm.js headless instance per session** (via `@xterm/headless` — same parser xterm.js uses client-side, so no byte-interpretation drift).
- **Ring-buffer upgraded from 64 KB raw bytes to 4 MB of parsed frames**, or equivalently a headless xterm with 10 000-line scrollback configured server-side (same default xterm.js uses). The headless instance is the source of truth; serving scrollback means emitting rows from its buffer.
- **New WebSocket message type**: `{"type":"scrollback-request","linesBack":N,"viewportRows":R}`. Server reads those rows from the headless instance's scrollback, serializes via `@xterm/addon-serialize`, and sends as a binary frame marked as "scrollback replay, do not follow-bottom".
- **Frontend intercepts wheel-up-while-at-bottom**: instead of calling `terminal.scrollLines(-N)` (which does nothing for Ink apps), emit a `scrollback-request`, receive the bytes, and either (a) overlay a scrollback pane above the live viewport or (b) switch to a scrollback view and re-render.

Engineering scope: ~1–2 weeks. The headless xterm instance is well-trodden territory (VS Code uses it for its own reasons). The overlay-vs-swap UX choice is a separable design question.

### Path 2 — Accept and document the limitation

Claude Code has `Ctrl+O` ("expand" collapsed tool output). Kookr could additionally surface the per-task transcript log as a scrollable text view — we already have `~/.kookr/hooks/*.jsonl` and the transcript JSONL. Reading those gives the user scroll-through-history without any terminal-emulator work.

Engineering scope: zero for the limitation itself; some UX work if you want a polished transcript-reader panel.

### Path 3 — Upstream change in Claude Code (out of our scope)

Ink has a concept of "static" output (lines that go to scrollback) vs "dynamic" output (repainted viewport). If Claude Code rendered the conversation history as Static and only the active-prompt/progress UI as Dynamic, xterm.js scrollback would fill naturally with the full conversation. This is an Anthropic-side decision. Not actionable from Kookr.

## Recommended near-term action

- **Keep v7 as deployed.** The architecture wins hold. The cycling bug is dead. Byte-transparency is a real improvement even when Ink rendering obscures its visible benefit for this specific case.
- **Add this report to the repo** as the canonical explanation so the next RFC-writer doesn't spend three rounds re-deriving the problem. Link to deepresearch report 4 for the options evaluation.
- **Defer Path 1** — the engineering is bounded but not trivial, and Claude Code's built-in `Ctrl+O` is a usable stopgap.
- **Document Path 2 for users**: a short note in Kookr's README or settings panel saying "wheel-scrolling through Claude Code's conversation is not currently supported due to how Claude Code renders its UI; use `Ctrl+O` to expand collapsed output, or see the transcript log at `~/.kookr/hooks/...`"

## What this report does NOT claim

- It does not claim dtach was the wrong choice. v7's byte-transparency, cycling-bug fix, and forward-compatibility with future agent terminal features (kitty graphics, mouse when agents adopt it) are real wins regardless of the scroll outcome.
- It does not claim tmux would have been better. tmux had the same limitation for the same reason, plus the alt-buffer problem we shipped v7 to escape.
- It does not claim xterm.js is the wrong frontend. Deepresearch report 4 makes clear there is no production-proven Rust alternative for browser rendering today.

## References

- `docs/spikes/empirical-validation-v6.md` (POC evidence)
- `docs/adr/014-local-dtach-backend.md`
- `~/git/deepresearch/deepresearch_report2.md` — VS Code / JupyterLab / Hyper / Theia xterm.js usage patterns
- `~/git/deepresearch/deepresearch_report4.md` — Rust terminal cores for web embedding (main source for Path 1)
- xterm.js source: `node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/lib/xterm.mjs` — `scrollOnEraseInDisplay` semantics verified
- Empirical captures and screenshots: `/tmp/claude-dtach-capture.log`, `/tmp/dtach-scroll-{0,1,2}-*.png`
