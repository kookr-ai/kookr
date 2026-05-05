#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path


TOP_LEVEL_FILES = {
    "INDEX.md": """# System Models

## Purpose

Reverse-architecture documentation for the current system using stable multi-level views.

## Model Stack

- [00 Scope And Method](00-scope-and-method.md)
- [01 System Context](01-system-context.md)
- [02 Capability Map](02-capability-map.md)
- [03 Container View](03-container-view.md)
- [04 Runtime Interactions](04-runtime-interactions.md)
- [05 State Machine Catalog](05-state-machine-catalog.md)
- [06 Boundary And Responsibility Smells](06-boundary-and-responsibility-smells.md)
- [07 Decomposition Candidates](07-decomposition-candidates.md)
- [Subsystems](subsystems/INDEX.md)

## Current Hotspots

| Subsystem | Why It Matters | Status |
|---|---|---|
| _TBD_ | _TBD_ | not-modeled |

## Last Refresh Scope

- _TBD_
""",
    "00-scope-and-method.md": """# Scope And Method

## Purpose

## System In Scope

## Out Of Scope

## Evidence Sources

## Modeling Method

## Confidence And Limitations
""",
    "01-system-context.md": """# System Context

## Purpose

## Context Diagram

```mermaid
flowchart LR
  A[Actor]
  S[System]
  X[External System]
  A -->|command| S
  S -->|query| X
```

## External Actors And Systems

## System Mission And Boundaries

## Evidence

## Observed Smells
""",
    "02-capability-map.md": """# Capability Map

## Purpose

## Capability Decomposition Diagram

```mermaid
flowchart TD
  Root[System Capabilities]
  C1[Capability A]
  C2[Capability B]
  Root --> C1
  Root --> C2
```

## Capability To Subsystem Table

## Overlap And Ambiguity Notes

## Evidence

## Observed Smells
""",
    "03-container-view.md": """# Container View

## Purpose

## Container Diagram

```mermaid
flowchart LR
  UI[UI]
  API[API]
  DB[(DB)]
  UI -->|command| API
  API -->|query| DB
```

## Container Responsibility Table

## Data And Control Ownership Notes

## Evidence

## Observed Smells
""",
    "04-runtime-interactions.md": """# Runtime Interactions

## Purpose

## Key Sequences

```mermaid
sequenceDiagram
  participant A as Actor
  participant S as Service
  A->>S: command
  S-->>A: response
```

## Interaction Summary Table

## Cross-Cutting Bottlenecks

## Evidence

## Observed Smells
""",
    "05-state-machine-catalog.md": """# State Machine Catalog

## Purpose

## Major Stateful Entities

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Running
  Running --> Completed
  Running --> Failed
```

## Transition Ownership Table

## Illegal Or Ambiguous Transitions

## Evidence

## Observed Smells
""",
    "06-boundary-and-responsibility-smells.md": """# Boundary And Responsibility Smells

## Purpose

## Responsibility Overlap Findings

## Ambiguous Ownership Findings

## Duplicated Control Findings

## Mixed Abstraction Findings

## Evidence
""",
    "07-decomposition-candidates.md": """# Decomposition Candidates

## Purpose

## Candidate Boundary Changes

| Candidate | Benefit | Risk | Evidence |
|---|---|---|---|
| _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Suggested Ordering

## Deferred Candidates
""",
}


SUBSYSTEM_FILES = {
    "00-subsystem-summary.md": """# Subsystem Summary

## Purpose

## Scope

## Owned Responsibilities

## Key Dependencies

## Non-Goals

## Evidence

## Observed Smells
""",
    "01-component-view.md": """# Component View

## Purpose

## Component Diagram

```mermaid
flowchart TD
  A[Coordinator]
  B[Service]
  C[Repository]
  A -->|command| B
  B -->|query| C
```

## Component Responsibility Table

## Interaction And Ownership Notes

## Evidence

## Observed Smells
""",
    "02-key-sequences.md": """# Key Sequences

## Purpose

## Primary Sequence

```mermaid
sequenceDiagram
  participant A as Caller
  participant B as Subsystem
  A->>B: command
  B-->>A: result
```

## Failure Or Recovery Variant

## Handoff Notes

## Evidence

## Observed Smells
""",
    "03-state-machines.md": """# State Machines

## Purpose

## State Diagram

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Active
  Active --> Idle
  Active --> Failed
```

## Transition Ownership

## Edge-Case Transitions

## Evidence

## Observed Smells
""",
    "04-boundary-smells.md": """# Boundary Smells

## Purpose

## Overlaps

## Ambiguities

## Mixed Concerns

## Split Or Extraction Candidates

## Evidence
""",
}


def write_if_missing(path: Path, content: str, dry_run: bool) -> str:
    if path.exists():
        return "exists"
    if dry_run:
        return "create"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return "create"


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize MBSE system-model docs scaffold.")
    parser.add_argument("--root", required=True, help="Repo root")
    parser.add_argument(
        "--docs-dir",
        default="docs/system-models",
        help="Documentation directory relative to repo root",
    )
    parser.add_argument(
        "--subsystem",
        action="append",
        default=[],
        help="Subsystem slug to scaffold under subsystems/",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print planned actions only")
    args = parser.parse_args()

    repo_root = Path(args.root).resolve()
    docs_dir = repo_root / args.docs_dir
    subsystem_index = docs_dir / "subsystems" / "INDEX.md"

    print(f"Scaffolding MBSE docs under {docs_dir}")
    for rel_path, content in TOP_LEVEL_FILES.items():
        status = write_if_missing(docs_dir / rel_path, content, args.dry_run)
        print(f"{status:>6} {docs_dir / rel_path}")

    subsystem_index_content = """# Subsystems

## Catalog

| Subsystem | Priority | Status |
|---|---|---|
| _TBD_ | _TBD_ | not-modeled |
"""
    status = write_if_missing(subsystem_index, subsystem_index_content, args.dry_run)
    print(f"{status:>6} {subsystem_index}")

    for slug in args.subsystem:
        for rel_path, content in SUBSYSTEM_FILES.items():
            target = docs_dir / "subsystems" / slug / rel_path
            status = write_if_missing(target, content, args.dry_run)
            print(f"{status:>6} {target}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
