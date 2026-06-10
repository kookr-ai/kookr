---
name: mbse-system-modeling
description: "Explore the current system and generate or update multi-level architecture documentation using an MBSE-lite approach: system context, capability map, containers, runtime sequences, state machines, subsystem decompositions, and boundary-smell analysis."
keywords:
  - mbse
  - system modeling
  - reverse architecture
  - system design documentation
  - context diagram
  - sequence diagram
  - class diagram
  - state machine
  - responsibility map
  - decomposition
related:
  - monorepo-architecture
  - domain-driven-design
  - state-machine-workflow-patterns
  - event-driven-messaging-patterns
  - requirements-engineering
---

# MBSE System Modeling

Use this skill when the goal is to understand the current system design through multiple views and abstraction levels, not to propose a future architecture first.

## When to Use

- System understanding is harder than implementation.
- Responsibilities, scopes, or subsystem boundaries feel ambiguous.
- You need diagrams and structured views of the current design.
- You want to reveal overlaps, duplicated control, or mixed abstraction levels.
- A refactor or RFC needs an evidence-backed model of the system as it exists.

## Core Principle

Model the system **as-is**, not as intended.

Start broad, then decompose only the hotspots. Keep filenames and section headings stable so later runs update existing documents instead of inventing new ones.

## Output Layout

All generated or updated docs live under:

`docs/system-models/`

Read [references/layout.md](references/layout.md) before writing. It defines the exact tree, file names, and required sections.

If the scaffold does not exist yet, initialize it:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/init_mbse_docs.py" --root $HOME/git/kookr
```

To scaffold specific hotspot subsystems:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/init_mbse_docs.py" \
  --root $HOME/git/kookr \
  --subsystem supervisor-agent \
  --subsystem agent-adapter \
  --subsystem attention-router
```

## Modeling Standards

Read [references/standards.md](references/standards.md) before drafting diagrams.

Non-negotiable rules:

- Prefer C4-style hierarchy for structural views: context -> containers -> components.
- Use Mermaid in Markdown for diagrams unless a table is clearer.
- Label relationships as `command`, `query`, `event`, `state sync`, or `artifact flow`.
- Use real repo terms and file/package names, not invented abstractions.
- Every model file must include an `Evidence` section with concrete paths.
- Every model file must include `Observed Smells` or explicitly say none were found.
- Keep diagrams readable: split views before they exceed roughly 15-20 nodes.
- Class/module diagrams are for hotspot subsystems only, not the whole repo.

## Workflow

### 1. Define Scope

Decide whether this run is:

- full system refresh
- top-level refresh only
- hotspot decomposition for 1-3 subsystems

Start with top-level docs unless they are already current.

### 2. Collect Evidence Progressively

Use cheap signals first:

- package and folder inventories
- route and service lists
- manifests (`services.yml`, `subsystem-manifest.yml`)
- key entrypoints
- a few hotspot files

Only then read deeper implementation files.

### 3. Refresh Top-Level Models In Order

Update these first:

1. `00-scope-and-method.md`
2. `01-system-context.md`
3. `02-capability-map.md`
4. `03-container-view.md`
5. `04-runtime-interactions.md`
6. `05-state-machine-catalog.md`
7. `06-boundary-and-responsibility-smells.md`
8. `07-decomposition-candidates.md`

Do not start subsystem deep-dives until the top-level story is coherent.

### 4. Select Hotspot Subsystems

Choose subsystems with one or more of:

- god files / oversized coordinators
- duplicated control logic
- unclear state ownership
- mixed policy + transport + persistence concerns
- repeated operator confusion

Create or update subsystem folders only for those hotspots.

### 5. Decompose Each Hotspot

For each subsystem:

1. summarize purpose and scope
2. draw a component/module view
3. document 2-4 key sequences
4. capture state machines only if stateful behavior matters
5. list boundary smells and split candidates

### 6. Keep Stable Headings

When rerunning the skill:

- update existing files in place
- preserve stable section headings
- add evidence and dates
- avoid creating alternate versions like `-v2`, `-final`, `-draft2`

### 7. Diagnose, Don't Just Describe

Each modeling pass should leave the reader with:

- what the subsystem owns
- what it depends on
- where boundaries leak
- where control is duplicated
- what decomposition would reduce complexity

## Required Deliverables

At minimum, each run should leave:

- updated `docs/system-models/INDEX.md`
- updated top-level views for the scoped area
- updated hotspot subsystem docs if decomposition was in scope
- explicit smell findings and decomposition candidates

## Common Pitfalls

- Drawing target architecture instead of current architecture
- Modeling everything at one level of detail
- Making diagrams without evidence-backed narrative
- Creating many one-off files instead of updating the fixed layout
- Turning the docs into a changelog rather than a model
- Confusing runtime containers with code packages

## Final Output Format

```text
System modeling updated in docs/system-models/

Scope:
- <top-level refresh / hotspot decomposition>

Views updated:
- <file>
- <file>

Hotspots modeled:
- <subsystem>

Primary smells found:
- <smell>
- <smell>

Recommended decomposition candidates:
- <candidate>
- <candidate>
```

## See Also

- [[monorepo-architecture]]
- [[domain-driven-design]]
- [[state-machine-workflow-patterns]]
- [[event-driven-messaging-patterns]]
- [[requirements-engineering]]
