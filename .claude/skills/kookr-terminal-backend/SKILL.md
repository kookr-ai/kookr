---
name: kookr-terminal-backend
description: Maintain Kookr's dtach terminal backend, browser streaming, terminal-host isolation, and session recovery. Use for session I/O or terminal responsiveness work in the Kookr source checkout.
---

# Kookr terminal backend

Coding agents survive a Kookr restart because dtach owns their processes. Kookr
owns an attach client, not the lifetime of the shell. Terminal transport failure
must remain distinct from evidence that an agent exited.

## Find the owner before editing

- `src/adapters/terminal-backend.ts` is the current contract. There is no tmux
  rollback backend or returned `SessionHandle`. Lifecycle, byte writes, capture,
  resize, stream subscriptions, and diagnostics use one `TerminalBackend`.
- `LocalDtachBackend` owns the manifest, rings, and one persistent attach per
  session. `local-dtach-stream.ts` owns the byte path; recovery is in
  `local-dtach-recovery.ts`.
- `src/server/start.ts` selects the default in-process backend. The experimental
  `KOOKR_TERMINAL_HOST=true` path instead constructs `TerminalHostBackend`; its
  child owns the real backend, input coordinator, terminal sockets, asynchronous
  ring persistence, and reconstruction worker. Never construct both real owners
  for the same instance directory.
- `TerminalInputCoordinator` serializes input and tracks prompt ownership.
  Preserve its epoch and cleanup fences for HTTP, WebSocket, and adapter input.
  No transport retry may silently replay an input whose delivery is uncertain.

The legacy names `tmuxName` and `session.tmuxSession` identify dtach sessions.
Renaming the persisted field requires a schema migration; it is not a switch of
terminal technology.

## Browser streaming invariants

`session-bridge.ts`, `terminal-protocol-connection.ts`, and
`terminal-output-queue.ts` serve the terminal socket. The fake bridge is for
functional tests, not native transport measurements.

- Protocol v2 is explicitly negotiated. Browser credit acknowledges bytes only
  after xterm parses them; socket receipt is not consumption. Keep the legacy
  protocol until migration usage has actually been measured.
- Source epochs and absolute positions belong to backend output, independently
  of ring indices. Append before publishing, and return owned atomic capture
  snapshots. A relay stream gap invalidates its cursor immediately, even if no
  later output arrives.
- `terminal-writer.ts` is the sole browser write/reset owner. It chunks writes
  and shares a fair scheduler between panes. Old asynchronous parser callbacks
  must drain before a new session resets the same emulator.
- Exact resume needs the same retained parser, source epoch, byte range, and
  geometry. Initial and explicitly requested new views may remain interactive
  with an approximation warning, but truncated or reconstructed bytes cannot
  certify an exact-resume cursor. Persisted rings restart their offsets at zero
  without proving that the original prefix survived; carry origin completeness
  separately. Show unavailable recovery explicitly; do not inject Ctrl+L or
  secretly resize an agent to manufacture a redraw.
- Keep scrolling local to xterm. Preserve fractional wheel movement, selection,
  and the viewed history until eviction makes preservation impossible. Hidden
  panes must not schedule input, fit work, or stale scroll callbacks.

## Isolated host failure and authentication

The main HTTP upgrade handler checks origin, authentication, canonical session
identity, and viewer scope before transferring a paused socket. The child opens
no network listener. Read-only viewers need a renewable, expiring authorization
lease; loss of the main process must not leave an authorized socket open forever.

Every IPC request and socket handoff is generation-fenced and bounded. Control
traffic has reserved queue capacity. Main-process diagnostics are cached and
become unavailable when stale; they must not invent a live prompt epoch.

Before restarting a host, confirm the old child exited and its attach clients
released the instance. Never kill an unverified process to force that proof.
An unavailable host must not make reconciliation or Ralph startup declare live
agents dead. Restore parent-owned session membership into each new child before
later readiness marks, using fresh epochs. Test registrations and cleanup during
an outage as well as interrupted input and surviving dtach masters. Saturate
ordinary RPCs while asserting readiness admission at both ends; a shared count
cap alone does not reserve capacity. Catch fire-and-forget hook-update failures.
A rejected WebSocket handshake may close its raw socket without throwing or
calling the upgrade callback; release its reservation from that closure too.

## Persistence and reaping

Default sockets live under `/tmp/kookr-dtach/<uid>/<instanceId>/`; production and
development use different instance IDs. `DtachManifestStore` owns atomic
manifest updates. Instance directories can disappear under a temp sweeper, so
write paths recreate them immediately before writing.

Async ring persistence retains at most one active and one latest pending
snapshot per session, with a fleet budget. Deletion retires pending writes before
unlinking a ring. Never use synchronous fallback while an async write or removal
owns the same file: an older rename can land last. Leave the source ring dirty
for retry. Shutdown freezes producers, drains older writes, then performs and
drains the final flush. All concurrent close callers share its completion.

`reconciliation.ts` computes live/orphan state. `SessionReaperService` separately
applies age and ownership policy via `killSession`; it must not race a pending
launch or cross instance boundaries. The startup attach sweep is not permission
to kill agents or another server's attach clients.

## Verify the path being claimed

Use focused Vitest suites for byte order, source continuity, parser transitions,
bounded queues, input epochs, leases, and host failure. Real xterm tests cover
UTF-8, control sequences, modes, cursor state, and viewport retention.

For rendering measurements, run `scripts/terminal-perf/run.ts` in a headed
browser on the native dtach backend. `--mixed` includes the real dashboard,
hooks, transcript ingestion, and captures; `--isolated` exercises the child.
Record active producers separately from stored tasks and delivered browser rows.
A fast terminal-only probe does not prove the dashboard stays responsive.
`--profile` adds CPU profiling and disables minification: use it to diagnose,
not as the timed release comparison.

Inspect the emitted screenshot and JSON report. Marker timing starts outside
the server and ends after xterm's render event plus a browser frame opportunity;
it is not GPU presentation timing or input echo latency. Report missing markers,
the actual renderer, and incomplete platform/agent-fixture coverage.

On WSL, native process tests can mistake orphan zombies for live processes if
PID 1 does not reap them. Run those tests under a test-only subreaper when needed;
do not alter production liveness rules to hide the test-environment artifact.
Avoid running the full test suite alongside performance measurements.

Read `docs/reports/terminal-responsiveness-validation.md` for the measured scope
and remaining qualification limits, and
`docs/rfc/rfc-terminal-responsiveness.md` for the approved protocol and budgets.
