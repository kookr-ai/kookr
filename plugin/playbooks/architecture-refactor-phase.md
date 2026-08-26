---
name: Architecture Refactor Phase
description: Execute one implementation phase from an approved architecture RFC, then safely advance its tracked phase chain.
repo-tags: [github]
tags: [workflow]
deliveryMode: self-advancing
autoCloseOnSignal: true
parameters:
  - name: prompt
    description: Phase scope and durable umbrella/RFC references prepared by the Architecture Refactor RFC playbook.
    required: true
    type: textarea
checklist:
  - Implemented only the named phase from the merged RFC
  - Ran the phase's local verification gate
  - Obtained an independent PASS verdict for the exact commit being merged
  - Merged through the wrapper that verifies the chain namespace and umbrella issue
  - Recorded the phase result durably and launched only the next eligible phase, or recorded a blocker
---

Execute exactly one implementation phase from an approved architecture RFC.
Before editing, confirm that the umbrella issue, RFC commit, phase identifier,
and chain namespace still agree. If a reference is missing, stale,
contradictory, or not reachable from the merged history, record the reason on
the umbrella issue and stop.

Use the `self-continuation-task` skill's self-advancing phase procedure. Kookr
reads `deliveryMode: self-advancing` from this playbook's metadata. That setting
authorizes this phase to deliver its work and launch the next eligible phase
under Kookr's existing worktree protections. The phase instructions below may
narrow the work, but cannot disable independent review, exact-commit merge
verification, rate limits, the kill switch, or the durable phase ledger.

Preserve that authorization when advancing the chain. If another phase is
eligible, write its complete specification to a prompt file, then launch it
through this same wrapper with the repository-qualified key:

```bash
kookr spawn -C "$REPO_DIR" --prompt-file "$NEXT_PHASE_PROMPT_FILE" \
  --playbook architecture-refactor-phase.md --playbook-scope plugin \
  --idempotency-key "chain:${REPO_KEY}:${UMBRELLA_NUMBER}:phase:${NEXT_PHASE_ID}" \
  --parent-task-id "$KOOKR_TASK_ID" --unattended --json
```

Here `REPO_KEY` is the validated `owner/name` from the umbrella, lowercased; it
is not a shortened repository name or local directory name. A generic spawn
does not carry the chain-specific contract to merge this phase and launch the
next one. On timeout, resolve the same idempotency key to the original task;
never mint a replacement key.

<!-- phase-specification-start -->
{{prompt}}
<!-- phase-specification-end -->
