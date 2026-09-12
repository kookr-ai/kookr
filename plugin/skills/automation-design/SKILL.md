---
name: automation-design
description: >
  Design, simplify, and improve autonomous workflows, supervisors, scheduled
  jobs, and recovery loops across projects. Use when automation needs repeated
  human intervention, reports activity without results, or tries a new recovery
  approach. Record outcomes and refine this skill from evidence.
---

# Automation Design

Build automation that notices missing results, takes a useful authorized action,
and checks its effect. Keep the control loop small enough to explain and test.
Reliability means that failures are visible, bounded, and recoverable; no prompt
can anticipate every edge case or supply missing authority.

Use this skill to design or change the workflow. Use [[playbook-authoring]] for
Kookr packaging and launch contracts, [[autonomous-watch-loop]] for a running
watcher, and [[self-continuation-task]] for sequential work. Preserve the project's
existing delivery and safety rules; this skill grants no additional permissions.

## Establish what success means

Read the current workflow, authoritative state, and a few complete recent runs,
including a failure and a healthy run when available. For an incident, reproduce
the actual failed decision before designing its replacement. Read relevant
[prior lessons](references/lessons.md); treat their evidence limits as part of
the lesson.

Define the smallest useful contract in the project's existing workflow document:

- **Result:** the next observable outcome and the full completion criteria.
  Distinguish an independently useful slice from final activation or acceptance.
- **Evidence:** where to verify that result, its identity or revision, and when
  it actually happened. Identify missing, stale, partial, and conflicting reads.
- **Authority:** who owns the work; permitted corrections; actions that require
  outside input; pause, cancellation, spending, and resource limits.
- **Checkpoint:** when the result should exist, how to observe it, and who will
  perform the follow-up. Derive timing from the work and recovery cost.

Do not copy another project's cadence, timeout, provider, paths, or merge policy
as a universal default. A design-only request produces a reviewable design;
activating schedules or modifying other projects requires the applicable authority.

## Design one feedback loop

Use the existing scheduler, queue, or event consumer where it can do the job.
Each bounded cycle answers four questions:

1. **What should have happened?** Re-read the next result and its outstanding
   deadline. Verify the previous intervention's effect before choosing another.
2. **What actually happened?** Inspect artifacts and current ownership. A live
   process, completed tick, message, retry, or confident summary is activity;
   judge whether it advances acceptance. Even new commits can repeat a failed
   approach without making useful progress.
3. **What can we do now?** Continue a healthy owner; correct a failing approach;
   recover eligible unowned work; reconcile verified completion; or request the
   precise external input after checking for useful independent work.
4. **Did the action work?** Read the real postcondition. Admission is evidence
   that work started, not that it finished. Save the next result and checkpoint,
   then finish the cycle and release its temporary resources. A one-shot task
   exits and releases its slot; a persistent observer resumes waiting until its
   configured stop condition.

A justified wait names the running operation or external dependency and its
resume condition. Recheck blocker claims against current scope and authority.
An approval needed for later activation may leave local implementation eligible.
Acknowledging a blocker suppresses duplicate notifications, not investigation.
Never treat silence as approval.

When the expected result is late or the last action failed, investigate even if
the status says healthy, active, retrying, or blocked. Set an evidence-age limit
as a backstop; act sooner on an actual failure. Preserve outstanding deadlines
across ticks and owner changes. Revise one only with a reason supported by new
evidence, without resetting cumulative budgets or hiding missed checkpoints.

## Keep mechanics small and deterministic

Put judgment in the loop and fragile mechanical invariants in existing helpers:

- Bind evidence to the exact work identity and relevant revision. Reworded
  summaries, new observer/reviewer IDs, stale review results, and disappearing
  observations cannot manufacture progress or authority. Preserve known facts
  through temporary read failures, but obtain fresh evidence before acting.
- Keep one writer per work unit. Resolve ambiguous ownership before replacement;
  use the platform's atomic claim or fencing mechanism where workers can overlap.
  An expired heartbeat alone does not prove a worker stopped or lost write access.
