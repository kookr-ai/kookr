# Terminal responsiveness: implementation and validation

The terminal now limits how much output can wait for parsing, preserves small
trackpad movements, and avoids rerendering an unchanged terminal for unrelated
dashboard updates. An optional child process also separates terminal transport
from supervision. These changes improve the measured terminal path, but the
full dashboard still misses the approved frame and output-latency targets.

Implementation follows the [approved RFC](../rfc/rfc-terminal-responsiveness.md).
Functional requirements FR-TERM-001, 002, 003 and 005 are implemented.
FR-TERM-004 is partial: source continuity works for a verified retained parser,
but a retiring in-flight parse conservatively invalidates its saved cursor.
NFR-TERM-001 remains **partial**, not qualified. Isolation is experimental and
off by default; no production deployment is part of this validation.

## What changed

- Wheel scrolling keeps fractional movement and shares one animation-frame
  update. Switching or hiding a terminal cancels pending movement. Selection and
  scrollback eviction are handled explicitly.
- One browser writer orders seed, history, live bytes, and reset operations.
  It submits eight-KiB chunks with one outstanding parse per terminal. A shared
  scheduler gives other panes a turn. Old parser callbacks cannot acknowledge
  bytes or unlock input for a new session.
- Protocol v2 is explicitly negotiated. Each viewer has 128 KiB of unacknowledged
  output credit, returned after parsing. Output ownership is capped at two MiB
  per viewer and thirty-two MiB fleet-wide. A lagging viewer is disconnected
  rather than silently dropping bytes or accumulating unlimited work.
- Backend source epochs and positions allow exact retained-range resume when
  the browser still owns the matching parser and geometry. Otherwise the UI
  discloses unavailable continuity and offers a new view. Reconstructed screens
  remain approximate; an unavailable reconstruction cannot accept input.
- Terminal fit work is frame-coalesced and skips unchanged sizes. The detail
  pane subscribes to relevant state only, and its terminal has a memoized
  boundary with stable callbacks. The dashboard state protocol is unchanged.
- Attach telemetry distinguishes first byte, completed parse, and the next
  browser frame opportunity. New samples are versioned separately from legacy
  enqueue-based timing. Renderer fallback is recorded.

## Optional terminal host

Set `KOOKR_TERMINAL_HOST=true` before starting a development server to exercise
isolation. Leaving it unset selects the in-process backend. Do not enable it in
production merely because the functional tests pass.

The main server authenticates and authorizes terminal upgrades before passing a
paused socket to one child. The child owns the real dtach backend, input
coordinator, terminal WebSockets, and asynchronous ring persistence. It opens no
listener. A bounded worker reconstructs display-only screens.

RPCs (requests between the main process and child) have generation IDs, deadlines,
byte limits, and count limits. Unsent bulk captures yield to input and lifecycle
control. The parent and child reserve sixty-four of 128 requests and two MiB
of the sixteen-MiB request budget for readiness. Socket transfers cannot consume
the IPC queue's reserved control capacity.
Truncated rings and viewport suffixes are display-only previews: they carry no
resumable cursor and cannot accept input. Full replay from a known origin, or
continuation in an already verified retained parser, is required for input.
Parser replacement preserves keyboard focus only if the old terminal owned it.
Input queues retain owned byte copies and reject excess work. Retiring a session
or coordinator cancels queued and delayed input, without retrying uncertain writes.

Output allocations remain charged until both browser acknowledgement and local
socket-send completion. Queued control frames have separate count and envelope-size bounds. Once
submitted to the socket, their bytes share the ownership budget until send
completion. Eviction pressure includes acknowledged bytes still held by the socket. Closing
a backlogged socket terminates its transport so queued data is not retained
through a close-handshake timeout.

