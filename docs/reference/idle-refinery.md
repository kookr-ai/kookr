# Idle-slot idea refinery (issue #2144)

When the harness has free concurrency slots **and** an empty pending queue, it
has no supply of vetted work to consume, while human-sanctioned umbrella issues
(e.g. #1549, #1699, #1545) sit undecomposed. The scarce resource is vetted
supply **depth**, not scout cadence (#2073/#2074 already fixed *when* the scout
runs). The idle-slot idea refinery raises depth: on a standing idle posture it
spawns **one** bounded agent task that turns a single open, human-sanctioned
umbrella into sized leaf issues, which then flow through the normal vetting path.

It never auto-executes the leaves and never invents new top-level scope — it only
converts already-approved umbrella scope into actionable, reviewable leaves.

## Trigger

Evaluated on a 60s timer (`IdleRefineryRunner`). A refinery task spawns only when
**all** of these hold (see `src/core/idle-refinery.ts#decideIdleRefinerySpawn`):

1. `idleRefineryEnabled` is on.
2. The node is not draining (issue #659) and SAFE MODE is not engaged (issue #1710).
3. `pendingQueueDepth == 0` — there is no vetted work already queued.
4. `free >= idleRefineryMinFreeSlots` — headroom is at or above the threshold `N`.
5. No refinery task is already in flight (single-flight).
6. The last refinery spawn was at least `idleRefineryCooldownMinutes` ago.

The spawn uses `launchSource: 'idle-refinery'`, which is **spawn-budget-capped**
(NOT exempt like `schedule`), counts as autonomous actuation for the automation
kill-switch, and is treated as a self-releasing pending so it never re-wedges the
last slot.

## Settings

Live in the normal settings store (`GET/PUT /api/settings`), read through live
getters — a change applies without a restart.

| Setting | Default | Range | Purpose |
| --- | --- | --- | --- |
| `idleRefineryEnabled` | `false` | boolean | Master switch. Off by default — a new autonomous auto-spawn path that warrants an explicit operator opt-in. |
| `idleRefineryMinFreeSlots` | 3 | 1–25 | Threshold `N`: minimum free slots required to fire. |
| `idleRefineryCooldownMinutes` | 120 | 15–1440 | Minimum gap between two refinery spawns. |

## The decomposition work

The spawned task runs the `umbrella-decompose` playbook
(`plugin/playbooks/umbrella-decompose.md`). The agent:

- selects **one** open, human-sanctioned umbrella (maintainer-authored, not
  rejected/parked, not already fully decomposed) — a label that only blocks
  *automated execution* (e.g. `automation-blocked`) does **not** disqualify it;
- derives 3–8 leaf issues that stay inside the umbrella's approved scope;
- files each leaf with a **Scope** and **Acceptance criteria** section and links
  it back to the parent umbrella;
- stops at "filed and linked" — it never implements, assigns, or spawns the leaves.

## Relationship to the queue-feeder

This is complementary to — not a duplicate of — the CLI queue-feeder / umbrella
auto-decomposer (`kookr queue-feeder`, issues #1845/#2044/#2069). That path is
CLI-invoked, shreds a hard-coded set of **product-metric** umbrellas from curated
leaf plans, and ranks harness/orchestration umbrellas last — so it structurally
never touches the maintainer-sanctioned harness umbrellas this refinery targets.
The refinery is the live, agent-authored path for those umbrellas.
