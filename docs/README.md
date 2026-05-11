# Kookr Docs

Welcome. This directory holds Kookr's product, architecture, and engineering documentation. The repo is intentionally transparent about *why* and *how* the system is built, not just the surface API — so alongside the polished docs you'll find in-flight RFCs, exploratory spikes, and internal reports.

This README is the map. New readers should start at the top and follow the links that match what they need.

## Start here

- [Getting Started](getting-started.md) — install Kookr, run the dashboard, and launch a first agent.
- [User Guide](user-guide.md) — daily supervision workflow: findings, terminal, playbooks, schedules, GitHub awareness.
- [Configuration](configuration.md) — common optional features and `.env` choices.
- [Troubleshooting](troubleshooting.md) — setup and runtime fixes.
- [Development](development.md) — commands, worktrees, hooks, and contributor docs layout.
- [Features & Functionality](features.md) — what Kookr does from the user's perspective.
- [Architecture](architecture.md) — how the system is laid out (supervisor agent + GUI on top of managed terminal sessions).
- [Roadmap](roadmap.md) — phased plan toward V1 and beyond.
- [Requirements](requirements.md) — structured, testable requirements derived from the docs above and ADRs.
- [Hooks setup](hooks-setup.md) — git/repo hooks every contributor needs.

The repo's top-level [README](../README.md) is a short project entry point.

## Architecture decisions

[`adr/`](adr/README.md) — 15 Architecture Decision Records covering language, deployment model, agent communication, terminal session backend, and more. ADRs are durable: they explain why a choice was made, the alternatives considered, and the status (Accepted, Superseded, Proposed). If you're trying to understand "why is it built this way?", start here.

## System models

[`system-models/`](system-models/INDEX.md) — MBSE-lite stable views of the V1 system: scope, system context, capability map, container view, runtime interactions, state machines, and decomposition candidates. Useful for understanding the system at multiple levels of detail without reading source.

## RFCs (in-flight design)

[`rfc/`](rfc/) — Requests for Comment for non-trivial design proposals. Each RFC has a **Status** field at the top:

- **Accepted** RFCs describe designs that are landing or have landed; they're the most stable reading.
- **Draft** RFCs are still being iterated on. They reflect current thinking but may change before implementation. Treat them as in-progress design notes, not promises.

We publish drafts intentionally — the design history is part of the engineering story — but if you're evaluating Kookr for adoption, lean on Accepted RFCs and ADRs.

## Proofs of concept

[`poc/`](poc/) — short, focused experiments validating a specific mechanism (hook detection, checkpoint cycling, permission overrides, etc.) before committing to a design. Each POC documents what was tried, what worked, and what the result implied for the design. Companion `*-artifacts/` directories hold the raw outputs.

## Spikes

[`spikes/`](spikes/) — broader exploratory work, often with running code (e.g. `mouse-forwarding-poc/` includes a Playwright harness). Spikes are time-boxed investigations; they're kept after they conclude so future readers can see the shape of the problem and the evidence that informed the answer.

## Reports

[`reports/`](reports/) — internal audit and gap reports (skill-classification audits, spec-vs-code gap reports, brand-asset investigations, TUI-rendering limitation analyses, etc.). These are honest, point-in-time snapshots of what we found. They're useful for understanding how the project investigates and corrects itself; they may reference issues, PRs, or commits that have since shipped.

## Schemas

[`schemas/`](schemas/) — versioned JSON contracts for durable Kookr artifacts such as structured checkpoints.

## Reference

[`reference/`](reference/) — canonical reference material:

- [API Reference](reference/api.md)
- [CLI Reference](reference/cli.md)
- [Environment Variables](reference/environment-variables.md)

## A note on transparency

Kookr is built in the open. RFCs, POCs, spikes, and reports are all published deliberately: the design and decision trail is a feature, not a leak. If something here looks rough or self-critical, that's intentional — better to show the work than to airbrush it.

If you spot a doc that's stale, contradictory, or missing context, please open an issue or a PR.