- Give repeatable external actions a stable operation identity. After a timeout,
  inspect the postcondition before retrying with the same identity. A changed
  prompt or new tick must not create a second logical operation.
- Persist just enough to resume: work identity, last verified outcome and time,
  owner, outstanding action and result, next checkpoint, and applicable budgets.
  Preserve history across restarts; use existing atomic writes or transactions.
  A failed observation or state write is an explicit failure, never a healthy
  empty result. Reconcile a possibly completed side effect before repeating it.
- Bound execution, retries, and recovery cost. Repeated failure of the same
  hypothesis requires diagnosis or a changed approach. Keep pause/stop controls
  outside the worker's discretion; verify terminal cleanup without killing live
  work merely because it is old.

Use these mechanisms only where the workflow needs them. Reuse a working guard;
do not build a second scheduler, state store, supervisor, or policy engine to
repeat it. Before adding a state, flag, layer, or exception, name the observed
failure it prevents and why the existing loop cannot handle it. Remove superseded
branches and duplicated instructions when a general correction replaces them.

Routine healthy checks should be cheap and quiet. Preserve enough health evidence
to distinguish quiet success from a dead observer. Surface changed outcomes,
failed recovery, missed checkpoints, or a concrete request; follow the user's
requested reporting cadence. Choose execution capability from demonstrated task
needs and respect explicit provider/resource choices.

## Validate decisions and the live path

Exercise the incident and a healthy control, then the relevant failure classes
in [validation scenarios](references/validation-scenarios.md). Use an isolated
fixture, replay, or dry run before live effects. Verify behavior and preserved
invariants; matching a prompt's wording is not behavioral validation.

For an authorized rollout, verify the loaded workflow/helper revision and one
real cycle's postcondition and saved checkpoint. Verify task exit for one-shot
runs; for persistent observers, verify return to waiting and cleanup on stop.
Keep a recovery path. Record what was observed and what remains untested. A
merged change or a successful launch alone is insufficient evidence of effective
automation.

## Learn after every problem and new attempt

When this workflow encounters a problem or tries a different intervention, update
its evidence record during the same task. Capture failures as well as successes.
For an ongoing experiment, mark the result **pending**, name the follow-up owner
and checkpoint, and revisit it when the outcome arrives. Do not infer success
from silence or allow a pending experiment to become an unowned promise.

1. Record the trigger, actual evidence, failed assumption, intervention, expected
   effect, observed outcome, and cost or new failure introduced. Link the local
   incident, revision, or reproducible fixture; keep sensitive detail local.
2. Update the matching entry in [lessons](references/lessons.md), or add a compact
   entry for a new failure mechanism. An existing lesson can gain confirming or
   contradicting evidence without adding another rule. Separate a failed attempt,
   a pending hypothesis, and a demonstrated result with its tested scope.
3. Refine the smallest relevant instruction or validation scenario. Promote a
   general rule only when its causal explanation and evidence justify that scope.
   When evidence contradicts a rule, narrow or replace it and retain the negative
   result. Consolidate repetition; this is maintained guidance, not an incident log.
4. Validate the revision against the original failure and a materially different
   project scenario. Check that it reduces operator intervention without expanding
   authority, false recovery, or complexity. Deliver through the owning plugin's
   normal review, versioning, and release process; verify the consuming workflow
   can discover the updated guidance.

The canonical target is the source plugin's `automation-design` skill, including
its references. Locate that source through the installed package metadata or
configured repository; do not patch an installed cache or production checkout.
Use a fresh worktree when required by the source repository. Cross-project work
does not automatically authorize publishing private evidence or changing upstream.
If source access or contribution authority is missing, save a sanitized proposed
update with its evidence in the project's existing durable task record, identify
the receiving maintainer and next action, and report the plugin update as pending.

Wire this learning step into the automation's existing incident/correction
closeout, with a pointer to this skill. A skill does not run itself: record who
will invoke it and how that invocation is discovered. Do not add a perpetual
meta-supervisor merely to remind workers to learn.
