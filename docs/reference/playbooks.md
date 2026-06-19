# Playbooks Reference

Playbooks are Markdown task templates with a small YAML-like frontmatter block.
Kookr parses the frontmatter into launch form fields, task completion criteria,
dependency checks, and optional loop settings. The Markdown body after the
frontmatter becomes the agent prompt.

This page documents the authoring contract implemented by
[`parsePlaybook` in `src/core/playbook-parser.ts`](../../src/core/playbook-parser.ts).
The field list below maps to `parsePlaybook`, `parseParameters`,
`parseLoopConfig`, `parseLaunchDependencies`, and `parseParameterGatedBy`.
The parser intentionally accepts only the fixed shape below; it is not a full
YAML parser.

## File Format

Every playbook file must start with frontmatter delimiters:

```markdown
---
name: My Playbook
description: Optional short launch-form summary
---

Prompt body sent to the agent.
```

Kookr discovers playbooks from these tiers:

| Tier | Location | Visibility |
| --- | --- | --- |
| `project` | `<cwd>/.kookr/playbooks/*.md` | Only for that project cwd |
| `user` | `~/.kookr/playbooks/*.md` or `$KOOKR_USER_PLAYBOOKS_DIR` | Every project |
| `plugin` | `<kookr-toolkit-plugin>/playbooks/*.md` | Every project, unless filtered by `repo-tags` |

If two tiers define the same relative filename, precedence is
`project > user > plugin`. See [Playbook Scoping](../playbook-scoping.md) for
discovery, precedence, and plugin portability rules.

## Frontmatter Fields

| Field | Type | Required | Default | Effect |
| --- | --- | --- | --- | --- |
| `name` | string | yes | none | Human-readable name shown in the launch UI. Missing or non-string values are parse errors. |
| `description` | string | no | `""` | Short launch-form summary. Non-string values are ignored. |
| `parameters` | list of parameter objects | no | `[]` | Launch-form inputs interpolated into `{{parameterName}}` placeholders in the body. |
| `checklist` | list of strings | no | `[]` | Task completion criteria. These become the launched task's criteria. |
| `tags` | list of strings | no | `[]` | Display and behavior tags. `loopable` enables bounded loop metadata and defaults. |
| `loop` | mapping | no | absent | Optional loop settings for playbooks tagged `loopable`. Invalid loop metadata is recorded as `loopValidationError`; standard launch metadata still parses. |
| `deliveryPreAuthorized` | boolean | no | absent | Server policy flag used by delivery playbooks. Only `true` and `false` are recognized. |
| `autoCloseOnSignal` | boolean | no | absent | When `true`, tasks launched from this playbook auto-complete the moment their agent runs `kookr signal completion-ready`, instead of waiting for manual review. Successors spawned via `parentTaskId` inherit it automatically. Only `true` and `false` are recognized. See [auto-close-on-signal](./auto-close-on-signal.md). |
| `cwd` | string | no | launch dialog cwd | Target working directory override for launched tasks. |
| `dependencies` | list of launch dependency strings | no | `[]` | External capabilities the playbook requires before launch. Unsupported values are parse errors. Currently supported: `kb`. |
| `repo-tags` | list of strings | no | `[]` | Plugin-tier visibility filter. Ignored for project and user playbooks. |

Unknown top-level fields are ignored by the parser.

## Parameters

Each `parameters` item declares one launch-form input:

| Field | Type | Required | Default | Effect |
| --- | --- | --- | --- | --- |
| `name` | string | yes | `""` | Placeholder name. The body token is `{{name}}`. Use a non-empty identifier. |
| `description` | string | no | `""` | Label/help text shown in the launch form. |
| `required` | boolean | no | `false` | Missing or empty values fail interpolation when `true`. String `true` is also accepted. |
| `default` | string | no | absent | Value used when the launch form does not provide one. |
| `type` | string | no | text input | Recognized values: `select`, `textarea`. Omit the field for the default text input. |
| `options` | list of option objects | only useful for `select` | absent | Static select choices. |
| `source` | string | no | absent | Dynamic option source resolved by the launch form. Currently used value: `tracked-projects`. |
| `defaultFrom` | string | no | absent | Server-side default resolver. Currently supported: `git-remote`. |
| `gatedBy` | launch dependency string | no | absent | Form-rendering hint that collapses the parameter to its default when the dependency is absent. Currently supported: `kb`. Unsupported values are parse errors. |

