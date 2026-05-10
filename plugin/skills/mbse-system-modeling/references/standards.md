# MBSE Modeling Standards

This skill uses an MBSE-lite reverse-architecture approach:

- **C4-inspired** for context, containers, and components
- **UML-style behavior views** via Mermaid `sequenceDiagram`, `stateDiagram-v2`, and `classDiagram`
- **Evidence-first documentation** grounded in real code, manifests, routes, and runtime contracts

## Modeling Rules

### Model As-Is

- Describe the system that exists now.
- If the intended architecture differs, note that as a smell or gap.
- Do not rename components into cleaner names unless the repo already uses them.

### One View, One Job

- Context view: system boundary and externals
- Capability view: what the system does
- Container view: runtime units and ownership
- Sequence view: how work actually flows
- State view: legal transitions and controllers
- Component/class view: hotspot internals only

### Relationship Labels

Label edges with one of:

- `command`
- `query`
- `event`
- `state sync`
- `artifact flow`

If the relationship is unclear, note that explicitly as ambiguity.

### Diagram Guidance

- Prefer Mermaid blocks in Markdown.
- Split diagrams before they become unreadable.
- Keep the main success path primary; show failure variants separately.
- For class/module diagrams, model only coordinators, services, repositories, handlers, and major dependencies.
- For container diagrams, use runtime processes/services, not TS packages.

### Evidence Rules

Every model file should cite concrete repo evidence such as:

- entrypoints
- route files
- service manifests
- composition roots
- state-machine code
- repositories
- workflow definitions

Use file paths, not vague descriptions.

### Smell Categories

Use these labels consistently:

- `responsibility overlap`
- `ambiguous ownership`
- `duplicated control`
- `mixed abstraction`
- `policy/transport coupling`
- `state ownership leak`
- `boundary erosion`

### Update Discipline

- Update existing files instead of creating alternatives.
- Preserve headings from the layout contract.
- Remove statements that are no longer evidence-backed.
- Keep narrative concise; the model should improve comprehension, not become another dump.
