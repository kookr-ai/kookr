# Reference

Precise, lookup-oriented documentation for people operating Kookr or writing
code against it. If you are still setting Kookr up, start with
[Getting Started](../getting-started.md); if you want the day-to-day dashboard
workflow, read the [User Guide](../user-guide.md). Come here when you need the
exact contract, flag, field, or recovery step.

Each entry says what the page answers, so you can pick one without opening five.

## Contracts you call or configure

The stable surfaces other software — and your own scripts — depend on.

- [API](api.md) — every HTTP route and WebSocket message the Hono server exposes.
- [CLI](cli.md) — the `kookr` command and its subcommands (`spawn`, `status`, and the rest).
- [Spawn contract (`POST /api/tasks`)](spawn-contract.md) — the authoritative request/response shape for launching a task programmatically.
- [Environment variables](environment-variables.md) — canonical list of every `KOOKR_*` variable Kookr reads or injects.
- [Data directory](data-directory.md) — what Kookr stores under `~/.kookr/`, and which files are operator-owned state rather than repository content.
- [Playbooks](playbooks.md) — the frontmatter and body format for the Markdown task templates Kookr can launch.

## How the supervisor decides

Kookr watches agents and decides when to interrupt you, when to let a task
close, and when to spend a free slot. These pages document those judgements.

- [Findings](findings.md) — the anomaly types Kookr raises to route your attention, and what each one means.
- [Auto-close on completion signal](auto-close-on-signal.md) — the per-task policy that lets a task complete itself instead of waiting for you.
- [Merge-required gate](merge-required-gate.md) — why a task holding merge authority cannot report itself ready until the merge actually happened.
- [Idle refinery](idle-refinery.md) — what Kookr does with a free slot and an empty queue: spawn one bounded task that breaks an already-approved umbrella issue into sized leaf issues.
- [Schedule ROI](schedule-roi.md) — how the Schedules dialog computes the value rollup over retained execution history.
- [Lesson-write spool](lesson-write-spool.md) — how agent lesson writes survive a degraded knowledge-base (`kb`) dependency instead of being lost.
- [Lesson-decision gate](lesson-decision-gate.md) — why writing a lesson is a required lifecycle step at `completion_ready` rather than a voluntary one, plus the yield metric that tracks it.

## Staying up under load and failure

Kookr sheds load and isolates failures rather than collapsing. These pages
document the mechanisms and the incidents that motivated them.

- [Backpressure](backpressure.md) — the admission limits on task creation, added after the 2026-07-24 unbounded-creation deadlock.
- [Circuit breakers](circuit-breakers.md) — how a failing integration is isolated so it cannot take the rest of Kookr with it.
- [Signal outbox](signal-outbox.md) — how agent-to-daemon signals survive a restarting or unreachable Kookr daemon.
- [Deploy convergence](deploy-convergence.md) — the closed-loop invariant that a deploy is not "done" until the running server proves it.
- [API blackout probe](api-blackout-probe.md) — how to measure the seconds the API is unreachable during an intentional restart.

## Running Kookr unattended

For a Kookr that supervises real work while you are asleep, travelling, or
reachable only over a phone.

- [Production server service](production-server-service.md) — the systemd user unit and the `/api/ready` probe.
- [Low-downtime redeploy](../runbooks/low-downtime-redeploy.md) — planned `prod:update` / `prod:restart` procedure, and the client contracts that make a restart a non-event.
- [Offline recovery card](offline-recovery-card.md) — the short triage checklist for host-class failures, sized for a brief SSH window.
- [Unattended recovery runbook](unattended-recovery-runbook.md) — the full symptom → health field → action map.
- [Lucy prod update watchdog](lucy-prod-update-watchdog.md) — spec for the daily schedule that redeploys lucy (a separate project Kookr supervises) and must prove the deploy converged before reporting green.
- [Kookr self-batch schedule](kookr-self-batch-schedule.md) — spec for the schedule that drains Kookr's own issue backlog through the `parallel-issue-batch` pipeline.

## Sharing a session with someone else

Letting a collaborator watch or review a task without installing Kookr. Read
these in order — the first covers most needs.

- [Read-only shared view setup](shared-view-setup.md) — hand a collaborator a view-only dashboard link.
- [Session sharing](session-sharing.md) — share a single task link with a browser-only collaborator.
- [Hosted relay operations](hosted-relay-operations.md) — when the hosted relay becomes the normal Settings path, and what it requires.
- [Self-hosted relay runbook](self-hosted-relay-runbook.md) — operating your own relay on a public VPS. Prefer WireGuard, Tailscale, or SSH forwarding when the only remote viewer is you; a relay adds a public surface.
- [Easy sharing A0 dogfood](easy-sharing-a0-dogfood.md) — notes from the first, env-configured, view-only sharing phase.
