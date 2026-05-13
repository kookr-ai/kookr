# RFC: System Resource Visibility

## Status

**Implemented (v1)**

**Date:** 2026-05-13
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr supervises multiple local coding agents, but the dashboard does not show whether the machine running those agents is under resource pressure. When terminal streaming feels slow, agent output stalls, or multiple tasks compete for attention, the user has no quick way to separate "agent is stuck" from "the host or Kookr server is slow."

The first useful surface is intentionally small: current host CPU, approximate RAM availability, and Kookr server responsiveness. These metrics should be passive diagnostic context, not a new anomaly system.

## Success Criteria

- A user can glance at the dashboard and see whether the local host is CPU-bound or memory-constrained without opening `top`, Activity Monitor, or another terminal.
- A user can inspect the status tooltip and see whether Kookr's Node event loop is delayed enough to plausibly explain slow dashboard/streaming behavior.
- The feature adds no persistent data and no agent control behavior.

## Empirical Grounding

Round-1 review produced load-bearing claims, so an empirical checkpoint was run before this revision.

Findings:

- Node's built-in `node:os` APIs expose the needed host primitives on the local Linux runtime: CPU counters through `os.cpus()`, total/free memory through `os.totalmem()`/`os.freemem()`, and load averages through `os.loadavg()`.
- Node's `perf_hooks.monitorEventLoopDelay()` is built in and intended to measure event loop delay. A local probe returned event-loop delay samples in milliseconds.
- The local probe returned: 24 logical CPUs, 24 available parallelism, 33.6 GB total RAM, 8.6 GB free RAM, aggregate CPU delta around 57%, max-core CPU around 87%, and event-loop p95 around 20 ms during the sample.
- The current `StatusBar` already has quota-pill styling and compact mode, but mobile/compact rendering needs explicit rules because the bar also contains task count, quota, STT, sound, achievements, and reflection prompts.
- `totalmem - freemem` is a portable approximation, not macOS Activity Monitor "Memory Pressure." The UI must label it as RAM availability/usage estimate, not OS memory pressure.
- macOS has not been locally probed in this session. The implementation PR should run the same probe on macOS before treating the feature as Linux+macOS verified.

Primary docs checked:

- Node OS API: https://nodejs.org/api/os.html
- Node performance hooks API: https://nodejs.org/api/perf_hooks.html

## Requirements

- **R1.** The dashboard SHALL show host CPU and RAM estimate in the existing status bar.
- **R2.** The backend SHALL use APIs available on Linux and macOS for v1. The feature is not considered Linux+macOS supported until R15's probe evidence is attached to the implementation PR.
- **R3.** The backend SHALL use built-in Node APIs for v1.
- **R4.** Resource data SHALL update at a low fixed cadence, default 2 seconds.
- **R5.** The frontend SHALL mark resource data stale when no `resourceStatus` message has been received for more than 10 seconds. Staleness is based on browser receive time, not server `sampledAt`.
- **R6.** The UI SHALL show unavailable metrics as `--`, never as `0`.
- **R7.** CPU usage SHALL be calculated from deltas between successive `os.cpus()` samples.
- **R8.** RAM SHALL be shown as an approximate used/free estimate from `os.totalmem()` and `os.freemem()`, not as OS memory pressure.
- **R9.** The resource UI SHALL surface Kookr server responsiveness using `perf_hooks.monitorEventLoopDelay()` p95 and timer drift.
- **R10.** Tooltip/detail content SHALL include Kookr server process memory from `process.memoryUsage()`.
- **R11.** The implementation SHALL not persist resource samples.
- **R12.** The implementation SHALL not alert, interrupt agents, auto-throttle, modify scheduling, or create findings based on resource status in v1.
- **R13.** The wire contract SHALL be shared through `src/shared/contracts/messages.ts` and re-exported through `src/shared/protocol.ts`.
- **R14.** A newly connected WebSocket client SHOULD receive the latest resource status immediately after the initial snapshot if one exists.
- **R15.** The implementation PR SHALL include Linux and macOS probe output for `os.cpus()`, `os.totalmem()`, `os.freemem()`, and event-loop delay before claiming Linux+macOS support is satisfied.
- **R16.** Resource detail SHALL be available to keyboard and touch users through an accessible label and focus/tap behavior, not hover-only.

