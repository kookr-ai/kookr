# Validate the decisions

Select cases that can affect the workflow; do not build an exhaustive simulator
for a small job. Start with the real incident and one healthy control. Add the
smallest repeatable fixture for a fragile invariant. Keep expected outcomes
separate from inputs when asking an independent evaluator to use the skill.

| Situation | Behavior to verify |
|---|---|
| Healthy work with no new artifact yet | Wait for a supported checkpoint; do not replace a live writer for age alone. |
| Summary changes or a reviewer is replaced | Observation/activity may change; the progress clock and unresolved deadline do not reset. |
| Repeated commits fail the same acceptance check | Inspect the hypothesis and change the approach; do not equate commit count with convergence. |
| A blocker was already acknowledged | Recheck its current truth and scope; avoid duplicate requests while pursuing eligible independent work. |
| Final activation lacks approval | Preserve the gate and perform eligible local slices; never infer approval from silence. |
| A read fails, is partial, or contradicts another source | Record uncertainty; obtain authoritative evidence before dependent action. An empty failed read does not prove no owner exists. |
| A launch or write times out after the server accepted it | Inspect the existing operation using its stable identity; do not duplicate the side effect. |
| The observer crashes after an external action but before saving state | Reconcile the postcondition on restart; retain the original budget and operation identity. |
| Two observers or workers overlap | The existing claim/fence prevents conflicting writes; a stale worker cannot continue merely because its lease was replaced. |
| An old PASS exists after the implementation changes | The old verdict neither authorizes the new revision nor refreshes its progress clock. |
| A worker finishes or a partial slice merges | Verify its acceptance and terminal ownership; hand off eligible work without advancing incomplete phase acceptance. |
| A deadline passes, budget is exhausted, or the operator pauses | Preserve the deadline/history and enforce the actual authority boundary; do not silently extend, reset, or relaunch. |
| The workflow source changes | Verify what the consumer actually loads and one real cycle's result, record, and cleanup. |
| A new fix appears successful | Record the observed result and limits; compare a different scenario before generalizing. |

For learning updates, also check these cross-project decisions:

- A batch export timed out after producing its output. Can the proposed retry
  establish whether the export already happened without creating a duplicate?
- A deployment lacks approval while an isolated compatibility check is eligible.
  Does the loop preserve the gate and keep the independent work moving?
- A long experiment has no new commit but a verified running job and a future
  checkpoint. Does the loop avoid interrupting it just because a coding-oriented
  progress signal is quiet?
- A contributor cannot edit the canonical plugin or publish private logs. Does
  the learning step leave a sanitized, owned proposed update and accurately say
  it is pending?

Record the input, observed decision, postcondition, and remaining uncertainty.
Retain negative cases that would catch a regression; consolidate duplicate cases.
