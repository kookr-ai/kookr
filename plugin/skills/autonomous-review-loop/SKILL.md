---
name: autonomous-review-loop
description: Run bounded autonomous implementation and independent-review correction cycles with durable accounting, exact-head merge safety, and periodic quality-preserving reflection.
keywords: autonomous review loop, correction cycle, iteration cap, exact head, self-reflection, anti-reward-hacking
related: independent-merge-review, reviewer-distillation-meta, self-continuation-task
---

# Autonomous Review Loop

Use this procedure for unattended implementation delivery in any repository.
The default maximum is **10 correction/review iterations per unit**. A project
may deliberately configure a lower cap; the configured value is carried through
continuation and reviewer lineage and never silently replaced by a new default.

An iteration is one implementation attempt followed by one fresh independent
review of the resulting commit. A BLOCK starts a correction cycle. A PASS is
usable only when it is machine-readable, produced by an independent fresh
context, and bound to the exact current PR head. A timeout, missing verdict,
stale verdict, forged or same-lineage identity, or missing local gate is a
blocker—not a successful iteration.

## Durable loop contract

At unit start, resolve the cap once and persist it with the unit ledger. Persist
the attempt count, implementation/reviewer task ids, reviewed head, verdict,
findings, and blocker reason. Continuation tasks must copy this envelope rather
than reinitializing the counter. On restart, reload the envelope and reconcile
the current branch/PR head before doing work. A changed head invalidates the
previous PASS and requires a fresh review; it does not reset the count.

The loop may merge only when all of these facts are true:

- the latest independent reviewer is outside the implementer lineage;
- the verdict is PASS and names the exact current head;
- every required local/check gate is green;
- the PR is mergeable and the merge operation pins the reviewed head.

After a BLOCK, fix or rebut each confirmed finding and run a new reviewer. Do
not edit an old verdict. If the cap is exhausted, write a concrete discoverable
blocker containing the unit, count/cap, current head, last verdict, and next
human action. A genuinely human-only identity or policy condition may stop
earlier, but routine reviewer failure must use the remaining budget first.

## Periodic self-reflection

After every five completed units, or sooner when safety metrics regress, run a
bounded reflection. Use fresh blind predictions and a held-out evaluation set;
never train or judge on the same review evidence used to select a mutation.
Record:

- iteration distribution and correction-cycle cost;
- confirmed-finding precision, defect recall, F1, and calibration;
- fresh-context reviewer rate, exact-head binding rate, review coverage, and
  safe-merge rate;
- timeout/no-review/stale-review attempts and their concrete causes.

Use `reviewer-distillation-meta` to propose changes to reviewer selection,
prompts, mutators/judges, or gates. A mutation is eligible only with enough
blind/held-out evidence and intact safety metrics. Fewer iterations is not a
success criterion by itself: never weaken, suppress, time out, omit, or bypass
review to make the count smaller, and never let the reviewer change its own
gate solely to improve iteration count. Preserve the prior configuration as a
held-out comparison and roll back any quality regression.

## Completion record

Report the resolved cap and durable attempts, each review verdict/head, local
gate evidence, blocker details if any, and the reflection metrics/decision.
The record must make it possible for a later task to continue without relying
on the previous agent's transcript or memory.
