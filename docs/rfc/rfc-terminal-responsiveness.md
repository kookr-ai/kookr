# RFC: Responsive terminal scrolling and streaming with twenty agents

**Status:** Approved v4 — user approved implementation on 2026-09-09
**Implementation:** Four stages implemented; performance qualification remains
partial. Terminal-host isolation is opt-in, not the production default. See the
[validation report](../reports/terminal-responsiveness-validation.md).
**Date:** 2026-09-09
**Author:** Jean Ibarz (with Codex)
**Source baseline:** `a9cdc3c3e52d0de11a56a42c35c85d5026849acb`

## Problem

The developer can have spare CPU and memory while the terminal still feels slow.
Small trackpad movements currently disappear, terminal output can accumulate
inside the browser without the server noticing, and terminal I/O shares the
server's event loop with supervision work. The goal is smooth scrolling and
promptly displayed output during a realistic workload of up to twenty agents.

The user approved the four-part direction: fix scrolling, add browser-aware
streaming control, reduce competing browser work, and isolate terminal I/O.
They clarified that rendering, scrolling, and streaming matter most, and that
twenty concurrently running agents is the realistic ceiling. This document
specifies that direction; it does not claim an achieved speedup. Repository
policy requires review of this detailed design before implementation.

## Requirements

1. Preserve small wheel deltas, direction, line/page units, terminal selection,
   and scrolling through retained normal-buffer history. Wheel events must not
   become arrow keys or mouse input to an agent.
2. Keep output ordered and byte-exact while connected within the retention
   budget. Splitting a UTF-8 character or terminal escape sequence across
   transport frames must not alter its interpretation.
3. Bound pending work at the browser and server independently. A slow viewer
   must not pause a shared PTY (pseudo-terminal), another viewer, or an agent.
4. Keep keyboard input and resize controls independent of output credit. Never
   automatically retry input whose delivery became ambiguous on disconnect.
5. Preserve dtach session survival across server restart, Linux/macOS support,
   read-only sharing, authorization, and the existing single-package deployment.
6. Scrolling up must remain stable while new output arrives. Do not force the
   user back to the bottom, except after an explicit Jump to latest action.
   If retained history is exhausted, show that limit rather than claiming that
   every historical line remains available.
7. Separate received, parsed, and rendered timing. Report missing measurements
   as missing, never as zero latency. Do not call an asynchronous write enqueue
   a completed paint.

### Workload and acceptance targets

These are initial qualification targets, not promises about arbitrary output
rates or every machine. Record hardware, browser version, actual renderer,
terminal dimensions, fixture hashes, byte rates, and competing load for each run.
Agent concurrency does not define dashboard size. Record stored task count,
delivered client rows/status mix, event-window size, and serialized snapshot/delta
bytes separately, using the production client projection rather than a raw/debug
snapshot or an arbitrarily enlarged browser array.

| Dimension | Qualification workload / target |
|---|---|
| Agent count | One, ten, and twenty concurrently producing sessions; twenty is the required ceiling, not fifty |
| Retained state | Compare twenty and approximately 283 stored tasks through the actual client snapshot projection, holding producer count and update cadence fixed; report resulting delivered rows rather than assuming 283 browser rows |
| Visible panes | One selected terminal as the primary case; four visible terminals and two viewers of one session as additional cases |
| Output shape | Sanitized real Claude/Codex/Grok output plus deterministic UTF-8, inline-log, and full-screen redraw fixtures |
| Steady/burst load | Sweep from recorded representative rate to twice that rate; separately test one producer exceeding the viewer's sustainable rate; state explicit bytes/second and burst sizes in the report |
| Competing work | Replay representative hook/transcript changes, dashboard updates, monitor captures, and dirty-ring persistence alongside terminal producers; a terminal-only run is not qualification |
| Scrolling | At 60 Hz, target frame-interval p95 at most 20 ms during continuous scrolling, and no terminal-attributable task exceeding 50 ms |
| Streaming | Target fixture-emission to browser-render acknowledgement p95 below 100 ms in the qualified local steady/burst workload; start before bytes wait for a node-pty callback |
| Safety | Byte-exact stream comparison, terminal-state equivalence, no duplicated/lost input, no unrelated viewer stall, and bounded queues |
| Long run | Ten-minute steady run plus a two-minute overload/recovery run; pending bytes must return to baseline after output stops |

The harness timestamps fixture emission and receipt of the browser's render
acknowledgement using its own monotonic clock. This includes return transport
and is a conservative end-to-end proxy, not a subtraction of different clocks.
Deterministic visible markers must be present in xterm's screen before the
matching render acknowledgement is emitted. Record silent/control-only writes
separately, and include synchronized-output sequences that delay rendering after
parsing. A scroll-only render event cannot satisfy an output marker.

Each emitted marker ends as observed, intentionally superseded, or timed out;
report every count and never silently remove missing markers from percentiles.
For redraws, use stable checkpoint markers between complete synchronized frames.
Intermediate overwritten states are reported as coalesced, not as latency samples.
Every final settled checkpoint must be observed within the bound; missing or
timed-out final checkpoints fail qualification even if observed-only p95 is good.

The browser's render event and a following animation-frame opportunity are
proxies for display, not proof that the GPU presented a pixel. Use a real headed
browser with its normal renderer for performance qualification. Automated DOM
renderer tests are correctness coverage, not evidence of the user's GPU speed.

