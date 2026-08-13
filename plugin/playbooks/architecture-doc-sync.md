---
name: Architecture Documentation Sync
description: Detect drift between architecture docs and code, then update stale documentation
parameters:
  - name: srcRoot
    description: Source root directory to compare against docs (e.g., src, lib, app)
    required: false
    default: src
  - name: docsRoot
    description: Docs root directory containing architecture material
    required: false
    default: docs
  - name: architectureDoc
    description: Path (relative to repo root) of the main architecture document
    required: false
    default: docs/architecture.md
  - name: adrDir
    description: Path of the ADR directory; leave blank if the project has none
    required: false
    default: docs/adr
  - name: systemModelsDir
    description: Path of multi-level system model docs; leave blank if absent
    required: false
    default: docs/system-models
  - name: reportPath
    description: Where to write the drift report
    required: false
    default: /tmp/doc-drift-report.md
checklist:
  - Ran architecture drift detection against all referenced design docs
  - Ran state machine verification against documented state machines
  - Produced drift report with severity classification
  - Updated stale module inventories where docs disagree with code
  - Updated stale state machine documentation
  - Verified updated docs match current code
  - Updated ADR statuses if any are contradicted by code
  - Loaded the writing skill before rewriting docs, and ran the writing reviewer before opening the PR (including nits that make the prose clearer)
---

## Objective

Find and fix drift between architecture documentation and the actual codebase. The goal is to keep docs as a reliable reference — not a historical artifact.

## Context

- **Source root**: `{{srcRoot}}`
- **Architecture doc**: `{{architectureDoc}}`
- **ADRs**: `{{adrDir}}` (skip the ADR step if this directory does not exist)
- **System model docs (optional)**: `{{systemModelsDir}}` (skip the subsystem deep-dive step if this directory does not exist)
- **Drift report destination**: `{{reportPath}}`

Before starting, list the docs that actually exist under `{{docsRoot}}` and adjust your scan to those. Don't assume any specific layout beyond what you find.

## Phase 1 — Detect Drift

### 1A. Architecture Drift Detection
Cross-reference documented architecture against actual code:
- Check every module path mentioned in `{{architectureDoc}}` (and any container/component view docs under `{{systemModelsDir}}` if present) — does it still exist?
- Check every non-test source file under `{{srcRoot}}/` — is it mentioned in at least one architecture doc?
- Check documented dependency directions against actual imports
- For each subsystem deep dive document found under `{{systemModelsDir}}` (if any), verify the component inventory matches reality

### 1B. State Machine Verification
For each documented state machine (look for state-machine catalogs or per-subsystem state-machine docs):
- Extract states and transitions from the doc
- Find the corresponding implementation (types, enums, transition logic)
- Compare: documented transitions with no code path? Code paths with no documented transition?
- Check terminal states: does code allow exits from documented terminal states?

### 1C. ADR Currency Check
For each Accepted ADR under `{{adrDir}}`:
- Is the decision still reflected in the code?
- Are there code patterns that contradict the ADR?
- Should any ADR status change to Superseded?

## Phase 2 — Produce Drift Report

Write a drift report to `{{reportPath}}`:
- Critical drift (structural contradictions, wrong dependency directions)
- Major drift (missing modules, stale file references, undocumented new modules)
- State machine discrepancies (undocumented transitions, missing implementations)
- ADR currency issues
- Minor drift (cosmetic, naming changes)

## Phase 3 — Fix Stale Documentation

Update docs in order of severity. For each update:

1. **Module inventories**: Update file lists in container/component views to match actual code
2. **State machines**: Update state/transition tables to match implementation. Add newly discovered states, remove states that no longer exist
3. **`{{architectureDoc}}`**: Update the module structure section if files have been added/removed/moved
4. **ADR statuses**: Change status to "Superseded" with a note if the code contradicts the decision

**Rules for updating**:
- Preserve the existing document *layout* (headings, tables, mermaid). Do not “update” a section by dumping file names and constants in place of what a cold reader can now see or do.
- **Before rewriting any section**, read the `clear-technical-writing` skill. Lead with what a cold reader can now see or do; park file names and line numbers after that.
- Add a comment or note when a significant change is made (e.g., "Updated YYYY-MM-DD: added X, removed deprecated Y")
- If a documented design decision no longer matches code but the new behavior seems intentional, update the doc to match code (code is the source of truth for current behavior)
- If the mismatch looks like a bug (code diverged unintentionally), flag it in the report but do NOT update the doc — the code should be fixed instead

## Phase 4 — Verify

After updates:
- Re-read each updated doc and spot-check 3-4 claims against the code
- Ensure no broken internal links between architecture docs
- Verify that subsystem boundary descriptions still make sense with the updated module lists

## Phase 5 — Cold-reader review before the PR

Do this **before** `gh pr create`, not after:

1. Spawn `kookr-toolkit:clear-writing-reviewer` on the new/changed prose (batch by subsystem if the diff is large).
2. If the PR body is more than a one-line rename, also run the `pre-pr-review` skill (the full writing self-check for the PR description, not the same agent as step 1).
3. Apply every finding that improves communication — including nits. An edit is cheap; a later agent reconstructing the story from identifiers is not.
4. Only then open the PR.

## Idempotency

- This playbook is safe to run repeatedly. Each run produces a fresh drift report and only updates docs that are actually stale.
- If `{{reportPath}}` exists from a previous run, rename it with a timestamp before writing the new one.

## Anti-Patterns

- Don't rewrite entire documents. Make targeted updates to stale sections only.
- Don't add speculative content ("this module will probably..."). Only document what exists now.
- Don't update ADRs to match code if the code change was clearly unintentional — flag it instead.
- Don't fabricate doc paths that don't exist in this repo. If `{{adrDir}}` or `{{systemModelsDir}}` is missing, skip those phases.
- Don't open the PR and *then* run the writing reviewer. Review first.
- Don't dismiss nits that make the prose clearer. Applying them is cheap.
