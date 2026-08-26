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
  - name: maxIssues
    description: Maximum number of GitHub issues to create from the top findings. This is a cap, not a target — creating fewer is fine (and expected) when fewer findings clear the quality bar. Choose "Report only" to skip issue creation entirely.
    required: false
    default: "5"
    type: select
    options:
      - label: "Report only — don't create issues"
        value: "0"
      - label: "Up to 3 (focused)"
        value: "3"
      - label: "Up to 5 (recommended)"
        value: "5"
      - label: "Up to 8 (thorough)"
        value: "8"
  - name: maxRefactorPerWindow
    description: Value-density governor (#1846) — max refactor-class / cosmetic-consolidation issues this run may file in the current 24h window. Sub-threshold "share tinyHelper" findings are declined and logged instead.
    required: false
    default: "4"
  - name: minDriftScoreDelta
    description: Value-density governor (#1846) — minimum drift-score improvement a cosmetic consolidation must claim to clear the bar (when a numeric delta is available). Findings without a score that match cosmetic title patterns are declined.
    required: false
    default: "1.0"
checklist:
  - Ran architecture smell scan on all source modules
  - Ran dependency graph analysis for layering violations and cycles
  - Ran module interface audit for leaky/wide/mixed-level exports
  - Produced unified findings report with cross-agent correlations
  - Prioritized findings by impact and effort
  - Classified large dependency-bearing structural findings for RFC-first routing
  - Created GitHub issues for the top findings, capped at the selected maximum (or skipped when set to Report only)
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
3. Per-finding detail: what's wrong, evidence from which analysis, refactoring direction, `changeShape`, `size`, `implementationReadiness`, a stable `findingKey`, and an `orderedPhases` list when phased delivery is warranted
4. Positive findings: what's well-structured and should be preserved

## Large-Refactor Threshold

Route a finding through the RFC-first flow only when every condition is true:

1. It is a behavior-preserving `structural` architecture refactor, not a
   reductive capability change, policy decision, or speculative rewrite.
2. Its classified size is `large` and its implementation readiness is
   `needs-design`.
3. Safe delivery requires at least two ordered, dependency-bearing phases. P1
   has no predecessor; every later phase depends only on its adjacent
   predecessor reaching `main`.
4. The combined analysis supplies verified evidence and a testable outcome for
   every phase.

Set the finding's route to `rfc-first` only when all four hold. Otherwise leave
the route `plain-issue` (or keep the finding in the report when it does not meet
the issue quality bar). This threshold changes orchestration, not severity.

For each `rfc-first` finding, use the agent's file-write tool to create a
temporary `rfc-handoff.md` containing the six Architecture Refactor RFC inputs:
repository, stable finding key, title, verified evidence, ordered phase plan,
and this report as the source reference. Begin it with `Execute
plugin/playbooks/architecture-refactor-rfc.md for this verified finding.` Treat
evidence as prose to re-check; never place it in shell argv. Derive
`findingKey` from the normalized title plus the first 12 hex characters of a
SHA-256 over the canonical title and sorted affected paths, validate it against
`^[a-z0-9][a-z0-9-]{2,80}$`, and reuse it for the same finding across retries.

## Phase 3 — Create Issues

If `{{maxIssues}}` is `0`, skip this phase entirely: deliver the report only and note in the summary that issue creation was disabled by the run parameter.

Otherwise, resolve the drain-coupled emission budget first (issue #1607), then file at most the allowed count. **Fail closed** if the plan cannot be resolved — do not file without a budget.

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) \
  || { echo "architecture-health-check: cannot resolve repo; skipping issue creation"; exit 0; }
REPO_SLUG=$(printf '%s' "$REPO" | tr '/.' '--')
EMISSION_PLAN=$(kookr emission plan --repo "$REPO" --requested "{{maxIssues}}" --json) \
  || { echo "architecture-health-check: emission plan failed; refusing to file issues"; exit 0; }
ALLOWED=$(printf '%s' "$EMISSION_PLAN" | jq -r '.plan.allowedBudget // empty')
case "$ALLOWED" in
  ''|*[!0-9]*) echo "architecture-health-check: invalid allowedBudget; refusing to file"; exit 0 ;;
esac
echo "emission-budget: $EMISSION_PLAN"
# Persist netBacklogDelta7d for the daily reflection signal set (stable path).
mkdir -p "$HOME/.kookr/playbook-state/emission-metrics"
kookr emission metrics --repo "$REPO" --json \
  | tee "$HOME/.kookr/playbook-state/emission-metrics/$(printf '%s' "$REPO" | tr '/.' '--').json" \
  || true
# Value-density composition snapshot (#1846) — refactor share + value-advancing
# count for the next reflection. Best-effort; never blocks filing. Also seeds
# the window's refactor-class admit counter so two same-day runs share one cap.
mkdir -p "$HOME/.kookr/playbook-state/value-density/composition"
COMPOSITION_JSON=$(kookr value-density composition --repo "$REPO" --json \
  | tee "$HOME/.kookr/playbook-state/value-density/composition/$(printf '%s' "$REPO" | tr '/.' '--')-latest.json") \
  || COMPOSITION_JSON=""
FILED=0
# Seed from merged-PR refactor count in the window (composition), not 0, so the
# per-window cap is real across multiple architecture-health-check fires.
REFACTOR_FILED=$(printf '%s' "$COMPOSITION_JSON" | jq -r '.report.refactorCount // 0' 2>/dev/null || echo 0)
case "$REFACTOR_FILED" in ''|*[!0-9]*) REFACTOR_FILED=0 ;; esac
MAX_REFACTOR='{{maxRefactorPerWindow}}'
MIN_DRIFT='{{minDriftScoreDelta}}'
case "$MAX_REFACTOR" in ''|*[!0-9]*) MAX_REFACTOR=4 ;; esac
```

For the top actionable findings — **at most `min({{maxIssues}}, $ALLOWED)`** — create GitHub issues in the current repo:
- Title: `arch: [brief description of the smell/violation]`
- Body: evidence, impact, suggested approach
- Label: `{{issueLabel}}` (create if it doesn't exist)
- Assignee: `{{issueAssignee}}` (skip assignment if this is empty)

Before each `gh issue create`, run the emission budget gate, the **value-density governor** (#1846), and the mandatory logged dedupe check:

```bash
if [ "$FILED" -ge "$ALLOWED" ]; then
  kookr emission defer --repo "$REPO" --title "$ISSUE_TITLE" \
    --source architecture-health-check --reason "over emission budget (allowed=$ALLOWED)"
  continue  # keep in report watch-list; do not file
