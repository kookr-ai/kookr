# Shared evidence pack — RFC terminal attach latency

**Assembled:** 2026-08-03  
**Treat as claims to verify, not settled fact.**

## Pipeline map

1. **Selection:** Zustand `selectAgent` → `DetailPanel` passes `tmuxName={agent.agentId}` to `TerminalPanel`.
2. **Client attach:** `TerminalPanel` effect on `[tmuxName, visible]` → `createReconnectingSocket` → `ws://…/ws/terminal/:session`.
3. **Server upgrade:** `start-http-and-websockets.ts` → scope gate → `SessionBridge`.
4. **SessionBridge.start:** subscribe `onData` → wait initial resize → `backend.captureBytes` → absolute-TUI reconstruct **or** full ring send → live fan-out.
5. **Backend:** `LocalDtachBackend` + `LocalDtachStream` — persistent attach, 1 MiB ring (`RING_BUFFER_BYTES`), `currentSize`, optional `captureCurrentFrame` / `reconnectTransport`.
6. **Absolute-TUI:** `isAbsolutePositionTuiRing` → `reconstructAbsoluteTuiScreen` (async, budgeted) → else `extractLastSubstantialAbsoluteFrame` → else secondary dtach + Ctrl+L (slow).
7. **PR #1927:** seed cache, 50 ms wait, no-blank client, telemetry — **merged 2026-08-03** (`06430142` on `main`). Client report is blended first-paint only (not stratified).

## Measurements (local, 2026-08-03)

- Full rings under `/tmp/kookr-dtach/1000/port-4800/rings/`: several at 1 048 576 B.
- reconstruct 1 MiB: ~18–30 ms; detect absolute: ~0.5–3.5 ms.
- Pre-#1927 resize wait default: 400 ms (`DEFAULT_INITIAL_RESIZE_WAIT_MS`).
- Recovery: `captureCurrentFrame` timeout ≥800 ms; Ctrl+L sleep ≥450 ms in `refreshAbsoluteTuiFrame`.
- xterm vendor chunk ~380 KB lazy via `DetailPanel` `React.lazy(TerminalPanel)`.

## Source pointers

| Claim | Location |
|-------|----------|
| Bridge start / resize wait | `src/server/session-bridge.ts` (`DEFAULT_INITIAL_RESIZE_WAIT_MS`, `start`) |
| Ring size | `src/adapters/dtach-ring-store.ts` `RING_BUFFER_BYTES` |
| Reconstruct | `src/server/absolute-position-tui-screen.ts` |
| Absolute detect | `src/server/absolute-position-tui-ring.ts` |
| Client WS + clear/reset | `src/frontend/components/TerminalPanel.tsx` |
| WS route | `src/server/bootstrap/start-http-and-websockets.ts` |
| ADR terminal GUI | `docs/adr/009-interactive-terminal-in-gui.md` |
| ADR dtach | `docs/adr/014-local-dtach-backend.md` |
| Hot-path sampler | `src/core/hot-path-sampler.ts` |
| PR #1927 | https://github.com/kookr-ai/kookr/pull/1927 |

## Product constraints from ADRs

- ADR-009: browser xterm + WS; sessions survive Kookr restart via multiplexer/backend.
- ADR-014: dtach persistence; ring + attach model.
- Remote share / read-only viewers: terminal scope gate, no input on viewer bridges.
