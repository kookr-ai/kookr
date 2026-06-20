# ADR 014 — Local dtach Backend

**Status:** Accepted
**Date:** 2026-04-21 (default flipped 2026-04-22, Main B.b; escape hatch removed V8)
**Supersedes (persistence layer only):** ADR 007 (managed tmux sessions) and ADR 008 (tmux session management and persistence). The interactive-mode rationale in ADR 007 still holds; this ADR replaces tmux with dtach as the terminal persistence layer. ADR 008's tasks.json-inline session-metadata + startup-reconciliation design is preserved against dtach.

> Post-V8 note (2026-04-24): the `KOOKR_BACKEND=tmux` escape hatch described in this ADR has been removed. `src/server/start.ts` hard-rejects any value other than `dtach`. Only the Main A staging text below reflects the historical rollout — current behavior is dtach-only.
>
> Post-implementation note (2026-06-20): the accepted dtach decision still holds, but several implementation details below are historical. The current `TerminalBackend` surface includes lifecycle, capture, write/writeSequence, resize, stats, backend-error events, and close methods. The byte replay buffer is now backend-owned in `LocalDtachBackend` via `DtachRingStore`, and its default size is 1 MB rather than the 64 KB `SessionBridge` buffer described during rollout.

## Context

Kookr's terminal data path today is `browser xterm.js ⇄ WebSocket ⇄ Kookr bridge ⇄ node-pty ⇄ tmux attach ⇄ tmux master ⇄ child PTY ⇄ agent`. tmux provides session persistence — agents survive `pnpm prod:update`. It also provides several things we do not want:

- **Alt-buffer semantics on attach.** Empirically measured in [docs/spikes/empirical-validation-v6.md](../spikes/empirical-validation-v6.md): `tmux attach` always emits `\e[?1049h` at the start of its output, regardless of the per-session `alternate-screen off` option. That option only gates programs running inside tmux; tmux's own client rendering always switches the attached terminal to alt-buffer. Consequence: xterm.js's normal-buffer scrollback stays empty, wheel-up scrolls nothing.

- **Mouse policy that fits no use case.** `mouse on` hijacks wheel into tmux copy-mode (janky trackpad scroll, broken plain-drag selection). `mouse off` gives the alt-buffer no wheel response at all. Neither is what users want.

- **Forced-style conversions.** `aggressive-resize`, copy-mode status bar, pane-border rendering — features for an interactive multiplexer, noise for an embedded single-pane terminal panel.

- **No byte transparency.** tmux parses every byte into its grid before re-emitting to the client, so high-bit inputs (non-ASCII paste, future mouse CSI) pass through a parser that could corrupt them.

The spike (docs/spikes/empirical-validation-v6.md) also falsified the motivating premise of the earlier v4-v6 RFC drafts — neither Claude Code nor Codex CLI emit `DECSET 1000/1002/1006` mouse-reporting modes. The dtach migration remains valid, but its rationale is "xterm.js scrollback needs a non-alt-buffer byte path", not "forward mouse events to the agent".

## Decision

Replace tmux with **dtach** as the persistence layer. Architecture:

```
browser xterm.js ⇄ binary WebSocket ⇄ Kookr SessionBridge ⇄ node-pty ⇄ dtach -a ⇄ Unix socket ⇄ dtach -n master ⇄ child PTY ⇄ agent
```

- dtach's wire contract is byte-transparent: it does not parse, does not rewrite modes, does not render a status bar. It just pipes bytes between an attach client and a persistent master.
- The attach client is `spawn('dtach', ['-a', sock, '-E'])` via node-pty — the same exec-based pattern the existing `tmux attach` path uses, with identical lifecycle semantics.
- Sessions survive Kookr restart (dtach master is detached from Kookr via `setsid`); sockets live under `/tmp/kookr-dtach/<uid>/<instanceId>/`.

## Alternatives considered