## Non-goals

- No per-agent process tree accounting in v1.
- No historical charts.
- No disk, network, GPU, battery, fan, thermal, or load-average UI in v1.
- No resource-based anomaly detection.
- No automatic concurrency limits.
- No external observability backend.
- No platform support beyond Linux and macOS for v1.

## Design

### Summary

Add a small server-side sampler that emits host/runtime resource snapshots over the existing WebSocket connection. The frontend stores the latest snapshot with a client receive timestamp and renders compact resource pills in `StatusBar`.

The v1 visible surface is:

```text
CPU 42%  RAM 68%
```

Tooltip detail SHALL add:

```text
Server loop p95 21 ms
Kookr RSS 144 MB
RAM 10.7 GB free / 33.6 GB total
Sampled 2s ago
```

### Dependency Decision

Do not add `systeminformation` for v1. It is a reasonable later choice if Kookr needs disk, network, battery, thermal, or richer platform data, but CPU/RAM/server responsiveness are available through built-in Node APIs.

Do not add `pidusage` for v1. It is useful for per-process CPU/RAM and is the likely candidate for a later "which task is burning CPU?" feature, but the first user-visible improvement is host/runtime context, not process attribution.

### Data Model

Keep the backend message raw. The frontend derives visual severity.

```typescript
export type ResourceUnavailableReason =
  | 'cpu_warming_up'
  | 'cpu_unavailable'
  | 'cpu_delta_invalid'
  | 'memory_unavailable'
  | 'event_loop_unavailable'
  | 'sampler_error';

export interface SystemResourceStatus {
  source: { kind: 'server-host' };
  sampledAt: string;
  sampleGapMs: number | null;
  timerDriftMs: number | null;
  host: {
    cpuUsagePercent: number | null;
    memoryUsedPercent: number | null;
    memoryFreeBytes: number | null;
    memoryTotalBytes: number | null;
  };
  server: {
    eventLoopDelayP95Ms: number | null;
    processRssBytes: number | null;
    processHeapUsedBytes: number | null;
    processHeapTotalBytes: number | null;
  };
  unavailable: ResourceUnavailableReason[];
}
```

Wire message:

```typescript
export type ServerMessage =
  | ...
  | { type: 'resourceStatus'; status: SystemResourceStatus };
```

`source.kind: 'server-host'` prevents ambiguity if Kookr later supervises remote tasks or multiple hosts. The DTO intentionally omits hostname to avoid broadcasting machine identity when it is not needed for the UI.

Host and server metrics are nested separately because they answer different questions:

- `host`: whether the computer running Kookr is resource-constrained.
- `server`: whether Kookr's Node process is plausibly delaying dashboard or terminal streaming updates.

### CPU Calculation

`os.cpus()` returns cumulative CPU time counters. The metrics helper keeps the previous raw sample in memory:

1. For each logical CPU, sum `user + nice + sys + idle + irq`.
2. Sum idle time separately.
3. Compare current totals to the previous sample.
4. Compute aggregate `cpuUsagePercent = 100 * (1 - idleDelta / totalDelta)`.
5. Clamp percentages to `[0, 100]` and round for display.

The first sample has no previous sample, so CPU usage is `null` and `unavailable` includes `cpu_warming_up`.

Reset the CPU baseline and emit `null` for CPU when:

- `os.cpus()` returns an empty array.
- the logical CPU count changes between samples.
- any counter delta is negative.
- `totalDelta <= 0`.
- elapsed monotonic time since the previous sample exceeds `max(30_000, 10 * RESOURCE_STATUS_INTERVAL_MS)`, which covers laptop sleep/resume without blanking CPU during shorter event-loop stalls.

