---
name: tdd-workflow
description: Implement features using TDD workflow with requirements-first approach. Use when implementing new features, adding functionality, or when user asks to build something.
keywords: tdd, test-driven, red-green-refactor, requirements, feature implementation
related: testing-patterns, test-quality-discipline, vitest-bun-mocking, safe-refactoring
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

# TDD Workflow

Implement features using Test-Driven Development with requirements-first approach.

## When to Use

- Implementing new features
- Adding functionality
- User asks to "build", "create", "add", "implement"
- Changes that should be tested

## Steps

### 1. Requirement First
Before any code:
1. Add/update the canonical requirement in the appropriate file under `docs/requirements/` (start from `docs/requirements/INDEX.md`; `docs/FUNCTIONAL_SPECIFICATIONS.md` is a redirect/snapshot)
2. Use "shall" for mandatory, active voice, positive statements, quantifiable criteria
3. Assign unique ID: `{CATEGORY}-{AREA}-{NUMBER}` (FR-*, NFR-*, API-*, DR-*)
4. Define testable acceptance criteria

### 2. Test Second (TDD)
Write tests BEFORE implementation:
```typescript
describe('FR-AUTH-001: User authentication', () => {
  it('shall authenticate valid credentials', () => { ... });
});
```
Map acceptance criteria to test cases. Update the appropriate spec under `docs/testing/` (start from `docs/testing/INDEX.md`) and the traceability matrix.

### 3. Implement
Write minimal code to pass tests. If deviation needed, STOP and ask:
```
Implementation needs to differ because [reason]. Should I:
A) Update requirement, or B) Find different approach?
```

### 4. Verify Coherence
Run tests. Check:
- [ ] Requirements match implementation
- [ ] Modified requirements have tests
- [ ] Test specs up to date
- [ ] Traceability current
- [ ] No orphaned/untested items

### 5. Commit
Reference requirement: `git commit -m "feat: implement FR-AUTH-001 user authentication"`
Include code + docs in same commit when possible.

### 6. Update Progress
Update `PROGRESS.md`.

## Requirement ID Schema

| Category | Prefix | Example |
|----------|--------|---------|
| Functional | FR | FR-AUTH-001 |
| Non-Functional | NFR | NFR-PERF-001 |
| API | API | API-TASK-001 |
| Data | DR | DR-USER-001 |
| Test | TS | TS-AUTH-001 |

## Requirement Template
```markdown
### {ID}: {Short Title}
**Status:** Draft | Approved | Implemented | Deprecated
**Priority:** Critical | High | Medium | Low

**Requirement:** The system shall {action} {object} {condition}.
**Rationale:** {Why}

**Acceptance Criteria:**
- [ ] Given {context}, when {action}, then {result}

**Linked Tests:** TS-{AREA}-{NUM}
**Dependencies:** {Other IDs}
```

## Before Commit Checklist
- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` clean
- [ ] `git status` shows intended files only
- [ ] Requirement documented in `docs/requirements.md`
- [ ] Tests cover the new/changed behavior

## See Also

- [[testing-patterns]] -- Test configuration and isolation
- [[playwright-e2e-patterns]] -- E2E test patterns
