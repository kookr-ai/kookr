---
name: Architecture Health Check
description: Comprehensive multi-agent audit of codebase structural health — smells, dependencies, interfaces
parameters:
  - name: srcRoot
    description: Source root directory to scan (e.g., src, lib, app)
    required: false
    default: src
  - name: layeringRules
    description: How layers in this codebase are expected to depend on each other (free text; e.g., "core → adapters → server → frontend, with no upward imports")
    required: false
    default: ""
    type: textarea
  - name: reportPath
    description: Where to write the unified findings report
    required: false
    default: /tmp/arch-health-report.md
  - name: issueLabel
    description: GitHub label to apply to created issues (will be created if missing)
    required: false
    default: architecture
  - name: issueAssignee
    description: GitHub username to assign new issues to (leave blank to skip assignment)
    required: false
    default: ""
checklist:
  - Ran architecture smell scan on all source modules
  - Ran dependency graph analysis for layering violations and cycles
  - Ran module interface audit for leaky/wide/mixed-level exports
  - Produced unified findings report with cross-agent correlations
  - Prioritized findings by impact and effort
  - Created GitHub issues for top 3-5 actionable findings
---

## Objective

Run a comprehensive architecture health check on the codebase. This is a multi-perspective structural audit that combines three analysis passes into one prioritized action plan.

## Context

- **Source root**: `{{srcRoot}}`
- **Layering expectations** (if specified): `{{layeringRules}}` — if this is empty, derive layers from the directory structure under `{{srcRoot}}` and document the inferred rules at the top of the report.
- **Report destination**: `{{reportPath}}`
- **Available subagents (kookr-toolkit)**: `architecture-smell-scanner`, `dependency-graph-analyzer`, `module-interface-auditor`, `architecture-drift-detector`. Invoke them in parallel where the work is independent.

## Phase 1 — Run All Three Analyses

Run the following three analyses. You may invoke subagents in parallel if available, otherwise do them sequentially.

### 1A. Architecture Smell Scan
Analyze all source files for:
- God modules (too many responsibilities, too many exports, too long)
- Scattered features (one concern spread across many files with no clear owner)
- Ambiguous ownership (overlapping responsibilities between modules)
- Feature envy (module reaching into another's internals)
- Inappropriate intimacy (bilateral dependencies, shared internal types)

### 1B. Dependency Graph Analysis
Parse all imports under `{{srcRoot}}/` (exclude test files) and check:
- Layering violations against the rules above (or the inferred layout if no rules supplied)
- Circular dependencies (direct A↔B and transitive A→B→C→A)
- God modules by fan-in (>10 importers) and fan-out (>8 imports)
- Hub modules (high fan-in AND fan-out — fragile)

### 1C. Module Interface Audit
For each source module, evaluate its public API:
- Export count (flag > 10 non-type exports)
- Abstraction level consistency (mixing high-level and low-level exports)
- Leaky abstractions (implementation details in public types)
- Consumer utilization (do consumers use most of what's exported?)

## Phase 2 — Correlate and Prioritize

Cross-reference findings across all three analyses. Look for reinforcing signals:
- A god module (smell scan) that's also a hub module (dependency graph) with a wide interface (interface audit) = critical hotspot
- A scattered feature (smell scan) whose files have circular dependencies (dependency graph) = compounding problem
- A leaky abstraction (interface audit) that causes layering violations (dependency graph) = boundary failure

Produce a **unified findings report** at `{{reportPath}}` with:
1. Executive summary (3-5 sentences)
2. Top findings ranked by impact × fixability
3. Per-finding detail: what's wrong, evidence from which analysis, refactoring direction
4. Positive findings: what's well-structured and should be preserved

## Phase 3 — Create Issues

For the **top 3-5 actionable findings**, create GitHub issues in the current repo:
- Title: `arch: [brief description of the smell/violation]`
- Body: evidence, impact, suggested approach
- Label: `{{issueLabel}}` (create if it doesn't exist)
- Assignee: `{{issueAssignee}}` (skip assignment if this is empty)

Skip creating issues for:
- Minor findings (cosmetic naming, low-severity smells)
- Findings that are intentional V1 trade-offs (documented in ADRs)
- Findings that would require major rewrites without clear payoff

## Idempotency

- Before creating issues, search existing open issues for the `arch:` prefix to avoid duplicates
- If a previous report exists at `{{reportPath}}`, archive it with a timestamp suffix before writing the new one
- If duplicate issues exist, update them with new evidence instead of creating new ones

## Anti-Patterns

- Don't propose massive refactoring plans. Each issue should be a focused, independently shippable improvement.
- Don't flag V1 simplicity decisions as smells unless they've become actively harmful.
- Don't create issues for things that are better fixed as drive-by improvements in other PRs.