Use monotonic time (`performance.now()` or `process.hrtime.bigint()`) for sample-gap logic. Use `sampledAt` only for display provenance.

If `sampleGapMs` is larger than `3 * RESOURCE_STATUS_INTERVAL_MS` but below the reset threshold, still report CPU using the longer sample window and expose `sampleGapMs`/`timerDriftMs` in the tooltip. That is more useful than `CPU --` when CPU saturation delayed the sampler.

### RAM Calculation

RAM values come from `os.totalmem()` and `os.freemem()`:

```typescript
memoryUsedPercent = 100 * (1 - freeBytes / totalBytes)
```

If `totalBytes <= 0`, RAM is unavailable. The UI label is `RAM`, and tooltip copy should say "Approximate free/used physical memory reported by Node; not OS memory pressure."

### Event Loop Delay

The server service uses `perf_hooks.monitorEventLoopDelay()` with a modest resolution, e.g. 20 ms, and reports `eventLoopDelayP95Ms` in the resource snapshot.

Lifecycle:

1. Enable the histogram on resource service start.
2. Report `null` and include `event_loop_unavailable` until the histogram has observations.
3. Read p95 before reset.
4. Reset after each emitted sample so the displayed p95 describes the recent interval rather than the entire server lifetime.
5. Disable the histogram on service stop.

Also report `timerDriftMs`: the difference between expected and actual sample fire time measured with monotonic time. If the Node event loop is blocked long enough to delay the sampler itself, `timerDriftMs` gives the tooltip a direct "resource telemetry was delayed by X ms" clue.

### Severity and Display

Severity is a frontend presentation concern. The shared DTO sends raw values only.

Initial UI thresholds:

| Metric | normal | elevated | high | critical |
|---|---:|---:|---:|---:|
| CPU usage | `< 70%` | `70-84%` | `85-94%` | `>= 95%` |
| RAM estimate | `< 80%` | `80-89%` | `90-94%` | `>= 95%` |
| Event-loop p95 | `< 50 ms` | `50-149 ms` | `150-499 ms` | `>= 500 ms` |

The CPU and RAM pills use their own severities. Event-loop delay is normally tooltip/detail, but high or critical event-loop delay must be visible: add a compact `Loop`/`Kookr lag` pill on desktop, and add warning styling to the compact resource group on mobile. This resolves the tension between a lean UI and the original "streaming feels slow" use case.

RAM severity should be less alarm-like than CPU severity because the value is an approximation. Use muted warning styling for RAM unless both `memoryUsedPercent >= 95` and `memoryFreeBytes` is below an implementation-defined low-free-memory floor such as 1 GiB. The exact floor should be adjusted based on Linux/macOS probe output.

These thresholds are initial heuristics, not health verdicts. The implementation PR must include observed Linux and macOS probe output in its PR description so the thresholds can be adjusted with evidence.

### Backend Structure

| Path | Responsibility |
|---|---|
| `src/core/system-resource-metrics.ts` | Pure CPU and RAM calculations from injected raw OS samples. No `node:os`, event-loop, shared DTO, or frontend severity threshold imports. |
| `src/core/system-resource-metrics.test.ts` | Unit tests for CPU delta math, first-sample `null`, topology change reset, invalid deltas, sleep/resume reset, RAM unavailable. |
| `src/server/system-resource-sampler.ts` | I/O boundary for `node:os`, `node:perf_hooks`, monotonic time, and `process.memoryUsage()`. Converts event-loop nanoseconds to milliseconds and maps internal metrics to `SystemResourceStatus`. |
| `src/server/resource-status-service.ts` | Timer lifecycle, latest-status cache, immediate first sample, WebSocket broadcast, shutdown cleanup. |
| `src/server/bootstrap/start-background-services.ts` | Starts/stops the resource service with other timer-owned background services. |
| `src/shared/contracts/messages.ts` | Defines `SystemResourceStatus`, unavailable reason union, and the `resourceStatus` server message. |
| `src/shared/protocol.ts` | Re-exports `SystemResourceStatus` for frontend consumers. |
| `src/frontend/store/store-types.ts` and a small `system-status` slice | Stores `resourceStatus`, `resourceStatusReceivedAtMs`, and `handleResourceStatus`. |
| `src/frontend/hooks/useWebSocket.ts` | Handles `resourceStatus` and records receive time. |
| `src/frontend/resource-status.ts` | Runtime type guard and frontend severity helpers for resource DTOs. Invalid messages are ignored at the WebSocket boundary, preserving the previous status until the freshness timer marks it stale. |
| `src/frontend/components/StatusBar.tsx` | Renders CPU/RAM pills with tooltip detail and stale state. |
| `src/frontend/styles.css` | Adds resource pill styles matching quota pill density. |