Viewer leases expire in the child even if the main process stops responding.
Revocation is considered complete only after closure acknowledgement or confirmed
child exit. A replacement host cannot start until its predecessor and attach
clients have exited. An unverifiable attach owner leaves the host unavailable;
it does not authorize killing an unknown process. Dtached agent masters survive. The parent retains session membership and restores
it into each replacement child before later readiness marks for those sessions.
Restoration creates new epochs; old prompt observations remain invalid. A session
registered during an outage is restored, while a cleaned-up session is excluded.
Readiness failures are contained at hook ingestion so an outage cannot produce
an unhandled promise rejection there. Failed handshakes release the parent's
reservation on raw socket closure, even when WebSocket setup never completes.

Async persistence never performs a synchronous fallback while another write or
removal owns the same file. It keeps that ring dirty for a later flush. Shutdown
stops attach producers before draining older snapshots, then saves the final
rings; concurrent drain callers share that completion.

Synchronous diagnostics use age-bounded caches. An unreachable host must not be
mistaken for a dead coding agent or a verified input prompt. Ralph startup now
preserves an unverified loop during a host outage, without claiming prompt ownership.
Launch deduplication likewise preserves the original task when a
terminal-host-unavailable error prevents a liveness check. Other probe failures
retain the existing stale-record handling.

If a connection carrying input disconnects unexpectedly, the browser displays
an input-delivery warning until dismissed. Output reconnection does not clear
that warning or replay input. The protocol has no agent-delivery receipt, so this
warning is conservative: it can appear even when the agent received the input.

`GET /api/health` exposes the host's sampled queue sizes, connection counts,
restart count, memory use, and snapshot age under `terminalBackend.terminalHost`.
Stale gauges are not proof that an unavailable transport has recovered.

## Measurement method

Measurements were run on 10 September 2026 on Linux/WSL2, an AMD Ryzen 9 3900XT with twenty-four
logical CPUs, and a GeForce RTX 3090 through ANGLE/D3D12. The headed browser was
Chrome 151.0.7922.34 with xterm's WebGL renderer, at a 1280-by-720 viewport.
These are workstation observations, not portable performance guarantees.

The unpaid fixture runs real native dtach/PTY producers. A separate harness
process timestamps emission commands, then receives marker acknowledgements
after xterm's render event and one browser animation-frame opportunity. This
does not measure GPU presentation or keyboard-to-agent echo. Markers that scroll
past before being observed are counted as missing, not silently excluded.
Reported latency percentiles describe the observed markers only.

The steady workload requests 20,480 bytes per second per producer, using complete
Unicode/CRLF lines. The fixture SHA-256 is
`12dd1c2d2e2d5b8a006888a9a0c5f7ff069922287c291930890b07d8f16a0b3a`.
Actual emitted bytes and missed emission commands are recorded separately.

`--mixed` loads the real dashboard, injects twenty structured hook events per
second fleet-wide, appends real transcript JSONL, and captures up to 64 KiB from
each session once per second. It retains 332 tasks: twenty active and 312 completed.
The normal server projection delivers **120 browser rows**, not 332: twenty active
and one hundred completed. The 30-second mixed runs delivered about seventeen MB
of dashboard messages, with individual messages up to about 177 KB. Completed
history is not artificially expanded to inflate the rendered workload.

### Short observations

| Workload | Mode | Markers observed/emitted | Render-ACK p95 | Frame interval p95 |
| --- | --- | ---: | ---: | ---: |
| 20 producers, 1 terminal, 30 s | Prior terminal-only baseline | 60/60 | 41.4 ms | 16.8 ms |
| 20 producers, 1 terminal, 30 s | Optimized, in process | 60/60 | 35.4 ms | 16.8 ms |
| 20 producers, 4 terminals, 30 s | Optimized, in process | 240/240 | 37.8 ms | 16.8 ms |
| 20 producers, mixed dashboard, 30 s | Baseline, in process | 57/60 | 177.9 ms | 66.7 ms |
| 20 producers, mixed dashboard, 30 s | Optimized, isolated host | 55/60 | 129.6 ms | 50.1 ms |

