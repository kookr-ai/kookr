# POC: mouse-forwarding through terminal backends

## What this proves

Empirically verifies (or refutes) the load-bearing claim in
`rfc-claude-code-terminal-parity.md`:

> Removing tmux (the parser that caused the current mouse regression)
> lets xterm.js's native mouse reporting work end-to-end. No custom
> forwarder needed.

Four backends are tested:

| Backend    | Architecture                                      | Expected for wheel |
|------------|---------------------------------------------------|--------------------|
| baseline   | `node-pty` → test-app directly                    | **arrives**        |
| tmux-on    | `tmux new-session` + `mouse on`  (pre-PR #320)    | **does NOT arrive** (tmux copy-mode) |
| tmux-off   | `tmux new-session` + `mouse off` (today)          | **open question**  |
| dtach      | `dtach -n -r winch`                               | **arrives**        |

Ground truth: the test-app parses CSI SGR mouse sequences from its PTY
stdin and appends one line per event to a log file. The Playwright test
reads that log and counts events.

## Running

```bash
# Install dtach (one-time, requires sudo)
sudo apt-get install -y dtach

# Run all 4 backends
pnpm exec playwright test -c docs/spikes/mouse-forwarding-poc/playwright.config.ts

# Run one backend (debugging)
pnpm exec playwright test -c docs/spikes/mouse-forwarding-poc/playwright.config.ts -g baseline
```

Each test attaches the test-app log as an artifact — open
`docs/spikes/mouse-forwarding-poc/playwright-report/index.html` to see
the raw byte-level evidence for any case.

## Files

- `test-app.py` — stand-in TUI that enables DECSET 1000/1002/1006 and
  logs parsed mouse events.
- `harness.ts` — minimal HTTP + WebSocket server that spawns the test-app
  under a chosen backend and bridges a browser xterm.js session to it.
- `page.html` — minimal xterm.js page.
- `mouse-forwarding.spec.ts` — Playwright tests dispatching
  `page.mouse.wheel()` against each backend.

## What this does NOT prove

- That Claude Code (the real binary) uses DECSET 1006 specifically. The
  test-app enables 1000+1002+1006; xterm.js should emit SGR 1006 and the
  test-app decodes that. Claude Code's actual mode selection is verified
  separately in the RFC's preliminary check by running Claude Code in a
  native terminal.
- That the Kookr production code paths (auth, reconciliation, hooks)
  survive the backend swap. This POC is a targeted architectural check.
