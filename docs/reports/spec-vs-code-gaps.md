# Spec vs Code Gap Report

> Generated 2026-03-25 by comparing `docs/requirements.md`, `docs/architecture.md`, `docs/features.md` against `src/`.

---

## HIGH Severity

### GAP-1: Monitor event accumulation — anomaly detection broken in production

| | |
|---|---|
| **Spec says** | R2.2: Same tool call repeated ≥5 times triggers `stuck_loop`. R2.3: Same error repeated ≥3 times triggers `repeated_error`. Detection runs on a window of recent events per agent. |
| **Code does** | `Monitor.processEvents()` (`src/core/monitor.ts:31`) **replaces** the event list: `this.agentEvents.set(agentId, events)`. The caller in `src/server/index.ts:81` passes a single-element array `[event]` for each hook event. The monitor therefore always holds **at most 1 event** per agent. Thresholds requiring 3+ or 5+ events can never be reached in the live server. |
| **Impact** | `stuck_loop` and `repeated_error` anomalies will never fire in production. Only `needs_input` and `permission_blocked` (which check the last event only) will work. Core anomaly detection is silently broken. Tests pass because `loop.test.ts` calls `processEvents()` with pre-built multi-event arrays, bypassing the real wiring. |
| **Fix** | Accumulate events in `Monitor.processEvents()` (append to existing list, cap at `windowSize`) instead of replacing. Or accumulate in `index.ts` before calling `processEvents()`. |

### GAP-2: Transcript JSONL tailing not wired

| | |
|---|---|
| **Spec says** | Architecture §Adapter Layer: "Three data channels per agent: Transcript JSONL (structured session history, anomaly detection), Hooks (real-time event notifications), tmux capture-pane (terminal display)." R6.2 evidence also references transcript JSONL as a monitoring channel. |
| **Code does** | `src/core/transcript-parser.ts` exists and has tests, but is **never imported** by any server module. Only `hook-watcher.ts` feeds events to the monitor. The transcript JSONL channel is entirely unwired. |
| **Impact** | Events not captured by hooks (e.g., full assistant messages, cost data from `result` entries, historical events on startup) are invisible to the supervisor. Reduces monitoring fidelity, especially after crash recovery where hooks may have been missed but transcript JSONL has the full history. |
| **Fix** | Wire transcript tailing into the adapter/monitor pipeline, or explicitly defer this channel in the spec and mark R1.2 evidence accordingly. |

---

## MEDIUM Severity

### GAP-3: Stuck loop threshold off-by-one

| | |
|---|---|
| **Spec says** | R2.2: "Same tool call repeated ≥ threshold (default: 5) times triggers `stuck_loop` anomaly." |
| **Code does** | `anomaly-detector.ts:108` checks `maxConsecutive > threshold` (strictly greater than). With threshold=5, this requires **6+ repetitions**, not 5. |
| **Impact** | Stuck loops detected one iteration later than specified. Minor latency in anomaly detection. Tests confirm the `>` behavior (6 events → stuck, 5 → not stuck), so tests match code but disagree with the spec. |
| **Fix** | Change to `maxConsecutive >= threshold` or update spec to say "> threshold". |

### GAP-4: `respondAndAdvance()` unused in server message handling

| | |
|---|---|
| **Spec says** | R3.3: "After sending a response, the current agent is removed from the attention queue. The frontend auto-selects the next highest-priority agent." Evidence: `attention-queue.ts (respondAndAdvance)`. |
| **Code does** | The `respond` handler in `ws.ts:71-73` only calls `adapter.sendInput()` — it never calls `queue.respondAndAdvance()`. The frontend calls `nextBottleneck()` locally, but the server-side queue is not updated until the next anomaly detection cycle clears the agent (if events change). |
| **Impact** | After responding, the agent stays in the server's attention queue until a subsequent event causes anomaly detection to return null. If events are slow to arrive, stale findings persist. The `respondAndAdvance()` method is only exercised in `loop.test.ts`, never in production. |
| **Fix** | Call `queue.respondAndAdvance(msg.agentId)` in the `respond` case of `MessageRouter.handleMessage()`. |

### GAP-5: `relaunch` WS handler reuses task ID — spec says create new task

| | |
|---|---|
| **Spec says** | R4b.3: "The re-launched task is a new task (new ID), not a mutation of the original." |
| **Code does** | The `relaunch` handler in `ws.ts:113-118` calls `adapter.launch(task.id, msg.prompt, task.cwd)` which adds a new session to the **existing** task. The frontend workaround (DetailPanel opens LaunchDialog which sends a `launch` message) does create a new task, but the WS protocol `relaunch` handler itself violates the spec. |
| **Impact** | If any code path sends a `relaunch` message directly, it mutates the original task instead of creating a new one. The frontend happens to avoid this by using `launch`, but the protocol handler is incorrect. |
| **Fix** | Change the `relaunch` handler to create a new task via `taskStore.createTask()` instead of reusing the old task ID. |

### GAP-6: Broadcast sends `anomaly: null` before snapshot corrects it

| | |
|---|---|
| **Spec says** | R5.5: "State changes reflected in agent list, detail panel, and status bar within 1 second." Anomalies should be visible in real-time updates. |
| **Code does** | `src/server/index.ts:82` broadcasts an inline update with `anomaly: null` immediately after processing each hook event, before the full snapshot broadcast at line 222 sends the correct anomaly state. |
| **Impact** | Frontend briefly receives an "all clear" state for the agent before the snapshot corrects it, causing a visual flash/flicker. Tied to GAP-1: even the snapshot won't show correct anomalies because only 1 event is stored. |
| **Fix** | Remove the inline broadcast at line 82 (the snapshot at line 222 already covers all updates), or compute the anomaly properly before broadcasting. |