The mixed comparison used the same workload, but the baseline checkout had moved
to `ad45956456a481c17d78367f1489826f0a2e9984`; implementation was based on
`a9cdc3c3e52d0de11a56a42c35c85d5026849acb`. No frontend changes separate those
two baseline commits, but intervening server health/maintenance changes mean
this is not an exact-parent controlled comparison. The original terminal-only
comparison predates that checkout movement.

The mixed result is **not a qualification pass**: the targets are a frame p95 of
twenty milliseconds and marker p95 below one hundred milliseconds, with missing
markers counted. A fifteen-second diagnostic CPU profile identified repeated
WebGL resize work and Activity-panel layout among the remaining costs. That run
disabled minification for readable function names and is not a timed release
comparison. It does not justify claiming that terminal parsing alone caused the
whole browser to freeze.

### Ten-minute soak and overload

The isolated-host mixed run completed ten minutes of steady output, two minutes
with one noisy producer and one non-acknowledging viewer, and ten seconds of
steady recovery. It emitted 429,644,528 bytes with no missed emission commands.
All twenty native sessions remained attached across the sampled run. There were
no backend errors, host restarts, browser exceptions, or final recovery notices.

The slow viewer closed with the lag code `4408` after 1,853 ms. The final sample
had zero RPC, channel, output, reconstruction, relay-stream, and persistence
queue bytes. One-second samples observed peaks of about 2.3 MiB in the IPC
channel, 1.3 MiB in output ownership, and 20.0 MiB in pending persistence.
Sampled peaks are lower bounds on instantaneous peaks; unit tests enforce the
hard budgets. Sampled maximum resident memory was 208 MiB for the child and
422 MiB for the main server. This is not a browser-memory measurement.

The browser observed **1,427 of 1,453 markers**. Among those observed, median
render acknowledgement was 37.5 ms, p95 was 117.6 ms, and maximum was 657.3 ms.
Frame-interval p95 was 33.4 ms. There were 127 browser long tasks, the longest
243 ms. Thus the run demonstrates bounded transport and recovery under this
load, **not** the approved twenty-millisecond frame / sub-100-ms marker target.

The real dashboard received 14,669 messages totaling 708,831,421 bytes, with a
233,982-byte maximum message. Its largest retained activity window reached 718
events. The server injected 14,363 hooks and completed 14,760 captures, including
startup and settling time. This competing dashboard work remains material.

### Local regression gates

At implementation commit `d141ddd0`, `pnpm test` passed all 1,095 test files: 17,815 tests passed, three were expected
failures, and eighteen were skipped (17,836 total). The final run took 374.21
seconds. On this WSL host it ran under a test-only Linux subreaper so orphaned
native-test processes were reaped; production process-liveness rules were not
changed to compensate for the test environment. The run log remains at
`/tmp/kookr-terminal-full-tests-verified.log`.

- `pnpm build:server`, `pnpm build:relay`, `pnpm check:e2e`, and
  `pnpm build:frontend` passed. A separate smoke test loaded the compiled
  JavaScript host, captured output from a real native PTY, and reconstructed a
  screen using the compiled worker.
- `pnpm exec playwright test e2e/terminal-empty-enter.spec.ts
  e2e/terminal-focus-indicator.spec.ts e2e/terminal-submit-regression.spec.ts
  e2e/terminal-viewport-budget.spec.ts --workers=2` passed all fourteen tests,
  including desktop, focus-mode, and mobile terminal geometry. The test used
  the installed matching Codex CLI/host pair; no CLI rebuild was needed.
- `pnpm check:cycles` found zero cycles across 1,079 files and 2,325 load-time
  edges. `node --import tsx scripts/check-remote-import-boundaries.ts` passed
  across 912 files.
- Requirements, skill placement, skill validation, documented commands,
  documented environment variables, and documented API routes passed. Skill
  validation still prints unrelated pre-existing cross-tier reference warnings.