Do not import the shared wire DTO into `src/core`. Core owns internal calculation types; the server sampler maps those types to the shared DTO.

Composition-root wiring:

1. `createKookrServerInternal` creates `resourceStatusService` before assembling `WsConnectionDeps`.
2. `WsConnectionDeps` receives `getLatestResourceStatus`.
3. `startBackgroundServices` receives `resourceStatusService.start` and `resourceStatusService.stop`.
4. `ws-connection-handler` sends `getLatestResourceStatus()` to a newly connected client immediately after the initial snapshot, when a cached status exists.

### Server Lifecycle

The resource service is registered from `startBackgroundServices`, not directly sprawled through `src/server/index.ts`.

Behavior:

1. Start when background services start.
2. Take an immediate sample and broadcast it. The first CPU field is expected to be `null`; memory may already be populated and event-loop delay may be `null` until observations exist.
3. Continue sampling every 2 seconds via a non-overlapping `setTimeout` loop.
4. Cache the latest `SystemResourceStatus`.
5. Send cached status to newly connected WebSocket clients after the initial snapshot.
6. Stop on server shutdown/abort and never broadcast after stop.

Sampling stays always-on while the server is running. This avoids client-count lifecycle complexity; the cost of reading built-in OS counters every 2 seconds is negligible for a local dashboard.

Any sampler error must fail open:

- do not crash server startup;
- log once or rate-limit logs;
- broadcast an unavailable snapshot with `sampler_error`;
- keep the next tick scheduled.

Stale is reserved for missing WebSocket/resource updates. An unavailable snapshot means the service is alive but metrics failed.

### Frontend UX

Render in the left side of the existing status bar, after task/finding count and before quota/STT:

```text
12 tasks * 2 findings  CPU 42%  RAM 68%  5h: 31%
```

Rules:

- `CPU --` while warming up or unavailable.
- `RAM --` if memory is unavailable.
- faded pills when `Date.now() - resourceStatusReceivedAtMs > 10_000`.
- tooltip uses `sampledAt` for provenance, but stale styling uses client receive time.
- `StatusBar` or a small freshness hook schedules a timer when `resourceStatusReceivedAtMs` changes so stale styling flips after 10 seconds even if no further WebSocket messages arrive.
- desktop shows both CPU and RAM pills.
- compact/mobile mode renders a fixed-width combined mini pill such as `CPU 42 * RAM 68` rather than choosing a "winner" across unlike metrics.
- high/critical event-loop delay adds a `Loop`/`Kookr lag` marker on desktop and warning styling to the compact mini pill on mobile.
- tooltip for RAM includes the approximation caveat.
- resource details are exposed through `title`, `aria-label`, and focus/tap behavior so keyboard and touch users can access the same information as hover users.

No visible explanatory text is added to the main screen. Details live in the tooltip.

## Edge Cases

