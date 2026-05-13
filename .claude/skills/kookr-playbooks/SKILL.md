---
name: kookr-playbooks
description: How to create, structure, and launch Kookr playbook tasks — reusable agent task templates with dynamic sources and project identity
keywords: playbook, playbooks, task, template, kookr, launch, repeatable, tracked-projects, project, source
---

# Kookr Playbooks

A **playbook** is a reusable task template stored as a Markdown file in `.kookr/playbooks/`. It defines a repeatable agent task that users can launch from the Kookr dashboard UI with one click (optionally filling in parameters).

## What a playbook IS

- A Markdown file with YAML frontmatter in `.kookr/playbooks/*.md`
- A task template: when launched, the Markdown body becomes the agent prompt
- Reusable: can be launched many times with different parameter values
- Visible in the Kookr dashboard under Launch > Playbooks tab

## What a playbook is NOT

- Not a Claude Code Agent tool invocation — it's a Kookr-native concept
- Not a skill — skills guide Claude's behavior; playbooks define agent tasks
- Not a one-off task — use the manual Launch tab or `curl POST /api/tasks` for that

## File location

```
.kookr/playbooks/
├── my-playbook.md
├── another-playbook.md
└── ...
```

The directory is scanned by `src/core/playbook-discovery.ts` which reads `.kookr/playbooks/*.md` from the project CWD.

## Frontmatter schema

```yaml
---
name: Human-Readable Playbook Name        # REQUIRED — displayed in UI
description: One-line description          # Optional — shown on playbook card
cwd: /absolute/path/to/working/directory   # Optional — overrides dialog CWD
parameters:                                # Optional — user fills these in before launch
  - name: repoFullName
    description: "Target repository (owner/repo)"
    required: false
    defaultFrom: git-remote                 # Optional — server resolves blank value from launch CWD remote
    type: select                           # Optional — 'text' (default) or 'select'
    source: tracked-projects               # Optional — dynamic data source
    options:                               # Optional — static fallback options (merged with source)
      - label: "grafana/grafana"
        value: "grafana/grafana"
checklist:                                 # Optional — becomes task completion criteria
  - First thing to verify
  - Second thing to verify
---
```

### Field details

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `name` | Yes | string | Display name in UI |
| `description` | No | string | Subtitle on playbook card |
| `cwd` | No | string | Target working directory (absolute path). If omitted, uses the CWD from the launch dialog. Use this when the playbook targets a specific repo. |
| `parameters` | No | array | Parameters with `name`, `description`, `required`, `default`, `defaultFrom`, `type`, `source`, `options`. |
| `checklist` | No | array of strings | Completion criteria shown in UI and tracked by the supervisor. |

### Parameter fields

| Field | Required | Type | Purpose |
|-------|----------|------|---------|
| `name` | Yes | string | Parameter name, used in `{{name}}` interpolation |
| `description` | No | string | Placeholder hint shown in the form |
| `required` | No | boolean | If true, the Launch button is disabled until filled |
| `default` | No | string | Pre-filled value when no history exists |
| `defaultFrom` | No | `'git-remote'` | Server fills a blank launch value from the launch CWD's `origin` remote. Use for repo params that should follow the current project instead of reusing stale history. |
| `type` | No | `'text'` or `'select'` | `select` renders a dropdown. Default: `text` |
| `source` | No | string | Dynamic data source ID (see below). Merged with static `options`. |
| `options` | No | array of `{label, value}` | Static dropdown options for `type: select` |

### Dynamic sources (`source` field)

When a parameter has a `source`, the UI resolves it at render time to populate the dropdown dynamically.

| Source ID | Resolves to | Value format |
|-----------|------------|--------------|
| `tracked-projects` | All hosted `ProjectSummary` entries from the sidebar (local projects excluded) | `owner/repo` (e.g., `grafana/grafana`) |

**Key behaviors:**
- Source options are merged with static `options` (deduped by value, static labels win)
- When option count > 5, the dropdown becomes a filterable search input
- **Project identity:** When `source: tracked-projects` is present, the selected value is automatically converted to a project ID (`github.com/owner/repo`) and assigned to the task. This makes the task appear under the correct project in the sidebar — not under the Kookr project.
- **Project drawer launch:** When the user clicks "Run playbook..." from a project's detail drawer, parameters with `source: tracked-projects` are auto-filled with that project's `displayName`.
- **Git remote defaults:** When a parameter has `defaultFrom: git-remote`, leave it optional in the form. Kookr resolves blank values from the launch CWD's git remote on the server and does not reuse the last manually entered value on future launches.

### Why `source: tracked-projects` matters for OSS playbooks

Without it, all playbook tasks run in the Kookr repo's CWD, so they get assigned to `kookr-ai/kookr` in the sidebar. With `source: tracked-projects`:

1. The repo dropdown is populated automatically from tracked projects (no hardcoded YAML edits)
2. The task gets the correct `projectId` (e.g., `github.com/grafana/grafana`)
3. The task appears under the target project in the sidebar, not under Kookr
4. Users can launch directly from the project drawer with one click

**Every OSS playbook that takes a repo parameter should use `source: tracked-projects`.**

## Derived values pattern

For parameters that are mechanically derivable from `repoFullName` (like `repoSlug`, `forkName`, `defaultBranch`), do NOT add them as user-facing parameters. Instead, add a "Derived values" section at the top of the prompt body:

