# MBSE Documentation Layout

Use this exact tree for all system-model documents.

```text
docs/system-models/
  INDEX.md
  00-scope-and-method.md
  01-system-context.md
  02-capability-map.md
  03-container-view.md
  04-runtime-interactions.md
  05-state-machine-catalog.md
  06-boundary-and-responsibility-smells.md
  07-decomposition-candidates.md
  subsystems/
    INDEX.md
    <subsystem-slug>/
      00-subsystem-summary.md
      01-component-view.md
      02-key-sequences.md
      03-state-machines.md
      04-boundary-smells.md
```

## Stable Naming Rules

- Keep numeric prefixes exactly as shown.
- Use lowercase hyphenated subsystem slugs: `supervisor-agent`, `agent-adapter`, `attention-router`.
- Update files in place. Do not create timestamped or suffixed variants.

## Top-Level File Contracts

### `INDEX.md`
- Purpose
- Model stack
- Current hotspot summary table
- Subsystem catalog
- Last refresh scope

### `00-scope-and-method.md`
- Purpose
- System in scope
- Out of scope
- Evidence sources
- Modeling method
- Confidence and limitations

### `01-system-context.md`
- Purpose
- Context diagram
- External actors and systems
- System mission and boundaries
- Evidence
- Observed smells

### `02-capability-map.md`
- Purpose
- Capability decomposition diagram
- Capability-to-subsystem table
- Overlap and ambiguity notes
- Evidence
- Observed smells

### `03-container-view.md`
- Purpose
- Runtime/container diagram
- Container responsibility table
- Data and control ownership notes
- Evidence
- Observed smells

### `04-runtime-interactions.md`
- Purpose
- 3-7 key sequence diagrams
- Interaction summary table
- Cross-cutting bottlenecks
- Evidence
- Observed smells

### `05-state-machine-catalog.md`
- Purpose
- Major stateful entities
- State diagrams or state tables
- Transition ownership table
- Illegal or ambiguous transitions
- Evidence
- Observed smells

### `06-boundary-and-responsibility-smells.md`
- Purpose
- Responsibility overlap findings
- Ambiguous ownership findings
- Duplicated control findings
- Mixed abstraction findings
- Evidence

### `07-decomposition-candidates.md`
- Purpose
- Candidate boundary changes
- Benefit / risk / evidence table
- Suggested ordering
- Deferred candidates

## Subsystem File Contracts

### `subsystems/INDEX.md`
- Subsystem catalog
- Priority / hotspot rationale
- Status of decomposition coverage

### `00-subsystem-summary.md`
- Purpose
- Scope
- Owned responsibilities
- Key dependencies
- Non-goals
- Evidence
- Observed smells

### `01-component-view.md`
- Purpose
- Simplified component or class/module diagram
- Component responsibility table
- Interaction/ownership notes
- Evidence
- Observed smells

### `02-key-sequences.md`
- Purpose
- 2-4 key sequences
- Failure or recovery variant where relevant
- Handoff or orchestration notes
- Evidence
- Observed smells

### `03-state-machines.md`
- Purpose
- Subsystem-specific state diagrams or state tables
- Transition ownership
- Edge-case transitions
- Evidence
- Observed smells

### `04-boundary-smells.md`
- Purpose
- Overlaps
- Ambiguities
- Mixed concerns
- Split or extraction candidates
- Evidence

## Update Rules

- Refresh top-level files before subsystem files.
- Only create subsystem folders for hotspots or core control-plane areas.
- If a file is not in scope for the current run, leave it untouched.
- Keep an explicit `Evidence` section with concrete repo paths.
- Keep a short `Observed smells` section even if the answer is "none in current scope."
