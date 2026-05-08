---
name: Pre-Refactor Assessment
description: Analyze a target module's dependencies, smells, and consumers before refactoring
parameters:
  - name: targetModule
    description: Path to the module or directory to refactor (e.g., src/core/tasks.ts or src/server/)
    required: true
  - name: refactorGoal
    description: Brief description of what you plan to change (e.g., "split task store into read and write modules")
    required: true
checklist:
  - Identified all consumers (importers) of the target module
  - Mapped all dependencies (imports) of the target module
  - Checked for circular dependencies involving the target
  - Assessed architecture smells in the target module
  - Evaluated interface width and abstraction levels of the target's exports
  - Identified which consumers use which exports (utilization map)
  - Produced safety report with blast radius assessment
  - Identified safe refactoring sequence (what to change first)
---

## Objective

Before refactoring **{{targetModule}}**, produce a safety report that maps the blast radius, identifies risks, and recommends a safe change sequence. The planned refactoring: **{{refactorGoal}}**.

## Context

- **Target**: `{{targetModule}}`
- **Goal**: {{refactorGoal}}
- **Layer rules**: `core/` → `adapters/` → `server/` → `frontend/` (inner depends on nothing outer)

## Phase 1 — Map the Target

### 1A. Read the target
Read `{{targetModule}}` (and all files in the directory if it's a directory). Understand:
- What it exports (functions, types, constants)
- What it imports (internal and external dependencies)
- Its responsibilities (summarize in 1-2 sentences per file)

### 1B. Map consumers (who depends on the target)
Grep for all files that import from `{{targetModule}}`. For each consumer:
- Which specific exports does it use?
- How tightly coupled is it? (uses 1 export vs. 10; uses types only vs. runtime values)
- Would the planned refactoring break this consumer?

### 1C. Map dependencies (what the target depends on)
List all internal imports from the target. For each:
- Is this a stable dependency (types, core utilities) or unstable (frequently changing)?
- Does the dependency direction respect layer rules?

### 1D. Check for cycles
Starting from the target, trace the import graph to see if any dependency chain leads back to the target. Direct cycles are critical; transitive cycles are concerning.

## Phase 2 — Assess Current Health

### 2A. Smell scan (focused on target)
Check the target for:
- God module (too many responsibilities, too many exports)
- Mixed abstraction levels in exports
- Feature envy (reaching into other modules' internals)
- Inappropriate intimacy with specific other modules

### 2B. Interface analysis
For the target's exports:
- How many consumers use each export? (some exports may be unused)
- Are exports at consistent abstraction levels?
- Are there leaky abstractions (implementation details in public types)?

### 2C. Test coverage
- What tests exist for the target? Read them.
- Are they testing behavior (safe during refactor) or implementation details (will break)?
- Are there characterization tests that pin current behavior?

## Phase 3 — Blast Radius Assessment

Based on the mapping, answer:

1. **How many files will be touched?** Direct consumers + their consumers (transitive impact)?
2. **Which layers are affected?** Same-layer only (contained) or cross-layer (risky)?
3. **What's the worst-case breakage?** If the refactoring introduces a subtle bug, where would it surface?
4. **Are there tests that will catch regressions?** Or are we flying blind?
5. **Can this be done incrementally?** Or is it all-or-nothing?

## Phase 4 — Produce Safety Report

Write to `/tmp/kookr-refactor-assessment.md`:

```markdown
## Pre-Refactor Assessment: {{targetModule}}
**Goal**: {{refactorGoal}}
**Date**: [today]

### Blast Radius
- Direct consumers: N files
- Transitive impact: N files
- Layers affected: [list]
- Risk level: [Low/Medium/High/Critical]

### Consumer Map
| Consumer | Exports Used | Coupling | Will Break? |
|----------|-------------|----------|-------------|

### Dependency Map
| Dependency | Direction | Stability | Layer Rule |
|-----------|-----------|-----------|------------|

### Current Smells (pre-existing, not caused by refactor)
[findings that the refactoring might fix or worsen]

### Test Safety Net
- Tests that will catch regressions: [list]
- Tests that will break (implementation-coupled): [list]
- Untested areas (blind spots): [list]

### Recommended Sequence
1. [First safe step — e.g., "extract types into separate file"]
2. [Second step — e.g., "move read functions, update imports"]
3. [Third step — ...]
[Each step should be independently committable and testable]

### Warnings
[Anything that makes this refactoring riskier than it looks]
```

## Anti-Patterns

- Don't start the refactoring in this playbook. This is assessment only — produce the report and stop.
- Don't propose a refactoring sequence that requires updating >15 files in one step. Break it smaller.
- Don't ignore test coupling. If tests will break on a safe refactor, note that as a risk (fix the tests first, or accept the test churn).
- Don't assess only the happy path. Consider: what if the refactoring is half-done and we need to stop? Is the codebase in a valid state?
