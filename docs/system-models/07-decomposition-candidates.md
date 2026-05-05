# Decomposition Candidates

## Purpose

Based on smell analysis and GitHub issue findings, identify boundary changes that would reduce complexity. Some have been accepted as design decisions; others remain open or deferred.

## Accepted (do during Phase 2)

These are no longer candidates — they are confirmed design decisions.

| Decision | Benefit | Evidence |
|---|---|---|
| **~~Agent behavioral contract~~** — superseded by ADR-007. Interactive mode is natively blocking; no contract needed | Originally resolved issue #3; now fully replaced by managed terminal sessions | 06-boundary-smells (resolved, superseded by ADR-007) |
| **Status ownership split** — adapter emits raw events only; supervisor owns state machine | Clear ownership; adapter stays a dumb parser | 06-boundary-smells #1 (accepted) |
| **Module split from the start** — separate modules for server, supervisor, adapter, core (tasks), attention router | Prevents early entanglement; each concern independently testable | 06-boundary-smells mixed-abstraction #1 (accepted) |
| **Process lifecycle** — adapter owns process handle, exposes `stop()`; server routes commands | Clean separation of I/O from routing | 06-boundary-smells ambiguity #1 (accepted) |

## Open Candidates

| Candidate | Benefit | Risk | Evidence | When |
|---|---|---|---|---|
| ~~Per-session resume queue in adapter~~ | ~~Prevents overlapping resumes~~ | ~~Adds queuing complexity~~ | Issue #9 | **Resolved by ADR-007.** No more resume subprocess; input via terminal keystrokes |
| Session cost tracker as a supervisor concern | Tracks cumulative session cost; enables budget burn detection (F2.5) | Must parse cost information from terminal output which differs between agents | Issue #6 (resume cost resolved, but session cost tracking still relevant) | Phase 3 if needed |

## Deferred Candidates

| Candidate | Why Deferred |
|---|---|
| Extract explanation generator from supervisor | Only needed if V2 adds LLM-powered explanations |
| Split frontend into micro-frontends | Premature; single SPA is fine for V1 |
| Agent discovery via session files | Removed from V1 — near-zero value without take-over. Re-add if/when take-over is implemented |
