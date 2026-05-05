# Attention Router — Boundary Smells

## Purpose

Check the attention router's boundaries for design issues.

## Overlaps

None. The router is the sole owner of priority and navigation state.

## Ambiguities — Resolved

- **Who dispatches WebSocket messages?** Decision: standard event emitter pattern. The router produces `ServerMessage` objects (the logical messages). The server's WS handler subscribes to the router's events and handles serialization + delivery. The router never holds WS connection references. This is the normal way to decouple domain logic from transport — not a smell.

## Mixed Concerns

None. The router is pure orchestration logic — no I/O, no process management, no UI rendering.

## Split Or Extraction Candidates

None needed for V1. The router is small and focused.

## Evidence

- `docs/architecture.md:170-183` — WebSocket message types (owned by server layer, consumed by router)
