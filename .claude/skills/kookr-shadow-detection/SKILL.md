---
name: kookr-shadow-detection
description: Shadow detection system for validating new stuck-detection strategies against production traffic before activation
keywords: shadow, detection, canary, validation, anomaly, stuck, strategy, coverage, precision, report
---

# Shadow Detection System

Kookr has a shadow detection infrastructure that lets you safely validate new stuck-detection strategies. New strategies run alongside the real detector: they see the same data but their verdicts are **logged, not acted upon**. An offline report compares shadow vs. real verdicts using interval-based coverage metrics.

## Purpose

The real anomaly detector (needs_input, permission_blocked, stale_agent, etc.) is stable and reliable. When adding new detection strategies (pane pattern matching, PID monitoring, HTTP push), we need to prove they work correctly before activating them. Shadow mode provides this proof:

1. **Strategy runs in shadow mode** — evaluates live data, logs verdicts to `~/.kookr/shadow-detection.jsonl`
2. **Shadow report compares** — reconstructs anomaly intervals, computes coverage/precision/latency
3. **Promotion when validated** — strategy moves from `shadow` to `active` after meeting thresholds

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

| Metric | What it measures | Promotion threshold |
|--------|-----------------|---------------------|
| `coverage` (recall) | Fraction of real-anomaly-time that shadow also flagged | >= 0.95 (95%) |
| `precision` | Fraction of shadow-anomaly-time that was actual anomaly | >= 0.90 (90%) |
| `matchedIntervals` / `realIntervals` | Did shadow detect every anomaly the real detector found? | 100% |
| `unmatchedShadowIntervals` | Anomalies shadow found that real missed | Review each — may be new capabilities |
| `detectionDelays` | How much later shadow detected (ms, positive = lag) | Median < 10s for tick-based strategies |

### Interpreting Results

- **Coverage 94%, precision 92%**: Shadow is ready — the gap is tick-based lag (expected for 5s watchdog).
- **Coverage 100%, precision 60%**: Shadow has too many false positives — tune detection logic.
- **Coverage 50%**: Shadow is missing half of real anomalies — detection gap, not ready.
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

## Workflow for Validating a Strategy

1. Implement the strategy and register it with `shadowRegistry`
2. Deploy to production (shadow mode — no risk)
3. Let it run for >= 48h with >= 10 real anomaly intervals observed
4. Check the report: `curl -s "http://localhost:4800/api/shadow-report?format=text"`
5. If coverage >= 95%, precision >= 90%, and all real intervals matched: promote to active
6. If not: investigate `unmatchedShadowIntervals` and `detectionDelays`, tune the strategy
7. After promotion, shadow logging continues as ongoing validation