## Non-goals

- Infinite throughput or infinite lossless terminal history on finite hardware.
- Starting twenty paid coding-agent jobs to create load. Replay fixtures through
  test sessions instead; do not inject benchmark input into production agents.
- Replacing xterm.js, dtach, or the agent CLIs; writing a new terminal emulator;
  adding a database, service package, cloud component, or runtime dependency.
- Turning off supervision, accessibility, or read-only authorization for speed.
- General dashboard synchronization redesign or a new performance dashboard.

## Shared evidence pack

This is evidence to check, not settled fact. Source pointers refer to the pinned
baseline above. Earlier production observations are explicitly time-bound.

### Pipeline and source pointers

| Responsibility | Source and evidence |
|---|---|
| Browser terminal | `src/frontend/components/TerminalPanel.tsx:604`: wheel uses `Math.round(deltaY / 40)` per event, ignores `deltaMode`, suppresses the event; line 618 directly fits on each ResizeObserver notification |
| Browser writes/timing | `TerminalPanel.tsx:948`: reset, count lines, call `terminal.write` without callback; line 976 records first paint immediately afterward |
| Parent rendering | `src/frontend/components/DetailPanel.tsx:392`: subscribes to the entire Zustand store; terminal component is not memoized |
| Renderer | `src/frontend/terminal-renderer.ts`: WebGL already attempted; DOM fallback forced for webdriver or HeadlessChrome, unavailable WebGL2, or context failure |
| Upgrade/security | `src/server/bootstrap/start-http-and-websockets.ts:404`: constructs SessionBridge on the main server loop after terminal scope checks |
| Live output | `src/server/session-bridge.ts:1390`: per-bridge queue; five-millisecond batch; socket-buffer soft limit one MiB; sends entire accumulated batch at line 1414 |
| Replay/history | `session-bridge.ts:1279` safeSend and request-history path around line 1059 send bytes outside the live queue; all must enter the new credit accounting |
| PTY draining | `src/adapters/local-dtach-stream.ts:365`: node-pty callback fans out and appends to the ring on the main server loop |
| Persistence | `local-dtach-stream.ts:541` flushes dirty rings; `src/adapters/dtach-ring-store.ts:298` uses synchronous write/rename; current atomic generation format must survive changes |
| Session survival | `docs/adr/014-local-dtach-backend.md`: dtach owns agent lifetime; node-pty owns a disposable attach client, not the agent |

Current live path:

```text
agent -> dtach master -> dtach attach/node-pty
                              |
                    main server event loop
                     ring + SessionBridge
                              |
                    dedicated binary WebSocket
                              |
                  browser queue -> xterm -> renderer
```

The dedicated terminal WebSocket and hidden-pane unsubscription already exist.
Merely enabling WebGL or adding another WebSocket is not a proposed improvement.

### Reproductions and measurements

- The exact deployed wheel-handler body, run with terminal/event stubs, turns
  eight five-pixel events into zero lines of movement. One forty-pixel event
  produces one line. One three-line-mode event also produces zero movement.
  This is a deterministic code reproduction, not a recording of the user's
  physical input events.
- At approximately 20:14 UTC on 2026-09-09, production health reported four
  attached sessions, host CPU about 49%, and server event-loop-delay p95 about
  540 ms. The configured fifty-millisecond initial resize wait had a measured
  maximum of about 540 ms in the contemporaneous five-minute attach sample.
  This establishes scheduling delay at that time, not its CPU-profile cause.
- The same sample reported no pending terminal writes and no terminal-input RTT
  samples. That is not a measurement of instant delivery. The existing RTT
  endpoint measures server enqueue to node-pty write return, not browser paint.
- Installed xterm WriteBuffer uses asynchronous writes and a twelve-millisecond
  processing slice, checked between chunks. A single oversized chunk can exceed
  that slice. Its hard pending-buffer limit is fifty million bytes; the new
  protocol must stay far below it, not rely on this last-resort behavior.
- An attempted automated browser profile failed with a closed tool transport.
  No FPS or GPU diagnosis was obtained. That browser advertised HeadlessChrome,
  so it was on Kookr's DOM fallback rather than the user's normal renderer.
- An earlier paired parser optimization reduced measured server terminal-text
  analysis work. It does not demonstrate that the remaining browser path meets
  these new targets; remeasure on the pinned deployed baseline.

### Reuse check and external contracts

The related OpenClaw PTY adapter (`src/process/supervisor/adapters/pty.ts`) wraps
node-pty lifecycle and writes but does not supply browser consumption credit.
The available Aegiscore directory yielded no applicable terminal renderer or
streaming implementation in the preceding investigation. Reuse Kookr's existing
backend, bridge, seed cache, reconnect helper, and test fixtures.