```markdown
## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-` (e.g., `microsoft/vscode` → `microsoft-vscode`)
- **forkName**: `jeanibarz/<repo>` where `<repo>` is the part after `/`
- **defaultBranch**: look up from recon report at `~/.claude/<repoSlug>-recon/recon-report.md`, or default to `main`

Use these derived values wherever they appear below.
```

Use `<angleBrackets>` for derived values in the body (not `{{mustache}}`) to distinguish them from engine-interpolated parameters.

## Body

Everything after the frontmatter closing `---` is the agent prompt. Structure it as a comprehensive brief for a fresh agent that has no prior context:

1. **Derived values** — how to compute repoSlug, forkName, etc. from the primary parameter
2. **Objective** — what the task achieves
3. **Context** — repos, labels, tools, conventions the agent needs to know
4. **Phases** — numbered steps with concrete commands and examples
5. **Idempotency Rules** — how to safely re-run (critical for recurring tasks)
6. **Anti-Patterns** — mistakes to avoid

### Parameter interpolation

Use `{{paramName}}` in the body. When the user launches the playbook, values are substituted before the prompt is sent to the agent.

```markdown
Deploy version {{version}} to {{environment}}.
```

## How playbooks are launched

### From the UI — standard path

1. User clicks "+ Launch" button in the Kookr dashboard
2. Switches to the "Playbooks" tab
3. Searches and selects a playbook card
4. Fills in parameters (selects from dropdown for `tracked-projects` fields)
5. Clicks "Launch Playbook"

### From the UI — project drawer path

1. User clicks a project in the sidebar (e.g., grafana)
2. The project detail drawer opens
3. Clicks "Run playbook..." button in the drawer header
4. The launch dialog opens on the Playbooks tab
5. Selects a playbook — `repoFullName` is auto-filled with the project's name
6. Clicks "Launch Playbook"

Both paths produce identical tasks (same CWD, same prompt, same projectId).

### From the API (programmatic)

```bash
curl -s -X POST http://localhost:4800/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "<paste the playbook body with params filled in>",
    "cwd": "/path/to/working/dir",
    "criteria": "checklist item 1. checklist item 2."
  }'
```

## When to create a playbook vs a one-off task

| Scenario | Use |
|----------|-----|
| Repeatable process (triage, audit, analysis) | Playbook |
| One-time investigation or fix | Manual launch or `curl POST /api/tasks` |
| Process that will run on a schedule | Playbook (idempotency rules required) |
| Quick delegation from within an agent session | `spawn-child-task` skill |

## Good playbook design

1. **Self-contained prompt**: The agent starts fresh — include ALL context it needs
2. **Concrete commands**: Show exact `gh`, `curl`, `git` commands, not vague instructions
3. **Minimal parameters**: Only ask for what can't be derived. Use `defaultFrom: git-remote` for repo fields that should follow the launch project, `source: tracked-projects` when project-drawer launch should pre-fill the selected project, and derive slug/fork/branch in the prompt body.
4. **Checklist items map to phases**: Each checklist item should correspond to a verifiable phase outcome
5. **Idempotency section**: If the playbook will run repeatedly, document how to avoid duplicate work
6. **Anti-patterns section**: Capture past mistakes so the agent doesn't repeat them
7. **CWD field**: Set it when the playbook targets a specific repo different from the Kookr project (e.g., `cwd: $HOME/git/codex` for Codex-specific playbooks)

## Template for a new OSS playbook

```yaml
---
name: OSS <Task Name>
description: <One-line description>
parameters:
  - name: repoFullName
    description: "Target repository (owner/repo)"
    required: true
    type: select
    source: tracked-projects
checklist:
  - <First verifiable outcome>
  - <Second verifiable outcome>
---

## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-`
- **forkName**: `jeanibarz/<repo>` where `<repo>` is the part after `/`

## Objective

<What this task achieves for {{repoFullName}}>

## Context

- **Upstream**: `{{repoFullName}}`
- **Fork**: `<forkName>`
- **State**: `~/.claude/<repoSlug>-<task-slug>/`

## Phases

### Phase 1: ...

## Idempotency Rules

1. ...

## Anti-Patterns

- ...
```

## Examples in this project

- `oss-pr-lessons.md` — Analyzes closed PRs to learn contribution patterns (1 param: repoFullName)
- `oss-bug-triage.md` — Scores upstream bugs, maintains ranked triage issues (1 param: repoFullName)
- `oss-contribution-pipeline.md` — End-to-end contribution workflow (2 params: repoFullName, phase)
- `codex-bug-triage.md` — Codex-specific triage (hardcoded cwd, no tracked-projects source)

## Implementation files

- `src/core/playbook.ts` — Type definitions (`Playbook`, `PlaybookParameter`, `source` field)
- `src/core/playbook-parser.ts` — Parses frontmatter + body, interpolates `{{params}}`
- `src/core/playbook-discovery.ts` — Scans `.kookr/playbooks/*.md`
- `src/server/use-cases/playbook-launch.ts` — Prepares launch options, derives `projectId` from `tracked-projects` param
- `src/server/launch-service.ts` — Creates task, sets `projectId` if provided
- `src/server/schedule-validator.ts` — Same projectId derivation for scheduled launches
- `src/frontend/store/playbook-source-resolver.ts` — Resolves `tracked-projects` source to dropdown options
- `src/frontend/components/FilterableSelect.tsx` — Searchable dropdown for large option lists
- `src/frontend/components/PlaybookBrowser.tsx` — UI for browsing, project-context pre-fill
- `src/frontend/components/LaunchDialog.tsx` — Tabbed dialog (Manual | Playbooks)
