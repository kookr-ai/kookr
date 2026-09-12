# Evidence and lessons

Read the entries relevant to the workflow being designed. Update them when an
incident or new approach changes the evidence. Keep project state, raw logs,
secrets, and long timelines in the originating project's records. The initial
cases below are sanitized from a private project; raw records stay there. Their
summaries are self-contained, but external readers cannot replay the private
evidence. Add accessible reproductions or public sources when available.

For a new mechanism use this compact shape:

- **Context and evidence:** date, workflow type, source or reproducible fixture.
- **Failure and assumption:** what happened and why the old approach allowed it.
- **Attempt and outcome:** expected effect, observed result, verification scope,
  and any extra cost or regression. Use pending, failed, or demonstrated.
- **Guidance and limits:** what to change, when it applies, and what is unproven.
- **Follow-up:** owner/checkpoint for pending work; otherwise the condition that
  would challenge this lesson. Link the affected instruction or scenario.

## Status reconciliation can preserve an avoidable blocker

**Context and evidence:** a private service-integration workflow. The source
project retains the correction, independent review, historical replay, and live
rollout records. This entry captures the transferable mechanism and observed limits.

**Failure and assumption:** the supervisor recorded 20 unchanged blocker
observations. A missing input for final production activation was treated as a
blocker for all implementation. A detailed classification prompt kept confirming
the previous explanation. The operator supplied the missing fresh diagnosis.

**Attempts and outcomes:**

- **Demonstrated, narrow:** separating local slices from final acceptance
  unblocked the first slice. Adding another special case did not establish that
  the supervisor could diagnose the next unfamiliar blocker.
- **Demonstrated, bounded:** a four-question feedback loop replaced the 551-line
  scheduled prompt with 144 lines, retaining execution contracts in a reference.
  Its first live tick verified the first slice's merges and terminal owner,
  launched one eligible successor, recorded a checkpoint, and completed.
- **Replay evidence only:** a general evidence-age check would have requested
  reassessment on 15 of 21 historical blocked observations. This demonstrates
  detection, not that an agent would have resolved all 15 cases correctly.

**Guidance and limits:** inspect the expected outcome, the continuing truth of
the blocker, and the effect of the last action in every cycle. Apply final gates
at their actual boundary while preserving full acceptance. The ten-minute cadence
and one-hour backstop were project choices. One successful handoff establishes
neither long-term reliability nor the best timing for other projects.

**Challenge condition:** renewed status churn, missed intervention follow-ups,
or unnecessary operator requests require inspecting the decision and testing a
revised hypothesis, not just shortening the prompt again.

## Narrative changes and stale artifacts can reset the wrong clock

**Context and evidence:** the same private workflow included a progress detector,
regression tests, and independent review. Verification covered the reported
failures and compatibility with previously saved state; it was not a study across
independent automation designs.

**Failure and assumption:** progress identity included a free-text summary and
reviewer task ID. Rephrasing the same state or replacing a reviewer made the work
look recent. Missing observations could similarly appear to be changed evidence.

**Attempts and outcomes:**

- **Failed variant:** counting any terminal review still allowed a verdict for
  an older commit to refresh the current implementation's clock. Independent
  review reproduced it and blocked that revision.
- **Demonstrated in tests:** count only verified artifacts, associate each review
  with the implementation revision it assessed, retain known facts during
  temporary read failures, and preserve timestamps and counters when upgrading
  saved workflow records. Reproductions covered stale or missing commit
  identities, pending or replacement reviewers, rewritten summaries, disappearing
  and reappearing artifacts, and real worktree revisions.
- **Demonstrated live:** the successor launch retained the existing evidence
  clock instead of treating admission as completed implementation.

**Guidance and limits:** distinguish last observation, last activity, and last
verified progress. Retained historical evidence cannot authorize a current action.
New artifacts still require judgment about convergence toward acceptance; artifact
churn alone can remain unproductive.

**Challenge condition:** a false reset, old evidence authorizing action, or useful
progress omitted by the detector. Extend the matching regression with the actual
input before broadening what counts as evidence.

## Initial cross-project decision check

**Evidence and outcome:** during the initial skill review, an independent agent
applied the skill to the four cross-project fixtures in
[validation scenarios](validation-scenarios.md). It reconciled a completed export
without duplicating it, retained a healthy long-running job, selected authorized
release preparation while preserving the deployment gate, and recorded a pending
experiment without publishing private evidence. No additional decision rule was
needed. Review did expose conflicting adjacent watcher wording about authorization
and live-task inspection; those instructions were clarified.

**Limits:** these were simulated decisions, not executed exports, deployments,
or experiments. Missing owner identities and exact checkpoint times remained
explicitly unresolved. This checks interpretation across contexts; it does not
measure runtime reliability or establish that the skill caused the decisions.

## Open evaluation: transfer and sustained operation

The initial evidence comes from one integration workflow. Longer operation and
different project types must test whether the loop reduces missed checkpoints and
operator interventions without increasing duplicate actions, false recovery,
runtime cost, or policy complexity. This is an evidence limit, not a scheduled
experiment or a claim that another project has already validated the design.
