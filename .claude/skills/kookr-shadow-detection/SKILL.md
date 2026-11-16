---
name: kookr-shadow-detection
description: Shadow detection registry and report for measuring stuck-detection strategies against the real detector on live traffic, while tuning a strategy and after it ships
keywords: shadow, detection, canary, validation, anomaly, stuck, strategy, coverage, precision, report
---

# Shadow Detection System

Kookr has a shadow detection infrastructure for measuring stuck-detection strategies. New strategies run alongside the real detector: they see the same data but their verdicts are **logged, not acted upon**. An offline report compares shadow vs. real verdicts using interval-based coverage metrics.

## Purpose

The real anomaly detector (needs_input, permission_blocked, stale_agent, etc.) drives the attention queue. The shadow registry runs other strategies (pane pattern matching, PID monitoring, HTTP push) beside it on the same data and logs what they would have flagged, so you can compare them with the real detector:

1. **Registered strategies log verdicts** — they evaluate live data and write to `~/.kookr/shadow-detection.jsonl`
2. **The shadow report compares** — it reconstructs anomaly intervals and computes coverage, precision and latency against the real detector

**Ship finished detection switched on (issue #3936).** The shadow registry is a measuring tool, not a waiting room. Use it while you tune a strategy on your own instance, and after a strategy ships to watch how it does. Do not merge a finished strategy that only runs in shadow and then wait for a soak period (for example 48 hours) or a threshold before it may act. When its tests pass, wire it into the real detector in the same pull request, keep a kill switch that turns it off, and keep its shadow logging as the after-ship measurement. If the report shows it misfiring, fix it or revert it.

## Shadow Report Endpoint

```bash
# JSON format (for programmatic analysis)
curl -s http://localhost:4800/api/shadow-report | jq .

# Text format (for human reading)
curl -s "http://localhost:4800/api/shadow-report?format=text"
```

### Response (JSON)

```json
{
  "generatedAt": "2026-03-28T12:00:00.000Z",
  "observationWindow": { "startMs": 1743163200000, "endMs": 1743249600000 },
  "strategies": [
    {
      "source": "pane_semantics",
      "totalObservationMs": 86400000,
      "realIntervals": 14,
      "matchedIntervals": 14,
      "unmatchedShadowIntervals": 4,
      "coverage": 0.942,
      "precision": 0.918,
      "realAnomalyMs": 120000,
      "shadowAnomalyMs": 131000,
      "overlapMs": 113000,
      "detectionDelays": [4100, 4300, 3900, 8100],
      "clearingDelays": [3100, 3200, 2800, 7400],
      "heartbeatCount": 1247,
      "transitionCount": 36
    }
  ],
  "totalEntries": 1283,
  "parseErrors": 0
}
```

### Key Metrics

| Metric | What it measures | Target |
|--------|-----------------|---------------------|
| `coverage` (recall) | Fraction of real-anomaly-time that shadow also flagged | >= 0.95 (95%) |
| `precision` | Fraction of shadow-anomaly-time that was actual anomaly | >= 0.90 (90%) |
| `matchedIntervals` / `realIntervals` | Did shadow detect every anomaly the real detector found? | 100% |
| `unmatchedShadowIntervals` | Anomalies shadow found that real missed | Review each — may be new capabilities |
| `detectionDelays` | How much later shadow detected (ms, positive = lag) | Median < 10s for tick-based strategies |

### Interpreting Results

- **Coverage 94%, precision 92%**: on target — the gap is tick-based lag (expected for 5s watchdog).
- **Coverage 100%, precision 60%**: Shadow has too many false positives — tune detection logic.
- **Coverage 50%**: the strategy is missing half of real anomalies — a detection gap to fix (or revert, if it already acts).
- **`unmatchedShadowIntervals` > 0 with `realIntervals` all matched**: Shadow detects new things real can't (e.g., shell_prompt for crashes). This is the point — new capability.
- **No data (`strategies` empty)**: No shadow strategies are registered yet.

## How It Works Internally

### Log Format

The shadow log (`~/.kookr/shadow-detection.jsonl`) has two entry types:

**Heartbeats** (every watchdog tick, ~5s per agent per strategy):
```json
{"kind":"heartbeat","timestamp":"...","agentId":"kookr-abc","source":"pane_semantics","shadowState":null,"realState":"needs_input"}
```

**Transitions** (when shadow state changes):
```json
{"kind":"transition","timestamp":"...","agentId":"kookr-abc","source":"pane_semantics","transition":"entered_anomaly","anomalyType":"needs_input","realState":{"anomaly":"needs_input","since":"..."},"signals":{}}
```

### Architecture

```
Watchdog tick fires
    |
    |-- Real detector runs --> attention queue (drives UI)
    |
    '-- Shadow registry runs all strategies
         |-- strategy.evaluate(agentId, {paneText, realAnomaly})
         |-- Compare with previous state --> log transition if changed
         '-- Log heartbeat with current shadow + real state
```

Shadow strategies never enqueue anomalies, never affect the UI, never block the watchdog. Fire-and-forget logging — if the write fails, real detection is unaffected.

## Implementing a New Shadow Strategy

Create a class implementing `ShadowStrategy`:

```typescript
import type { ShadowStrategy, ShadowInputs } from '../core/shadow-detector.js';
import type { Anomaly } from '../core/types.js';

export class MyNewStrategy implements ShadowStrategy {
  readonly source = 'pane_semantics'; // or 'process_liveness' or 'http_push'

  evaluate(agentId: string, inputs: ShadowInputs): Anomaly | null {
    // inputs.paneText — terminal pane content (already captured by watchdog)
    // inputs.realAnomaly — what the real detector currently says
    // Return an Anomaly if your strategy detects something, null if healthy.
    return null;
  }
}
```

Register it in `src/server/index.ts`:

```typescript
import { MyNewStrategy } from '../core/my-strategy.js';

// After creating shadowRegistry:
shadowRegistry.register(new MyNewStrategy());
```

The registry handles state tracking, transition detection, and logging automatically.

## Workflow for a New Strategy

1. Implement the strategy with unit tests built from real hook logs and pane captures (see the repo rule "Verify with real data")
2. While tuning, register it with `shadowRegistry` on your own instance and read the report: `curl -s "http://localhost:4800/api/shadow-report?format=text"`
3. When its tests pass, wire it into the real detector in the same pull request, with a kill switch that turns it off; leave it registered in the shadow registry too
4. After it ships, read the report to measure it. Coverage >= 95% and precision >= 90% against the old detector are the targets to compare with, not a gate before it may act
5. If it misfires: investigate `unmatchedShadowIntervals` and `detectionDelays`, then fix the strategy or revert it
