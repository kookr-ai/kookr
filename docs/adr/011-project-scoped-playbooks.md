# ADR-011: Project-Scoped Playbooks

## Status

**Accepted** (2026-03-25, by Jean Ibarz)

## Context

Developers repeatedly perform the same multi-step tasks across projects — creating MRs with checklists, checking design-code drift, improving test coverage, running release workflows. These are manual, tedious, and project-specific. Kookr already manages agent lifecycles. Playbooks extend this by letting users define reusable task templates that Kookr can execute as managed agent tasks.

## Decision

Add **project-scoped playbooks** — Markdown files with YAML frontmatter stored in `.kookr/playbooks/` within the project directory.

### Key design choices

1. **Playbooks are task templates, not a new entity.** Triggering a playbook creates a regular Task. The playbook body becomes `task.prompt`, the checklist becomes `task.criteria`. The entire existing system (supervisor, anomaly detection, attention queue, findings panel, task lifecycle) works unchanged.

2. **Playbooks live in the project directory** (`.kookr/playbooks/*.md`). Version-controlled, portable, reviewable. Not in `~/.kookr/` — that would be global and unversioned.

3. **Minimal frontmatter parser, no YAML dependency.** The frontmatter schema is simple and fixed. A ~50-line parser handles it without adding `js-yaml` or `gray-matter`.

4. **Parameter interpolation uses `{{paramName}}`** — simple string replacement. No template engine.

5. **V1 is manual trigger only.** Auto-proposal, scheduling, and trigger conditions are deferred to V2.

### File format

```markdown
---
name: Create staging MR
description: Open a merge request from staging to main
parameters:
  - name: version
    description: Release version tag
    required: true
checklist:
  - CHANGELOG updated
  - CI green
---

## Steps
1. Create MR from staging to main with title "Release {{version}}"
2. Verify checklist items
```

### Architecture

- `src/core/playbook.ts` — Type definitions (`Playbook`, `PlaybookParameter`)
- `src/core/playbook-parser.ts` — Frontmatter parsing + parameter interpolation
- `src/core/playbook-discovery.ts` — Scans `.kookr/playbooks/` for `*.md` files
- `playbookId` optional field on `Task` — records provenance
- New WS messages: `listPlaybooks`, `launchPlaybook`, `playbooks`
- New HTTP endpoint: `GET /api/playbooks?cwd=`
- UI: tabbed Launch Dialog (Manual | Playbooks) with playbook browser

## Consequences

- Users can define reusable workflows as version-controlled files
- No new runtime services — playbooks are read on demand from disk
- The `playbookId` field enables future features (re-trigger, analytics, auto-proposal)
- V2 can add trigger conditions and auto-proposal without breaking V1 playbook files

## Alternatives considered

- **YAML-only format**: rejected because the body (agent prompt) is natural language, which is awkward in YAML
- **Global playbooks in `~/.kookr/`**: rejected because playbooks are project-specific by nature
- **Separate PlaybookStore**: rejected — playbooks create regular Tasks, so no separate lifecycle needed
- **Full YAML parser dependency**: rejected to keep V1 dependency-free

## Amendments

- **2026-07-17** — Launch now prepends a one-line context header to the prompt, so
  `task.prompt` is `<context header>\n\n<interpolated body>` rather than the body
  alone (key design choice 1). Without it a launched agent cannot tell it is
  executing a playbook, and "modify this playbook" means searching the playbook
  dirs blind. The template model is unchanged — a playbook still produces a
  regular Task. See `playbookContextHeader` in
  [`src/server/use-cases/playbook-launch.ts`](../../src/server/use-cases/playbook-launch.ts)
  and [Prompt assembly](../reference/playbooks.md#prompt-assembly).