- **First sample:** CPU usage is unavailable until two samples exist; render `CPU --` with warming-up tooltip.
- **No CPU info:** `os.cpus()` can return an empty array. Render CPU unavailable.
- **CPU topology change:** reset baseline and render CPU unavailable for that sample.
- **Sleep/resume or long event-loop stall:** reset baseline when monotonic sample gap exceeds `3 * interval`; expose `sampleGapMs`/`timerDriftMs` in tooltip detail.
- **Memory total zero:** render RAM unavailable if `totalmem()` returns `0`.
- **Disconnected browser:** frontend marks stale based on last received message.
- **Browser/server clock mismatch:** stale UI does not rely on server time.
- **macOS memory semantics:** the RAM pill is an estimate, not Activity Monitor memory pressure.
- **Containerized Kookr:** Node memory totals may not match cgroup limits. Kookr is a local desktop app in v1, so this is documented but not solved.

## Alternatives Considered

### Use `systeminformation` immediately

Rejected for v1. It would make richer data easy, but the first release only needs CPU/RAM/server responsiveness. Built-in Node APIs are enough and remove a dependency from the critical local dashboard path.

### Use `pidusage` immediately

Rejected for v1. Per-agent process accounting is the natural next question after host pressure is visible, but correct attribution requires process-tree ownership rules for dtach sessions and child processes. This belongs in a separate V2 design.

### Add load average to the UI

Rejected for v1. Load average is useful for operators but ambiguous for this product surface, especially if normalized by `availableParallelism`. CPU percent and event-loop delay answer the user-facing question more directly.

### Add resource data to the main snapshot

Rejected. Resource telemetry has a different cadence from agent state and should not inflate or trigger task snapshots.

### Add charts

Rejected for v1. A single current pressure signal is enough to explain slow streaming. Charts require history retention, controls, and more visual space.

## V2 Path

- Per-agent or per-task attribution using `pidusage` plus terminal-session process ownership.
- Disk free/used for the workspace or host using a platform-safe probe.
- Historical mini-chart if users need trend context.
- Richer macOS memory semantics if the simple RAM estimate produces misleading real-world behavior.
- Single-core saturation tooltip using per-core deltas if aggregate CPU hides real slowdowns.

## Files to Change

- `src/core/system-resource-metrics.ts`
- `src/core/system-resource-metrics.test.ts`
- `src/server/system-resource-sampler.ts`
- `src/server/resource-status-service.ts`
- `src/server/bootstrap/start-background-services.ts`
- `src/server/ws-connection-handler.ts`
- `src/shared/contracts/messages.ts`
- `src/shared/protocol.ts`
- `src/frontend/store/store-types.ts`
- `src/frontend/store/slices/system-status-slice.ts`
- `src/frontend/store/useStore.ts`
- `src/frontend/hooks/useWebSocket.ts`
- `src/frontend/resource-status.ts`
- `src/frontend/components/StatusBar.tsx`
- `src/frontend/components/status-bar-reflection.test.ts` or a new focused StatusBar test
- `src/frontend/styles.css`

## Test Plan

- Unit test CPU delta math with fixed fake CPU samples.
- Unit test first sample, topology change, negative delta, zero delta, and sleep/resume reset.
- Unit test RAM percentage and unavailable memory.
- Unit test event-loop value conversion from nanoseconds to milliseconds in the server sampler.
- Service test with fake timers: immediate sample, cadence sample, no overlap, latest-status cache, stop cleanup, no broadcast after stop, sampler error broadcasts unavailable snapshot, first event-loop sample can be unavailable, simulated blocking stall affects event-loop/timer-drift fields.
- WebSocket connection test: latest cached `resourceStatus` is sent to a new client after the initial snapshot.
- Store/hook test: valid `resourceStatus` handling records `resourceStatusReceivedAtMs`; invalid payloads are ignored and do not overwrite the previous status.
- Runtime guard tests: missing `status`, wrong `source.kind`, non-finite numbers, unknown unavailable reasons, null fields.
- Component test status bar render states: normal, critical, unavailable, stale timer with no new messages, compact/mobile, high event-loop delay visible.
- Visual/E2E check for narrow width so resource pills do not crowd reflection or status controls.
- Linux and macOS probe output in the PR description for CPU counters, total/free memory, and event-loop delay.
- `pnpm build:server`
- `pnpm test -- system-resource StatusBar useStore ws-connection`
- `pnpm build`

## Rollout