### GAP-7: Snooze reason silently discarded

| | |
|---|---|
| **Spec says** | R3.7: "Optional reason can be attached" to snooze. |
| **Code does** | `AttentionQueue.snooze()` accepts `_reason?: string` but discards it (underscore-prefixed). The snoozed entry stores only `{ anomaly, expiresAt }`. |
| **Impact** | Snooze reasons from the frontend are silently lost. No way to recall why an agent was snoozed. |
| **Fix** | Store reason in the snoozed map entry, or remove reason from the spec if not needed for V1. |

---

## LOW Severity (documentation drift)

### GAP-8: Component naming — `AgentList.tsx` and `AgentDetail.tsx` don't exist

| | |
|---|---|
| **Spec says** | Requirements reference `AgentList.tsx` (R3.5, R5.1) and `AgentDetail.tsx` (R3.1, R3.2, R3.4, R5.2) as evidence. Architecture module structure lists both. |
| **Code does** | These components were replaced by `FindingsPanel.tsx` and `DetailPanel.tsx` respectively. No file named `AgentList.tsx` or `AgentDetail.tsx` exists. |
| **Fix** | Update evidence sections in requirements.md and the module structure in architecture.md. |

### GAP-9: Architecture module structure missing several components

| | |
|---|---|
| **Spec says** | Architecture §Module Structure lists 5 frontend components: `AgentList.tsx`, `AgentDetail.tsx`, `StatusBar.tsx`, `LaunchDialog.tsx`, `Toasts.tsx`. |
| **Code does** | Actual components: `FindingsPanel.tsx`, `DetailPanel.tsx`, `TopBar.tsx`, `StatusBar.tsx`, `LaunchDialog.tsx`, `QuickLaunch.tsx`, `Toasts.tsx`, `SentOverlay.tsx`, `TerminalPanel.tsx`. Also missing from diagram: `terminal-bridge.ts` (server), `presentation.ts` (frontend util), `recent-paths.ts` (frontend store). |
| **Fix** | Update the module structure diagram in architecture.md. |

### GAP-10: Architecture WS protocol schema drift

| | |
|---|---|
| **Spec says** | Architecture §Communication defines `snapshot` as `{ type: 'snapshot'; agents: AgentState[] }` and `ClientMessage` without `stop`. |
| **Code does** | `snapshot` includes `serverCwd: string` (added for R4b.1). `ClientMessage` includes `{ type: 'stop'; agentId: string }` (added for R4.2). |
| **Fix** | Update the WS protocol types in architecture.md to match `src/server/ws.ts`. |

### GAP-11: Features F2.8 priority terminology mismatch

| | |
|---|---|
| **Spec says** | F2.8: "V1 priority: stuck > errored > running." |
| **Code does** | Priority order: `stuck_loop` (critical) > `permission_blocked` (warning) > `repeated_error` (warning) > `needs_input` (info). "errored" and "running" are `AgentStatus` values, not anomaly types. |
| **Fix** | Update F2.8 to use anomaly type names. |

### GAP-12: Architecture says "round-robin polling" — code is event-driven

| | |
|---|---|
| **Spec says** | Architecture §Monitoring Policy: "The supervisor uses a round-robin polling strategy by default: it cycles through all managed agents periodically." |
| **Code does** | Monitoring is event-driven: `HookFileWatcher` uses `fs.watch()` on JSONL files and immediately processes new lines. The 5-second `setInterval` in `index.ts` only reconciles tmux session liveness, not event polling. |
| **Fix** | Update architecture.md monitoring policy to describe the event-driven approach. |

### GAP-13: Status bar missing "session cost" element

| | |
|---|---|
| **Spec says** | F5.3/architecture: "queue dots showing triage position, task count, session cost, keyboard shortcut hints." |
| **Code does** | `StatusBar.tsx` shows task count, finding count, and keyboard shortcuts. No cost display. `TopBar.tsx` shows queue dots and connection status — cost is absent from both. |
| **Fix** | Session cost is deferred (R2.5). Update F5.3 description to reflect current state. |

### GAP-14: ~~Resizable divider not implemented~~ — RESOLVED

Conversation panel removed; terminal is now the sole content area in the detail panel. No divider needed.

### GAP-15: Test count inconsistency in requirements

| | |
|---|---|
| **Spec says** | R7.2 evidence: "17 test files, 133 tests, all passing." Summary matrix: "19 test files, 174 tests." |
| **Code does** | Both counts are likely stale — the numbers changed as features were added. |
| **Fix** | Either remove hard-coded counts from requirements or keep them updated via CI. |

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| **HIGH** | 2 | GAP-1 fixed (event accumulation), GAP-2 deferred to V2 (transcript tailing) |
| **MEDIUM** | 5 | All fixed: GAP-3 (threshold), GAP-4 (queue), GAP-5 (relaunch), GAP-6 (broadcast), GAP-7 (snooze reason) |
| **LOW** | 8 | All fixed: GAP-8–15 (documentation updated in architecture.md, features.md, requirements.md) |

**All 15 gaps resolved. 7 code fixes + 1 explicit deferral + 7 doc updates.**