fi

# Value-density governor (#1846): cap cosmetic-refactor emission; require a
# drift-score-delta for one-helper consolidations; log declines for reflection.
# Optional: set DRIFT_SCORE_DELTA from the finding when the detector reports one.
DRIFT_ARGS=()
if [ -n "${DRIFT_SCORE_DELTA:-}" ]; then
  DRIFT_ARGS=(--drift-score-delta "$DRIFT_SCORE_DELTA")
fi
ADMIT_JSON=$(kookr value-density admit \
  --title "$ISSUE_TITLE" \
  --refactor-count "$REFACTOR_FILED" \
  --max-refactor "$MAX_REFACTOR" \
  --min-drift-delta "$MIN_DRIFT" \
  "${DRIFT_ARGS[@]}" \
  --json) \
  || { echo "value-density admit failed; skipping $ISSUE_TITLE"; continue; }
ADMIT_ACTION=$(printf '%s' "$ADMIT_JSON" | jq -r '.verdict.action // empty')
ADMIT_REASON=$(printf '%s' "$ADMIT_JSON" | jq -r '.verdict.reason // empty')
ADMIT_CODE=$(printf '%s' "$ADMIT_JSON" | jq -r '.verdict.reasonCode // empty')
ADMIT_REFACTOR=$(printf '%s' "$ADMIT_JSON" | jq -r '.verdict.classification.refactorClass // false')
if [ "$ADMIT_ACTION" = "decline" ]; then
  echo "value-density decline: $ISSUE_TITLE ($ADMIT_CODE) — $ADMIT_REASON"
  kookr value-density decline --repo "$REPO" --title "$ISSUE_TITLE" \
    --source architecture-health-check \
    --reason-code "$ADMIT_CODE" \
    --reason "$ADMIT_REASON" \
    --json >/dev/null || true
  kookr emission defer --repo "$REPO" --title "$ISSUE_TITLE" \
    --source architecture-health-check \
    --reason "value-density: $ADMIT_CODE — $ADMIT_REASON"
  continue  # keep in report watch-list; do not file
fi

DEDUPE_JSON=$(kookr emission dedupe --repo "$REPO" --title "$ISSUE_TITLE" --json 2>/tmp/kookr-dedupe-$$.log) \
  || { echo "dedupe failed; skipping $ISSUE_TITLE"; continue; }
cat /tmp/kookr-dedupe-$$.log 2>/dev/null || true
IS_DUP=$(printf '%s' "$DEDUPE_JSON" | jq -r '.isDuplicate')
if [ "$IS_DUP" = "true" ]; then
  echo "dedupe hit for $ISSUE_TITLE — update existing issue instead of creating"
  # Prefer updating/commenting on .match.url; never create a twin.
  continue