This can ship in one PR:

1. Add shared contract and core metrics tests.
2. Add server sampler/service and background-service lifecycle.
3. Add WebSocket latest-status send on connect.
4. Add frontend store handling.
5. Add status bar rendering.

No migration is required because no data is persisted.

## Open Questions

- What exact RAM low-free-memory floor should pair with high RAM percentage after Linux/macOS probes?
- Should the event-loop marker say `Loop`, `Lag`, or `Kookr lag` in the status bar?
- Is compact/mobile `CPU 42 * RAM 68` readable enough, or should resource pills hide entirely below a narrower breakpoint?

## Critic Feedback Incorporated

### Round 1

- boundary-critic 2026-05-13: incorporated. Split pure metrics from OS sampling, removed `NodeJS.Platform` from the shared DTO, prevented core from importing shared wire types, moved lifecycle to `startBackgroundServices`, added a dedicated system-status frontend slice, and clarified `protocol.ts` re-export.
- failure-mode-analyst 2026-05-13: incorporated. Stale state now uses client receive time; CPU baseline resets on topology changes, invalid deltas, and sleep/resume gaps; sampler errors fail open; tests cover lifecycle and malformed/unavailable states.
- design-minimalist 2026-05-13: incorporated with one deliberate exception. The DTO now sends raw values, frontend owns severity, hostname/load/env flag were removed, and tooltip detail was reduced. Exception: event-loop delay stays in v1 because it directly explains slow dashboard/streaming with a built-in API.
- socratic-challenger 2026-05-13: incorporated. Added success criteria, source identity, compact-mode rules, first-sample behavior, always-on sampling rationale, typed unavailable reasons, and lifecycle/broadcast tests.
- ambition-amplifier 2026-05-13: partially incorporated. Added event-loop delay and optional Kookr process memory as lean v1 detail. Rejected overall pressure rollup because it would reintroduce backend-owned health semantics; deferred per-agent attribution and disk to V2.
- design-experimenter 2026-05-13: incorporated. Added empirical grounding, Node docs references, local probe findings, RAM wording caveat, and macOS verification gap.

### Round 2

- boundary-critic 2026-05-13: incorporated. Specified composition-root wiring for cached status replay, nested host/server metrics in the DTO, kept event-loop conversion out of core, and added frontend runtime guard/normalizer.
- failure-mode-analyst 2026-05-13: incorporated. Added frontend stale timer behavior, monotonic sample-gap measurement, explicit event-loop histogram lifecycle, sampler-error unavailable snapshot behavior, malformed-payload tests, and macOS probe merge gate.
- design-minimalist 2026-05-13: partially incorporated. Dropped `maxCoreUsagePercent`, moved single-core saturation to V2, removed core threshold helpers, and changed compact mode to a fixed mini pill. Rejected removing process memory and typed unavailable reasons because round-2 ambition/failure feedback showed they are cheap and useful for distinguishing Kookr slowness from host pressure.
- socratic-challenger 2026-05-13: incorporated. Moved macOS probe from open question to PR acceptance gate, specified monotonic timing, added `sampleGapMs`/`timerDriftMs`, softened RAM warning semantics, and added keyboard/touch accessibility requirements.
- ambition-amplifier 2026-05-13: incorporated. Made severe event-loop delay visible, made process memory mandatory tooltip/detail, added diagnostic tooltip copy requirement, and clarified per-task attribution as the first V2 follow-up after host pressure is visible.

### Round 3

- boundary-critic 2026-05-13: no substantive boundary findings remained.
- design-minimalist 2026-05-13: no substantive over-scope findings remained.
- failure-mode-analyst 2026-05-13: incorporated. Removed the R2/R15 macOS-support contradiction and picked a single malformed-payload behavior: ignore invalid messages and let the freshness timer stale old data.
- socratic-challenger 2026-05-13: incorporated. Clarified that short event-loop stalls should not blank CPU; only sleep/resume-sized sample gaps reset the CPU baseline. Made process-memory tooltip wording consistent with R10.