Each `options` item accepts:

| Field | Type | Required | Default | Effect |
| --- | --- | --- | --- | --- |
| `value` | string | yes | `""` | Submitted value. |
| `label` | string | no | `value` | Display label. |

Parameter interpolation is literal and single-pass in declaration order:
`{{repoFullName}}` is replaced by the selected `repoFullName` value. Unknown
placeholders remain in the body. If a later parameter value contains an earlier
placeholder, Kookr does not re-interpolate it.

## Capability Gating

`dependencies` and `gatedBy` both use launch dependency names, but they do
different jobs:

- `dependencies` declares capabilities the playbook needs before an agent starts.
- `gatedBy` is only a launch-form rendering hint for one parameter. It is never
  enforced server-side.

For example, a playbook that can use the local knowledge base when available
might declare both:

```yaml
dependencies: [kb]
parameters:
  - name: useKnowledgeBase
    description: Use local knowledge base context
    required: false
    default: auto
    type: select
    gatedBy: kb
    options:
      - label: Auto
        value: auto
      - label: Off
        value: off
```

When `kb` is absent, the form collapses the gated parameter to its default and
annotates it instead of showing an inert control. See
[`rfc-capability-gated-playbook-params.md`](../rfc/rfc-capability-gated-playbook-params.md)
for the design rationale.

## Loop Settings

Loop settings are only effective when `tags` includes `loopable`. A loopable
playbook with no `loop:` block receives these defaults:

| Effective field | Default |
| --- | --- |
| `iterationCap` | `6` |
| `costCapUsd` | `25` |

The optional `loop:` block accepts:

| Field | Type | Default | Limits |
| --- | --- | --- | --- |
| `iterationCap` | integer | `6` | `1` through `20` |
| `zeroDiffConsecutiveIterations` | integer | absent | Positive integer, not greater than effective `iterationCap` |
| `costCapUsd` | number | `25` | Greater than `0`, at most `25` |
| `stopPredicate` | string | absent | Non-empty single-line shell predicate |

Invalid loop metadata does not reject the playbook file. Kookr preserves the
standard launch metadata and records `loopValidationError`, so the playbook can
still be launched manually without loop automation.

## Parser Subset

The frontmatter parser supports the shapes used by playbooks:

- Scalar strings and booleans.
- Quoted or unquoted string values.
- Inline string arrays such as `tags: [workflow, loopable]`.
- List-style string arrays.
- Lists of objects for `parameters` and nested `options`.
- A two-space indented `loop:` mapping.

It does not implement full YAML. Avoid multiline scalars, anchors, complex
nesting, numeric type assumptions outside documented loop fields, and comments
inside data values.

## Annotated Example

The example below is parsed by `src/core/playbook-parser.test.ts` as a drift
guard.

```playbook frontmatter-reference-example
---
name: Investigate GitHub Issue
description: Triage an issue and produce a scoped implementation plan
tags: [workflow, loopable]
repo-tags: [github]
dependencies: [kb]
deliveryPreAuthorized: false
parameters:
  - name: repoFullName
    description: Target GitHub repository
    required: false
    defaultFrom: git-remote
    type: select
    source: tracked-projects
    options:
      - label: "kookr-ai/kookr"
        value: "kookr-ai/kookr"
  - name: issueNumber
    description: GitHub issue number
    required: true
  - name: useKnowledgeBase
    description: Use local knowledge base context
    required: false
    default: auto
    type: select
    gatedBy: kb
    options:
      - label: Auto
        value: auto
      - label: Off
        value: off
checklist:
  - Issue context summarized
  - Implementation scope identified
  - Risks and verification plan recorded
loop:
  iterationCap: 4
  zeroDiffConsecutiveIterations: 2
  costCapUsd: 10
  stopPredicate: 'test -f .kookr-stop && grep -q "^done$" .kookr-stop'
---

Investigate {{repoFullName}} issue #{{issueNumber}}.

Use knowledge-base grounding mode: {{useKnowledgeBase}}.
```