- **Implement the dtach wire protocol in TypeScript (vendored client).** Proposed in v7 RFC §LocalDtachBackend. Rejected during implementation: the POC ran `spawn('dtach', ['-a', sock, '-E'])` through node-pty end-to-end successfully (8/8 wheel ticks + byte-exact round-trip to child PTY). Implementing ~300 LoC of wire protocol in TypeScript adds a correctness risk (byte-exact round-trip against a moving target) with no measurable gain over the exec path. If one-extra-process-per-attach ever becomes a perf concern, the `TerminalBackend` interface accepts a swap.
- **abduco instead of dtach.** Compatible wire protocol, more recently maintained. dtach is smaller (~500 LoC C, 77 KB binary) and has a simpler protocol. abduco is the documented fallback if dtach development dies.
- **Stay on tmux + disable alt-buffer.** Impossible — the per-session `alternate-screen` option does not control tmux's own client rendering (verified empirically). Would require patching tmux upstream.
- **Run node-pty directly with no persistence layer.** Simplest (spike C "baseline" validated this works). Rejected because `pnpm prod:update` would kill every live agent including mid-OAuth flows.
- **`@xterm/headless` + `addon-serialize` replay buffer.** Heavier (~3 MB RSS per session) and introduces a stateful server-side parser that can be poisoned. The implemented byte-stream ring buffer now lives in `LocalDtachBackend` and is 1 MB; the original ADR text proposed a smaller 64 KB `SessionBridge` buffer.
- **Rust-based terminal library (alacritty_terminal / wezterm-term / par-term-emu-core-rust).** Documented in [deepresearch report 1]. Perf advantages in parsing throughput; no near-term need. Kept as future replaceable-impl if JS throughput ever caps us.

## Consequences

**Positive:**
- xterm.js's normal-buffer scrollback accumulates Claude/Codex inline output; wheel scrolls actual terminal text.
- Byte-transparent path means any future agent terminal-protocol feature (kitty graphics, sixel, OSC 52 clipboard, mouse when agents adopt it) works automatically with no Kookr code change.
- Smaller surface than tmux — `TerminalBackend` centralizes lifecycle, I/O, capture, resize, stats, and backend-error events without tmux's session-option quirks.
- Rollback is a committed script (`scripts/rollback-dtach.sh`) that does TERM → wait → KILL → verify on every manifest'd pid plus a `pkill -f` fallback.

**Negative:**
- No in-session pane splits or multi-window (tmux features Kookr never exposed in the UI; confirmed not a regression).
- No external `tmux attach` as an escape hatch — replaced by `dtach -a <sock>` from a user's terminal, which works by design (dtach supports multi-client attach).
- `dtach` not uniformly packaged on mainstream distros (spike C2). Mitigated by `scripts/build-dtach.sh` that clones + compiles upstream source in ~2s.
- Pre-alt-screen output (e.g., OAuth URLs printed before a TUI enters alt-screen) is not replayed by `dtach -r winch` (spike C6). `LocalDtachBackend`'s 1 MB ring buffer covers this in current code.

**Neutral:**
- Linux UDS socket path limit is 107 bytes usable (spike C10, corrected from v6 RFC's 108). Session IDs are capped at 40 chars; socket path at `/tmp/kookr-dtach/<uid>/<instance>/<40c>.sock` fits comfortably.
- macOS has a stricter 104-byte limit. Not exercised yet; `LocalDtachBackend` validates session ID length at `createSession`. Explicit macOS verification is an open item for Main B.

## Implementation phases

- **Main A (this PR):** Introduce `TerminalBackend` interface + `LocalDtachBackend` + `scripts/build-dtach.sh` + `scripts/rollback-dtach.sh` + this ADR. Backend is inert — not wired into the server's spawn path. A follow-up PR wires the feature flag `KOOKR_BACKEND=dtach` for manual verification.
- **Main B (follow-up):** Flip the default. Replace `TmuxTerminalManager` spawn path with `LocalDtachBackend`. Wire `SessionBridge` with ring buffer + binary WS. Run one-time cutover dialog. Delete tmux code.

## References

- [Empirical validation spike](../spikes/empirical-validation-v6.md) — evidence base
- [Mouse-forwarding POC](../spikes/mouse-forwarding-poc/) — end-to-end harness that validated the exec-based attach pattern