fi

# RFC-first routing gate. Phase 2 writes FINDING_ROUTE, FINDING_KEY, and an
# RFC_HANDOFF_FILE containing the verified evidence + ordered phase plan. The
# handoff begins with an instruction to execute
# plugin/playbooks/architecture-refactor-rfc.md; generated finding prose never
# appears in shell argv.
if [ "${FINDING_ROUTE:-plain-issue}" = "rfc-first" ]; then
  if ! printf '%s' "$FINDING_KEY" | grep -Eq '^[a-z0-9][a-z0-9-]{2,80}$'; then
    echo "architecture-health-check: invalid RFC-first finding key for $ISSUE_TITLE"
    continue
  fi
  if [ ! -s "$RFC_HANDOFF_FILE" ]; then
    echo "architecture-health-check: missing RFC-first handoff for $ISSUE_TITLE"
    continue
  fi
  RFC_SPAWN_JSON=$(kookr spawn -C "$(pwd)" \
    --prompt-file "$RFC_HANDOFF_FILE" \
    --criteria "RFC merged, umbrella created, and Phase 1 launched or a durable blocker recorded" \
    --idempotency-key "architecture-refactor-rfc:${REPO_SLUG}:${FINDING_KEY}" \
    --unattended --json) \
    || { echo "architecture-health-check: RFC-first launch failed; inspect idempotency state before retry"; continue; }
  RFC_TASK_ID=$(printf '%s' "$RFC_SPAWN_JSON" | jq -r '.details.taskId // .task.id // .taskId // empty')
  if [ -z "$RFC_TASK_ID" ]; then
    echo "architecture-health-check: RFC-first launch returned no task id; refusing to record success"
    continue
  fi
  # Record rfcTaskId beside this finding in {{reportPath}} (or its structured
  # sidecar) before advancing FILED. A retry reuses the exact idempotency key.
  FILED=$((FILED + 1))
  continue
fi

# Findings below the large-refactor threshold preserve the existing plain issue
# path and continue to the same gh issue create operation as before.

# ... gh issue create ...
FILED=$((FILED + 1))
if [ "$ADMIT_REFACTOR" = "true" ]; then
  REFACTOR_FILED=$((REFACTOR_FILED + 1))
fi
```

When a finding is selected but over the emission budget **or** declined by the value-density governor, defer it instead of filing (see the branches above). Declined cosmetic consolidations land in `~/.kookr/playbook-state/value-density/declined/` so the next reflection can observe them.

`{{maxIssues}}` is a ceiling, not a quota. The emission budget is a second, drain-coupled ceiling. The value-density governor is a third ceiling specifically for refactor-class / cosmetic consolidations. Create fewer if fewer findings clear the bar — never split, pad, or promote a minor/watch-list finding just to reach the number. Any findings above either cap stay in the report's watch-list section (and, when over budget or declined, in the deferred-ideas / value-density decline logs).

Skip creating plain issues for:
- Minor findings (cosmetic naming, low-severity smells)
- Sub-threshold cosmetic consolidations declined by `kookr value-density admit` (#1846)
- Findings that are intentional V1 trade-offs (documented in ADRs)
- Findings that would require major rewrites without clear payoff. A verified,
  behavior-preserving large refactor with a concrete ordered phase plan instead
  follows the RFC-first routing gate above.

## Idempotency

- Before creating issues, run `kookr emission dedupe` (logged) and search existing open issues for the `arch:` prefix to avoid duplicates
- If a previous report exists at `{{reportPath}}`, archive it with a timestamp suffix before writing the new one
- If duplicate issues exist, update them with new evidence instead of creating new ones
- Never file past the drain-coupled emission budget; defer over-budget candidates
- Never file a refactor-class / cosmetic consolidation the value-density governor declined; log it via `kookr value-density decline` so the next reflection can see it
- Use one stable `architecture-refactor-rfc:<repoSlug>:<findingKey>` launch key; after a timeout, inspect task/idempotency state before retrying and never mint a second key

## Anti-Patterns

- Don't file massive refactoring plans as plain implementation issues. Route a
  finding that clears the exact large-refactor threshold through
  `architecture-refactor-rfc.md`; otherwise each issue remains focused and
  independently shippable.
- Don't flag V1 simplicity decisions as smells unless they've become actively harmful.
- Don't create issues for things that are better fixed as drive-by improvements in other PRs.
- Don't file issues when open backlog is over the emission threshold without consulting `kookr emission plan`.
- Don't flood the window with one-helper-per-PR consolidations ("share X", "extract shared Y") — the value-density governor (#1846) will decline them; prefer product-metric-blocking work when surplus capacity remains.
