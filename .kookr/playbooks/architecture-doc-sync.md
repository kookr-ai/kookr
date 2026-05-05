---
name: Architecture Documentation Sync
description: Detect drift between architecture docs and code, then update stale documentation
checklist:
  - Ran architecture drift detection against all system-model documents
  - Ran state machine verification against documented state machines
  - Produced drift report with severity classification
  - Updated stale module inventories in system-models/ docs
  - Updated stale state machine documentation
  - Verified updated docs match current code
  - Updated ADR statuses if any are contradicted by code
---

## Objective

Find and fix drift between architecture documentation (`docs/system-models/`, `docs/architecture.md`, `docs/adr/`) and the actual codebase. The goal is to keep docs as a reliable reference — not a historical artifact.

## Context

- **Architecture docs**: `docs/architecture.md` (main), `docs/system-models/` (MBSE-lite multi-level docs)
- **ADRs**: `docs/adr/001-012` (technology and design decisions)
- **State machines**: `docs/system-models/05-state-machine-catalog.md`, subsystem `03-state-machines.md` files
- **Source**: `src/` with layers: `core/`, `adapters/`, `server/`, `frontend/`

## Phase 1 — Detect Drift

### 1A. Architecture Drift Detection
Cross-reference documented architecture against actual code:
- Check every module path mentioned in `docs/architecture.md` and `docs/system-models/03-container-view.md` — does it still exist?
- Check every source file in `src/` (non-test) — is it mentioned in at least one architecture doc?
- Check documented dependency directions against actual imports
- For each subsystem deep dive (`docs/system-models/supervisor-agent/`, `agent-adapter/`, `attention-router/`), verify the component inventory matches reality

### 1B. State Machine Verification
For each documented state machine:
- Extract states and transitions from docs
- Find the corresponding implementation (types, enums, transition logic)
- Compare: documented transitions with no code path? Code paths with no documented transition?
- Check terminal states: does code allow exits from documented terminal states?

### 1C. ADR Currency Check
For each Accepted ADR:
- Is the decision still reflected in the code?
- Are there code patterns that contradict the ADR?
- Should any ADR status change to Superseded?

## Phase 2 — Produce Drift Report

Write a drift report to `/tmp/kookr-doc-drift-report.md`:
- Critical drift (structural contradictions, wrong dependency directions)
- Major drift (missing modules, stale file references, undocumented new modules)
- State machine discrepancies (undocumented transitions, missing implementations)
- ADR currency issues
- Minor drift (cosmetic, naming changes)

## Phase 3 — Fix Stale Documentation

Update docs in order of severity. For each update:

1. **Module inventories**: Update file lists in container views and subsystem component views to match actual code
2. **State machines**: Update state/transition tables to match implementation. Add newly discovered states, remove states that no longer exist
3. **architecture.md**: Update the module structure section if files have been added/removed/moved
4. **ADR statuses**: Change status to "Superseded" with a note if the code contradicts the decision

**Rules for updating**:
- Preserve the existing document style and formatting conventions
- Add a comment or note when a significant change is made (e.g., "Updated 2026-03-27: added token-tracker.ts, removed deprecated X")
- If a documented design decision no longer matches code but the NEW behavior seems intentional, update the doc to match code (code is the source of truth for current behavior)
- If the mismatch looks like a bug (code diverged unintentionally), flag it in the report but do NOT update the doc — the code should be fixed instead

## Phase 4 — Verify

After updates:
- Re-read each updated doc and spot-check 3-4 claims against the code
- Ensure no broken internal links between system-model documents
- Verify that subsystem boundary descriptions still make sense with the updated module lists

## Idempotency

- This playbook is safe to run repeatedly. Each run produces a fresh drift report and only updates docs that are actually stale.
- If `/tmp/kookr-doc-drift-report.md` exists from a previous run, rename it with a timestamp before writing the new one.

## Anti-Patterns

- Don't rewrite entire documents. Make targeted updates to stale sections only.
- Don't add speculative content ("this module will probably..."). Only document what exists now.
- Don't update ADRs to match code if the code change was clearly unintentional — flag it instead.