A separate strict TypeScript check of the terminal and detail components and
their transitive frontend imports is **not green**. It reports twenty existing
errors, compared with twenty-seven on the baseline. Comparing diagnostics with
file positions normalized found no new errors and seven resolved terminal
errors. The successful frontend build transpiles code; it is not evidence of a
clean whole-frontend typecheck. These counts and the performance observations
above precede the delivery merge from current main and the review corrections;
the PR test plan records the final-head verification separately.

Delivery review added regressions for premature acknowledgements, delayed socket
completion, host-unavailable duplicate launches, interrupted input, split control
sequences in real xterm, and the actual memoized terminal boundary. A real loopback
slow-reader reproduction retained over sixteen MiB before the ownership fix;
afterward it closed at roughly two MiB and released all queued transport bytes.

The explicit frontend check was:

```bash
pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module ESNext --moduleResolution bundler --jsx react-jsx --esModuleInterop --skipLibCheck --strict --types vite/client src/frontend/components/TerminalPanel.tsx src/frontend/components/DetailPanel.tsx
```

## Reproduce and inspect

From an installed checkout with the native dtach binary and Playwright Chromium
available, run:

```bash
node --import tsx scripts/terminal-perf/run.ts --agents=20 --seconds=30
node --import tsx scripts/terminal-perf/run.ts --agents=20 --panes=4 --seconds=30
node --import tsx scripts/terminal-perf/run.ts --agents=20 --seconds=30 --scroll
node --import tsx scripts/terminal-perf/run.ts --agents=20 --seconds=600 --mixed --isolated --retained=332 --overload-seconds=120
```

Use `--source-root=<baseline-checkout>` without `--isolated` for a baseline.
The harness reads that checkout; build outputs, native sessions, hooks, and task
data stay in a fresh temporary directory. It removes provider credentials from
its child environment and does not call coding-agent models. The overload adds
one one-MiB/s producer and a viewer that withholds parsed-byte credit, followed
by ten seconds of steady recovery.

The command reports an artifact directory containing `report.json`, `server.log`,
and `terminal.png`. Open both the JSON and screenshot; a successful command alone
does not prove correct rendering. `--profile` additionally writes a standard
`browser.cpuprofile` for browser developer tools. Do not run the full test suite
alongside a performance measurement.

The long-soak artifacts from this workstation remain at
`/tmp/kookr-terminal-perf-BaR5fd/`. The screenshot was opened and checked for the
selected terminal's output and final marker; it is not merely a successful file
write. Inspect the retained screenshot with an image viewer and verify its
dimensions with:

```bash
file /tmp/kookr-terminal-perf-BaR5fd/terminal.png
```

The checked image is a 1280-by-720 PNG. These temporary local artifacts are not
part of the repository and may be removed by the operating system's cleanup.

## Remaining qualification limits

- The full mixed-dashboard performance target is not met. The current evidence
  supports the terminal improvements, not an unconditional twenty-agent SLO.
- Native isolation faults were exercised on Linux/WSL2, not macOS. Socket
  transfer, parent death, and attach-owner recovery still need macOS qualification.
- The performance fixture is synthetic VT output. Unit tests cover UTF-8,
  control-sequence chunking, cursor state, modes, and scrollback, but this is not
  a sanitized real-terminal replay qualification for Claude, Codex, and Grok.
- Marker timing is not keyboard echo timing. No empty RTT distribution is used
  as evidence of input responsiveness.
- Legacy protocol support remains. No seven-day migration sample has been
  collected, and the host's instantaneous legacy-connection count is not a
  complete fleet migration report.
- A retained parser whose geometry changed or whose source history expired
  requires an explicit new view. This safety tradeoff can interrupt convenience;
  it must not be described as seamless universal recovery.
- A disconnect during an in-flight parse also requires a new view, even if the
  retired parse later completes. The RFC's retiring-chunk continuity promise is
  not implemented; FR-TERM-004 remains partial rather than claiming equivalence.
