# Agent Adapter — Boundary Smells

## Purpose

Check the adapter's boundaries for design issues.

## Overlaps

None. The adapter is a clean I/O layer.

## Ambiguities

- **Terminal session ID ownership:** The adapter creates and manages terminal sessions. Terminal session IDs are internal to the adapter — the backend references agents by `agentId`, and the adapter maps that to the underlying terminal session. This is cleaner than the previous model where session IDs leaked from JSONL output (ADR-007).

## Mixed Concerns

None. The adapter does I/O only — no business logic.

## Split Or Extraction Candidates

| Candidate | When |
|---|---|
| Add Codex CLI adapter alongside Claude Code adapter | Phase 4 — both implement the same `AgentAdapter` interface |

## Evidence

- `docs/architecture.md:130-140` — adapter layer design
- `docs/adr/004-agent-communication-protocol.md` — per-agent mechanisms (superseded by ADR-007)
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007)