[xterm's flow-control guide](https://xtermjs.org/docs/guides/flowcontrol/)
documents that `write` queues work and its callback reports processed data. It
also explains why socket buffering alone cannot track browser consumption.
Kookr will use those callbacks to return credit, without pausing a shared PTY.
[Node's child-process documentation](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback)
documents socket-handle transfer, but does not prove Kookr's authenticated HTTP
upgrade handoff works; that needs the bounded experiment in Phase 4.

### Round-1 evidence corrections

- A disposable real `ws` server selected the offered v2 subprotocol without
  implementing v2. Protocol selection alone is not capability confirmation.
- With installed xterm, `write('OLD'); reset(); write('NEW')` produced
  `OLDNEW`. A stale-generation callback guard did not prevent those old bytes
  from parsing. This probe used xterm without a DOM renderer; it establishes
  parser behavior, not browser rendering performance.
- The external backend `onData` consumers are SessionBridge and
  `src/remote/session-stream-publisher.ts:149`. Supervision uses captures and
  structured events; no general mirrored stream bus is required.
- `src/server/terminal-input-coordinator.ts:136` serializes an entire paced
  sequence, including delays. Moving only its backend writes would lose that
  ordering relative to child-local keyboard input.
- `src/server/viewer-connection-registry.ts:178` owns socket revocation, expiry,
  scope rechecks, and liveness after upgrade. The child needs explicit continuing
  enforcement, not only an initial authorization descriptor.
- Linux Node 24.11.1 / ws 8.21.3 socket-handoff probe: four runs transferred an
  authenticated paused upgrade socket and its 4,104-byte head to a child. Initial
  4,096-byte and established 8,192-byte payloads matched exactly. Unauthorized
  requests received 401 with zero transfers. Parent stalls lasted 221/222/222/223
  ms; independently measured established echo RTTs were 5/3/5/3 ms, entirely
  during those stalls. This proves the transport primitive, not the full Kookr
  registry, native PTY lifecycle, sustained workload, TLS, or macOS behavior.

### Consensus-attack evidence correction

At 20:46:07 UTC, a read-only health sample reported `agents: 283` and
`attachedSessions: 4`. The health field is named misleadingly for this purpose:
`src/server/routes/diagnostics-routes.ts:426` reads retained tasks and line 903
returns their count. Attached sessions count backend attach entries, not active
output producers. Neither number is the browser's row count.

The client projection (`src/server/use-cases/snapshot-projection.ts:55` and
line 67) caps synthetic terminal-status rows at one day and one hundred rows.
Raw/debug snapshots are different. The frontend delta reducer and App bucket
derivations traverse delivered collections, so delivered cardinality is a
separate workload input; its actual performance cost was not established here.

A bounded twenty/104/283-row pure-helper microbenchmark did not finish before
the checkpoint ended. Its probe processes were stopped; no timing result or
freeze diagnosis is claimed. The headed twenty-producer qualification remains
an implementation gate. This correction prevents a task-store count from being
misrepresented as measured browser state.

## Design

### Phase 1: Scroll fidelity and honest measurements

Extract a small wheel accumulator, leaving event interception at the existing
terminal container. Read `deltaMode` before converting `deltaY`. Pixel-mode
deltas retain the existing forty-pixel-per-line scale initially, but accumulate
fractional lines across events. Line-mode deltas are already lines; page-mode
deltas multiply by visible terminal rows. Use truncation toward zero so tiny
negative events do not move a whole line prematurely. Keep the remainder.

Apply accumulated whole lines at most once per animation frame. Preserve signed
movement when direction reverses; clear pending work on terminal replacement,
hide, or disposal. At a scroll boundary discard pressure pointing beyond that
boundary so reversing direction responds immediately. Continue preventing wheel
events from reaching xterm's alternate-screen input translation. Test selection,
trackpad momentum, horizontal-only events, line/page units, and zero-size panes.
Include repeated five-pixel gestures and the first movement from rest in manual
qualification. Fractional accumulation is a correctness fix, not proof that the
legacy forty-pixel scale feels good. Tune that single scale against actual cell
height if the small-gesture qualification fails; pixel-smooth emulation is not
silently implied by integer-line scrolling.

Distinguish selection, socket open, first byte received, first data processed,
and first render opportunity. Add renderer kind and fallback reason. First parse
is telemetry only. Input becomes available after the complete initial seed
transaction is parsed, or after an explicit empty-session ready boundary; never
after only the first chunk of a multi-frame seed. This is terminal transport
readiness, not evidence that the coding agent is ready to answer a prompt.
Stale callbacks from old connections cannot unlock a new terminal. Keep legacy timing fields
readable, but version the new telemetry and do not blend the old enqueue-based
measurements into new percentiles.

For continuous streaming, keep sampled byte-boundary markers and local
monotonic timings. Measure transport-plus-processing round trips on the server;
measure receive-to-parse/render locally in the browser. Do not subtract unrelated
server/browser clocks. A test harness with one clock supplies end-to-end latency.
Production diagnostics retain counters/histograms, not raw output or per-byte logs.

### Phase 2: Bound the work waiting for the browser

The browser tells the bridge how much output xterm has processed. The bridge can
then stop feeding that viewer before its parser queue becomes a backlog. This is
flow control for each viewer, not permission to stop the coding agent.

Introduce one explicit versioned terminal protocol negotiated on the WebSocket
upgrade using a subprotocol, selected by an explicit server handler. A negotiated v2 connection uses typed input/control
envelopes; literal user text, including text resembling JSON controls, remains
input. Do not use an unescaped text prefix that can steal a pasted command.
Existing connections without v2 retain the current wire format during rollout.
The client must also receive a schema-validated v2 hello within two seconds of
socket open before sending v2 controls or input. A subprotocol echo alone is
insufficient. On timeout/mismatch, close and show an incompatible-version/reload
message; do not silently retry typed input on a legacy socket. A new server
continues to support old clients. Keep v1 until one released rollback version
also supports v2 and active-client diagnostics show no legacy clients during a
seven-day window; removal is a separate reviewed change, not an indefinite fork.

The server sends a hello with a connection generation and output credit limit.
The browser returns cumulative processed-byte acknowledgements (ACKs) for that
generation only. Count original binary payload bytes, not decoded UTF-16 string
length, and never count control messages. Duplicate ACKs are harmless. Reject
negative, non-integer, out-of-range, future, and wrong-generation ACKs. Read-only
viewers may return credit but cannot send agent input, resize, or trigger inputful
recovery. Treat protocol errors as connection errors, not agent termination.

Initial tuning values, to be calibrated by the workload suite:

| Budget | Initial value and purpose |
|---|---|
| Unacknowledged data | 128 KiB per viewer, covering socket transit, client staging, and xterm pending work together |
| Output frame | At most 8 KiB, also no larger than available credit; one frame per scheduled flush turn before yielding |
| Browser parse submission | At most one 8 KiB chunk in each xterm at a time; a document-wide round-robin scheduler submits one eligible chunk per task, then yields |
| ACK coalescing | After 32 KiB processed or eight milliseconds, whichever occurs first; always acknowledge a drained tail |
| Server outstanding payload | At most two MiB per viewer and 32 MiB across viewers, counting pending plus sent-but-unacknowledged payload; reserve before allocation |
| ACK stall | After five seconds without progress on outstanding bytes, close only that viewer with a specific recoverable-lag reason |

Payload limits also need allocation limits: accumulate into eight-KiB owned
segments, cap segment/control counts, and reserve fleet bytes before copying.
Do not let a million one-byte messages create a million queue objects. Limit
control envelope size to four KiB except explicitly bounded input/paste payloads;
reject control floods independently of output credit. Retain the current input
payload limits until their existing boundary tests establish a safe replacement.

For fleet pressure, first retire the existing viewer holding the most outstanding
bytes; break ties by oldest unacknowledged progress, then connection ID. Reclaim
its reservation before admitting another segment. Apply a per-viewer limit before
the fleet rule. If no existing viewer exceeds the incoming viewer's projected
outstanding bytes, retire the incoming viewer instead. A newly connecting viewer
can be refused admission rather than evict a healthy established one. Test a
fast viewer arriving after several stalled viewers filled the budget; fleet
pressure must be charged to the lagging holders, not just the last enqueue.

Do not wait an entire frame per chunk during normal streaming: that can needlessly
cap throughput. Start with fixed eight-KiB chunks and short scheduled tasks. A
pane with an outstanding write is skipped so it cannot prevent another pane
from being scheduled. Qualify aggregate four-pane frame timing, not just each
pane's callback duration. Callback elapsed time includes scheduling and is not
parser CPU time. Tune the fixed size from measurements; add adaptive chunking
only if fixed sizes cannot meet both responsiveness and throughput targets.

All terminal bytes use the same ordered queue: initial seed, replay, requested
history, recovery output, and live frames. Existing control messages that delimit
history/seed must be ordered with their bytes, not sent ahead of queued data.
Preserve live/replay provenance per queued segment instead of merging their flags
over an arbitrarily large batch. Credit stalls never block input or control reads.

The backend assigns each live segment an epoch and monotonic byte range, appends
it to the ring, then publishes it so a callback cannot capture an older boundary.
An atomic capture returns the same epoch, retained start, exclusive end position,
and geometry revision (a counter incremented when PTY dimensions change).
Epoch changes on a discontinuous attach/restart;
identical bytes do not imply duplicate output. Replace content-overlap guessing
with these positions. Preserve source provenance for attach-replay separately.

Transport credit and source position are distinct counters. Every parsed binary
payload returns credit, including transformed seed bytes. Each live output
segment's ordered metadata carries its epoch and source start/end; subchunk
offsets map directly within that range. Only parsing those mapped bytes advances
the live resume cursor. Seed-end establishes its covered source position only
when the entire seed transaction commits. Attach-replay with unknown source
coverage returns credit but invalidates resume eligibility; never infer a source
position from cumulative transport ACKs. Bound and validate these metadata records
along with other controls, including payload-length/range agreement.

Seed installation is a transaction: capture through position N, retain later live
segments, emit seed-begin/seed bytes/seed-end(N), then deliver only bytes after N.
A provisional cached screen may be shown as a noninteractive preview, but do not
stream live data into it and later overwrite it with an older reconstruction.
Cache entries carry epoch, dimensions, and covered position, not just ring size.
If continuation after N is no longer retained, fail the transaction explicitly.
Requested history uses the same frozen boundary and excludes already-applied
bytes; it cannot append an overlapping historical ring to a live screen. An
explicit history request replaces the displayed history in one transaction.
Replacement clears selection and may change the viewed line, with an explicit
notice; do not introduce a byte-offset-to-rendered-cell mapping or a new history
UI here. Restore anchors only where the existing xterm buffer proves they remain
valid. If the ring lacks a valid starting state, report unavailable history
instead of treating an arbitrary suffix as a fresh terminal.

At a replacing seed-begin, immediately invalidate the old resume cursor and close
the input/reply gate. Parsing a prefix, or all data without seed-end, does not
commit a new cursor. Commit `(epoch, end position, geometry revision, dimensions)`
only after the matching seed-end and all preceding writes complete. Interrupted
seed/history installation requires a new seed/new view, never continuation from
the old cursor. All later live frames remain behind this transaction boundary.

The browser stages bytes outside xterm under the same advertised byte window.
Only the xterm write callback advances processed bytes. No ACK depends on React
commits, scroll position, or `onRender` firing: escape-only output and background
tabs must not deadlock credit. One writer per terminal instance owns every data
write, reset, and seed transaction. On switch, discard unsubmitted old bytes and
wait for the single in-flight write callback before resetting and installing the
new seed. The retired callback still releases this barrier but never ACKs or
unlocks the new generation. Disconnect output-generated terminal replies while
retiring; put connection-status messages in React, not into the PTY stream.
If the barrier does not finish in two seconds, dispose/recreate the xterm instance
and its addons instead of resetting a still-active parser.

Pane hide/unmount closes the subscription and clears scheduled work. Document
visibility/freeze is a separate lifecycle: voluntarily close on hidden/freeze,
preserve the parsed cursor and screen, and attempt continuity resume once when
visible again. A suspended tab may miss lifecycle callbacks; handle its timeout
as display lag on return. Legacy clients get bounded
server chunks but cannot receive a browser-consumption guarantee.

#### Falling behind and safe recovery

Never silently remove an arbitrary slice of ANSI output and continue feeding its
suffix into the same terminal. That can leave the parser inside a string or mode
and corrupt everything afterward. Budget exhaustion retires that viewer's
connection and shows: “Terminal display fell behind. Agent is still running.”
Preserve the last visible screen and a Reconnect action; do not label it ended.

The first recovery mechanism is exact continuity, not reconstruction. The writer
retains the original stream epoch and parsed position, including the retiring
in-flight chunk's completion. If the server still retains every following byte
in that epoch, and both parser dimensions and backend geometry revision are
unchanged, resume after that position into the same parser without resetting.
Defer reconnect fit/PTY resize until eligibility is decided. Viewport/font changes
or another owner's PTY resize invalidate exact continuity; the initial version
does not attempt to reconstruct historical geometry. Preserve this as an explicit
new-view/unavailable result, not silent best-effort resume.
Test this with the real agent fixtures; byte continuity supports arbitrary
terminal modes without needing to serialize them.

If continuity is unavailable, never call a non-null reconstructed grid a safe
checkpoint. A resumable seed must identify its source epoch/end position, initial
state, dimensions, and completeness. Complete replay from a known stream origin
qualifies. A reset/full-redraw fixture qualifies only if its terminal modes and
cursor state are independently verified before live continuation. A truncated
ring, differential final frame, or time-budgeted partial reconstruction does not
qualify. Make seed results a discriminated union of resumable and display-only;
move existing approximate reconstructions into the latter category rather than
claiming they preserve parser state.

When no resumable seed exists, retain the old screen or show a clearly labeled
noninteractive preview and “Current screen unavailable.” Offer an explicit
Start a new view action with a history-gap warning. That action uses the existing
best-effort initial-attach behavior, not a claim of restored exact continuity;
it must not implicitly inject recovery input. Ordinary initial attachment is
still best-effort and remains distinct from the lossless live/resume guarantee.
Record unavailable recovery frequency so this safety behavior cannot silently
become the common path for supported agents. Qualify exact retained-range resume
for Claude/Codex/Grok fixtures and expired-range unavailable behavior separately.

Indicate that older terminal history may have a gap after a new view. Do not
automatically issue Ctrl+L, resize
nudges, or recycle the shared attach merely because a viewer exceeded credit.
Read-only viewers never gain an inputful recovery path.

A continuously noisy producer can exhaust bounded retention before the browser
catches up. The UI must remain responsive in that case, but displaying every
intermediate frame is not promised. Recovery is explicit and rate-limited; avoid
an automatic reconnect/replay/overflow loop. A terminal gap is not a gap in the
structured transcript or a change to agent lifecycle state.

Connection states are negotiating, seeding, live, suspended, lagged,
incompatible, access-denied, and ended. Only a positive session-exit/gone signal
means ended. Transient disconnects and child restarts allow at most three
automatic attempts in thirty seconds, tracked across socket generations. A
hello does not reset this budget; thirty seconds of successful live progress
does. A known lag close stops automatic retries immediately. If its close reason
is lost, the cross-generation budget still prevents an infinite loop. Show
delivery-unknown when a disconnect interrupts input; never replay it automatically.

### Phase 3: Reduce competing browser work

Replace DetailPanel's whole-store subscription with the fields/actions actually
used. Memoize the terminal boundary and keep callback identities stable where
unrelated supervisor updates currently propagate into it. Verify with React
render counts before and after; do not assert this is the dominant CPU cost
without a browser trace. Do not change the dashboard's state protocol here.

Coalesce ResizeObserver and reveal/font fit requests once per frame. Skip
zero-size and unchanged dimensions. Keep the initial attach resize immediate,
then use one client frame-coalescing boundary plus the existing server debounce;
remove the redundant eighty-millisecond client debounce if coverage shows no
regression in rapid resizing and absolute-position terminals.

Replace per-frame TextDecoder plus regex allocation for the approximate new-lines
badge with a byte scan. Track a trailing carriage return across chunks so CRLF
is not counted twice. Keep it an approximate output indicator, not a claim about
rendered terminal rows. Update the badge at the existing bounded cadence only
while scrolled up; it must not dictate output parsing or move the viewport.

Retain the existing ten-thousand-line scrollback limit. Preserve the viewed text
and selection while those lines remain in xterm. Once eviction makes this
impossible, clamp to the oldest retained line, clear a selection that spans lost
content, and show “Older terminal lines were discarded.” Do not jump to latest
or imply that a preserved viewport index still refers to the same text.

Keep WebGL as the existing preferred renderer. Record context loss/fallback and
test both renderers; renderer replacement is not justified by the current data.

### Phase 4: Isolate terminal I/O from supervision

The earlier event-loop sample shows that browser-side fixes alone cannot promise
steady delivery. Preserve a planned isolation stage, but first run a bounded
proof of the socket/authentication handoff before committing to its production
implementation. If that proof fails, return the concrete tradeoff for approval;
do not substitute a broad server rewrite or silently omit isolation.

Keep one package and add one local terminal-host child process. It owns the
dtach backend (including its sole manifest/ring ownership), persistent attach
clients, per-session input serialization, and established terminal WebSockets.
The main process retains HTTP/API authorization, task lifecycle policy,
supervision, hooks/transcripts, and ordinary dashboard WebSockets.

```text
main process                            terminal-host child
authorize HTTP upgrade -- socket -----> terminal WebSocket <-> browser
task commands -------- bounded IPC ----> LocalDtachBackend <-> dtach <-> agent
monitor reads <------ bounded RPC ------ ring snapshots / health summaries
                                        |
                          bounded background persistence/reconstruction
```

IPC is communication between these local processes. The main process validates
the existing route/scope/origin checks before transferring a paused socket with
its upgrade head and an internal, generation-bound authorization descriptor.
The child completes the WebSocket handshake and owns all subsequent terminal
frames. There is no second public port and no forwarding every terminal byte
through the main loop. This initial design covers plaintext local HTTP upgrade;
TLS and hosted relay paths must retain existing behavior and are not covered by
the local established-connection latency claim until qualified separately.

The complete TerminalInputCoordinator moves into the child, including readiness
versions, input epochs, paced sequences, and empty-Enter decisions. Main sends
each paced sequence as one operation, including its delay. Hook-driven state
updates cross the same ordered, generation-fenced control channel; main may cache
snapshots for display but must ask the child for authorization decisions.
Unavailable or stale readiness never authorizes an empty-Enter action.

Main retains grant/scope policy; child owns terminal sockets and ping/pong.
Registration/close messages use connection IDs plus child generation, replacing
direct WebSocket references for remote-owned entries in the existing registry.
Handoff includes canonical session, actor/grant, and absolute grant expiry.
Revocation/scope changes send priority close commands and require child close
acknowledgements. A terminal-viewer policy lease lasts at most ten seconds,
renewed every two seconds after main revalidation; expiry or IPC loss closes
viewers fail-closed. Missing close acknowledgement is reported as enforcement
pending, never as confirmed eviction. Owner terminal liveness remains child-local.
Do not lengthen the existing ten-second scope/revocation sweep bound.

Expose a typed asynchronous backend proxy to existing main-process callers.
Operations have request IDs, byte/count limits, deadlines, and a child-generation
fence. Never replay an uncertain write after IPC failure. Give control and input
priority over bulk capture requests. A slow monitor receives bounded snapshots
or an explicit stale/unavailable result, not an unbounded copy of the PTY stream.
Existing synchronous diagnostics accessors become cached projections with age
and child-generation metadata. An unavailable child is a transport error, not
proof that an agent died; lifecycle callers must retain this distinction.

| Existing consumer | Owner after split | Boundary contract |
|---|---|---|
| SessionBridge | Child | Local byte fanout, source positions, viewer credit; no parent payload forwarding |
| TerminalInputCoordinator | Child | Main proxy sends whole input operations and readiness updates; one queue authority |
| SessionStreamPublisher | Main | Dedicated bounded byte channel; preserve existing relay publication gate, encryption, epoch/sequence and explicit-gap behavior |
| Supervisor capture callers | Main | Bounded capture RPC; no general stream replication bus |
| Grant store / policy | Main | Generation-bound registration, policy lease and acknowledged eviction; child enforces sockets |

The relay channel has its own byte window and cannot block local bridges. It
preserves source ordering; overflow invalidates that subscription and its remote
input cursor before resubscription with a new session epoch. Drop/gap counters
must include loss before publication, not only `publish()` failures. Never
continue presenting the previous relay cursor as current across a missing range.
The existing publication/consent gate remains authoritative in main.

Synchronous ring file writes and reconstruction must not move into the child
unchanged. Use bounded asynchronous persistence with one latest pending snapshot
per session and one active write per session, preserving atomic generation
ordering. Use one reconstruction worker owned by the terminal host and move the
existing one-at-a-time reconstruction scheduler, per-session waiter cap, and
deadline policy there; do not build a second scheduler around it. Results carry
source epoch/end position and completeness. The existing full-ring capture
allocation also needs timing and byte budgets. Do not add an unbounded worker
pool or one process per viewer.

The child is tied to one server generation and is not a new independently managed
daemon. On orderly shutdown stop accepting bridges, close their sockets, flush
within a bounded deadline, and dispose attach clients without killing dtach
masters. On child crash, fail pending RPCs, mark the terminal subsystem degraded,
and restart with bounded backoff. Reattach existing dtach sessions under one
validated owner; never start duplicate agents. Lost in-memory history must be
reported, not hidden. Rollback disables the child path on the next canonical
deployment and reconnects to the same surviving dtach sessions.

Before replacing a child, positively verify the previous child/attach generation
has exited; never overlap two manifest writers. On parent IPC disconnect the
child stops input, closes sockets, boundedly flushes, and disposes its attaches.
If shutdown times out, terminate only that exact verified child generation, not
dtach masters or process-name matches. An unverified owner blocks replacement.
Keep the in-process rollback path through one qualified release/rollback cycle;
retire it in a separate reviewed change after Linux/macOS fault tests and the
twenty-agent soak pass, rather than maintaining both backends indefinitely.

This is the highest-risk stage. The same fault/restart/authorization tests must
pass with both in-process and child-backed implementations before enabling it.

## Files to change

Paths below identify responsibilities, not a mandate to create one file per
concept. Extract only enough helpers to test the byte accounting and scheduler.

| Surface | Expected files |
|---|---|
| Scroll/write scheduling and telemetry | `src/frontend/components/TerminalPanel.tsx`, small adjacent terminal helpers and tests, `src/frontend/terminal-renderer.ts` |
| React isolation | `src/frontend/components/DetailPanel.tsx` and related component tests |
| Protocol and queue | `src/server/session-bridge.ts`, shared terminal protocol types/validators, fake bridge and terminal E2E tests |
| Diagnostics compatibility | Existing terminal attach telemetry contracts and receiver; version fields rather than replacing unrelated telemetry |
| Child host/proxy | `src/server/bootstrap/start-http-and-websockets.ts`, backend construction/lifecycle wiring, new terminal-host entrypoint/proxy |
| Persistence/reconstruction | `src/adapters/local-dtach-stream.ts`, `src/adapters/dtach-ring-store.ts`, existing absolute-TUI reconstruction helpers |
| Qualification | Existing Vitest/Playwright terminal suites plus a bounded replay harness and sanitized fixtures |
| Product/architecture | `docs/features.md`, `docs/architecture.md`, and an accepted ADR only after design approval |

## Edge cases and verification plan

Write feature acceptance criteria, failing tests, then implementation for each
phase. Run focused tests and measurements after each phase before starting the
next. Do not combine a risky backend move with unmeasured browser changes.

- Unit tests: fractional wheel accumulation, reversal/boundary behavior,
  deltaMode, cleanup, partial UTF-8/control sequences, CRLF chunk boundaries,
  credit arithmetic, generation fences, stale callbacks, duplicate/malformed ACKs.
- Bridge tests: every binary-send path obeys credit/chunk limits, interleaved
  controls preserve ordering, one slow viewer does not stall a fast viewer,
  oversized first frame is rejected before copying, per-viewer and fleet bounds,
  stalled ACKs, tail ACKs, read-only control filtering, and literal JSON input.
- Browser tests: continuous streaming while scrolled up, copy/selection, momentum,
  renderer fallback/context loss, resize bursts, hidden/revealed tabs, quick
  task switching, silent sessions, and active input during output pressure.
- Fault tests: connection loss inside a paste, child crash during write/capture,
  parent death, restart races, atomic persistence generations, disk-full behavior,
  duplicate attach prevention, auth revocation, and production/dev isolation.
- Replay matrix: extend the existing `scripts/load-harness.ts` hook-storm
  generator with a separate-emitter PTY/browser lane. Its current in-process
  fake-backend RTT does not qualify isolation. Use one/ten/twenty simulated producers; one/four visible panes;
  slow/fast viewers of the same session; calm logs, redraw bursts, and one noisy
  producer. Compare raw byte hashes and xterm screen/cursor/mode state, not just
  screenshots. Run the required mixed supervision workload with both retained
  task populations through the real client projection, recording delivered rows,
  event-window size, and serialized payload bytes. Add a deterministic
  two-hundred-millisecond parent event-loop stall while established child-owned
  terminals stream; their traffic must continue. Retain paired baseline/changed
  measurements and resource traces.
- Real-browser qualification: validate the actual renderer and refresh rate;
  manually confirm scrolling/clicking during the twenty-producer replay. Do not
  claim these targets passed from headless DOM results or empty RTT samples.
- Delivery gates: full local typecheck/test suite and touched-surface gates.
  GitHub Actions remains disabled by standing policy. Commit/push/PR/deploy follow
  the normal delivery workflow only after the required approval.

## Alternatives considered

- **Only fix the wheel:** fixes a deterministic defect, but neither browser
  parser backlog nor server event-loop stalls. Ship this first, not as the whole
  solution.
- **Increase all buffers:** delays overload while increasing lag and memory. The
  solution is bounded work and explicit recovery, not a larger invisible queue.
- **Pause the shared PTY on a slow browser:** can block the agent and healthy
  viewers. Reject for Kookr's shared persistent-session model.
- **Replace WebGL/terminal emulator:** WebGL is already used when available;
  there is no actual user-renderer profile justifying a replacement.
- **Move only WebSockets or only node-pty into a worker:** leaves the other side
  or a byte-forwarding proxy on the blocked main loop. It cannot meet the stated
  established-connection isolation objective.
- **Worker threads for all terminal I/O:** socket ownership and native PTY
  lifecycle require specific proof. A child process has documented socket-handle
  transfer and better crash containment; compare through the Phase-4 experiment.
- **Skip process isolation because twenty agents is small:** could be reasonable
  if the first three stages meet all measured targets, but differs from the
  approved direction. Present that evidence and ask before dropping the stage.

## Open questions / approval boundaries

1. The exact sustainable output envelope is not known. Calibrate fixture rates
   and verify the headed-browser baseline before advertising a twenty-agent SLO.
2. Socket handoff, ownership/recovery, and native PTY behavior must be proven on
   Linux and macOS before enabling the child path. Linux-only tests cannot claim
   macOS qualification.
3. Existing replay reconstruction is not a universal safe terminal checkpoint.
   Explicit unavailable-screen behavior is required when safe recovery cannot be
   established; no arbitrary ANSI truncation is authorized.
4. The user approved implementation after critic review. Pushing, opening a PR,
   merging, and updating production still follow the task's delivery authority;
   the implementation approval alone does not authorize deployment.

## Critic feedback incorporated

Round 1 panel: boundary-critic, failure-mode-analyst, design-minimalist,
socratic-challenger, ambition-amplifier. Count five; asserted at most five.
The original shared evidence pack is retained; corrections are recorded in its
separate round-1 subsection and shared with every later panel.

Incorporated: explicit hello confirmation; one parser transition owner; complete
seed readiness; source-position snapshot/live ordering; continuity-first recovery
with display-only reconstruction classification; coordinator ownership and viewer
revocation after handoff; explicit relay consumer ownership; document suspension
and bounded reconnect attempts; realistic mixed-load/render-marker qualification;
scrollback eviction and small-gesture behavior; retirement criteria for rollout
paths; reuse of the existing reconstruction scheduler and load harness.

Design-minimalist and ambition-amplifier differed on scheduling scope. I accepted
the minimalist's fixed initial chunk size to avoid an unmeasured adaptive control
loop, and the amplifier's explicit shared multi-pane scheduling/qualification so
per-pane limits do not conceal aggregate browser contention. All four approved
stages remain; no twenty-to-fifty-agent expansion or emulator replacement was added.

ambition-amplifier 2026-09-09: novel findings — require seed validity, actual relay
ownership, and mixed supervision load rather than leaving them to implementation.

design-experimenter 2026-09-09: three claims tested in approximately five minutes.
Subprotocol-only capability and callback-only parser isolation were falsified;
both are fixed in this revision. An ordered parser barrier produced `NEW` where
immediate reset produced `OLDNEW`. Socket handoff passed four Linux runs with
byte-exact echo during a parent stall. macOS and full Kookr integration remain
unqualified. These probes do not falsify the four-stage direction, so review
continues with the corrected transitions rather than repeating the hypotheses.

Round 2 panel gate: boundary-critic, failure-mode-analyst, design-minimalist,
socratic-challenger, ambition-amplifier. Count five; asserted at most five.

Round 2 incorporated: separate transport ACKs from source resume positions;
invalidate/commit resume state around whole seed transactions; require unchanged
geometry for exact resume; charge fleet pressure to lagging reservation holders;
report missing/superseded render markers instead of censoring latency samples.
Accepted the minimalist's removal of a new byte-to-cell history-selection mapping;
ordinary live scrolling stays stable, explicit history replacement is disclosed.

ambition-amplifier 2026-09-09 (round 2): no novel finding — a universal terminal
checkpoint/emulator was considered and rejected as unnecessary scope expansion.

Intent preservation check after round 2: all four approved stages remain aimed at
twenty agents; rendering and scrolling are still primary. Exact-resume limits are
visible safety tradeoffs, not silent substitution of broken or truncated output.

Round 3 panel gate: boundary-critic, failure-mode-analyst, design-minimalist,
socratic-challenger. Count four; asserted at most five. Ambition/minimalism scope
conflict was resolved in rounds 1–2; no broader agent-count or emulator scope added.

Round 3 outcome: all four critics reported no remaining substantive design
blockers. Boundary ownership, failure transitions, geometry-sensitive resume,
fixed scheduling, and explicit history-replacement semantics were accepted.
This is a design verdict, not a passing implementation or performance result.

general-purpose 2026-09-09: consensus-attack — active producer count alone does
not describe retained dashboard work. Incorporated as a mandatory independent
stored-task/delivered-row/payload-size qualification dimension. No further critic
round was opened; this is the single bounded post-consensus revision.

design-experimenter 2026-09-09 (consensus follow-up): verified health/task and
attach-count semantics, and falsified the assumption that 283 stored tasks means
283 client rows. The real snapshot projection must be used. A bounded CPU
microbenchmark did not complete, and headed-browser FPS remains untested.

No findings were used to remove an approved stage. Universal checkpointing,
new history UI, byte-to-cell provenance, and an unmeasured adaptive controller
were rejected or narrowed with the reasons above. Phase-4 platform/integration
qualification and the mixed-load performance targets remain explicit gates.

Artifact verification: required sections, nonempty content, balanced code fences,
URL syntax, and whitespace checks passed. Only this RFC was added in the worktree;
no application source or production configuration was changed, committed, pushed,
or deployed. A reusable asynchronous-mutation lesson was appended to the existing
generic lifecycle KB note instead of creating a duplicate.

Intent preservation check: rendering/scrolling/streaming are the primary user
concerns; twenty agents is the ceiling; dtach, byte correctness, local-first
operation, and approval-before-implementation remain load-bearing constraints.
