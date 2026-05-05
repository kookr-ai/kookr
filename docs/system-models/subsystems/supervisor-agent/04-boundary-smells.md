# Supervisor Agent — Boundary Smells

## Purpose

Check the supervisor's internal boundaries for design issues.

## Overlaps

None within the supervisor. Detectors, state machine, and explainer have clear responsibilities.

## Ambiguities — Resolved

- **Who resets alert state when the agent self-recovers?** Decision: the supervisor's polling cycle re-evaluates all active anomaly signals on each pass. Detectors return both `detected` and `resolved` signals via the `AnomalySignal` type. When a previously-detected anomaly no longer holds (e.g., the agent broke out of a loop), the detector emits a `resolved` signal. The attention router then transitions the corresponding attention event to `Resolved`. The entity that detects also un-detects — no separate recovery logic needed.

## Mixed Concerns — Resolved

Detection and explanation are separate concerns with a defined interface seam, even though V1 collocates them in each detector's skill file:

```typescript
// Detector returns a signal + context — never the explanation itself
type AnomalySignal = { type: string; context: Record<string, unknown> };

// Explainer turns signal into human-readable text (separate function)
type Explainer = (signal: AnomalySignal) => string;
```

In V1, each skill file provides both a detection pattern and a template-based explainer. The explainer is a pure function that accepts `AnomalySignal` and fills a template. In V2, the template explainer can be swapped for an LLM call without changing detectors — the `AnomalySignal` interface is the seam.

## Split Or Extraction Candidates

| Candidate | When |
|---|---|
| Swap template explainer for LLM-powered explainer | When V2 adds LLM-powered explanations — the `Explainer` interface is already defined |
| Extract state machine into shared core module | If other subsystems need to query agent status directly |

## Evidence

- `docs/architecture.md:68-103` — tier 1 vs tier 2 supervisor design
