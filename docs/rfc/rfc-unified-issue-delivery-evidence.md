# Evidence pack: one issue-delivery playbook

This pack supports `docs/rfc/rfc-unified-issue-delivery.md`. Every statement below was gathered from `origin/main` @ `1cacf925` on 2026-11-14. Abbreviations: **IGI** is `plugin/playbooks/implement-github-issue.md` (826 lines); **PIB** is `plugin/playbooks/parallel-issue-batch.md` (1262 lines).

Treat every claim here as something to check, not as settled fact. Each one carries a source pointer so you can re-verify it.

## 1. What each playbook does today

### IGI
- Handles one issue per run (IGI L118-125). It can loop (Ralph, `loopable`, `.batch-stop`, `burnedOutTargets`) or chain by self-continuation when `selfContinuation=true` (L46-55, L685-705).
- **Selector:** three shapes, parsed mechanically (L157-178):
  - blank, which takes the most recent eligible issue;
  - a list of numbers matching `^#?\d+$`;
  - anything else, which is passed verbatim to `gh --search` (`repo:`, `state:` and `is:` are rejected).
  "Only issues 12 and 15" contains non-numeric tokens, so it falls into filter mode and is either mis-parsed or rejected.
- **Bundling** is explicitly banned: "Don't put dependent issues in one selector" (L814) and "Don't bundle unrelated changes" (L821).
- **Delegation:** none for implementation. Only the fresh-context reviewer (L646) and the pre-push specialists (L474) run as subagents. There is no model-tier routing.
- **Plan step:** none. The playbook says "Do not stop to ask" (L102); "ask at most once" is reserved for an ambiguous delivery policy (L104).
- **Merge:** a check classifier (L614-641), at most 2 CI reruns (L644), independent review (hard gate on kookr-ai/kookr, advisory elsewhere, L646-652), then `pnpm merge` (L653-669). After that come the lesson gate (L707), the Ralph verdict (L739-810) and the slot release (L700-705).
- **Only in IGI:** `closeUnworthyIssues` with quarantine (L383-415), KB-first lookup (L373), incident `Refs #N` handling (L276-289, L548-561), and `staging` base-branch detection (L419-424).

### PIB
- A supervisor that spawns one child Kookr task per work unit, in parallel up to `maxConcurrentTasks` (default 4), using a write-scope matrix (L397-518, L520-1019). `childAgent` picks claude-code, codex-cli or grok-build (L56-69). There is no model tier.
- **Selector:** the same three shapes (L358-371). `extraInstruction` is free prose and is never parsed (L82-86, L161-174).
- **Bundling:** the rules are written out (L442-470: size, affinity, efficiency, reviewability), but bundles are switched off. "multi-issue bundles are temporarily ineligible" (L449-450), and Phase 4 has a fail-closed guard, `if [ "$UNIT_COUNT" -gt 1 ]` → "multi-issue atomic claim support is required" (L815-825).
- **Plan step:** partial. A selection matrix with `reason_selected` is written before spawning (L399-400, L518), but nobody approves it. `onAmbiguity=ask` fires only on pool ambiguity, and never headless (L176-213).
- **Contracts only in PIB:**
  - a headless gate and report-and-exit with `blocked-empty` (`product` vs `concurrent`) plus the starvation handle (L247-282, L1111-1209);
  - a durable outcome file at `~/.kookr/playbook-state/parallel-issue-batch/<slug>/<runKey>/outcome.json` (L224, L290);
  - delivery ownership by the claim lease (L882-945);
  - the parent-implementer fallback (L947-1019);
  - a verbatim child prompt template and a contract check (L562-734).

### Duplication and conflicts
- About 350 lines of PIB repeat IGI: selector parsing, drain and severity ordering, `pr_create_guard` (verbatim), the CI-rerun bound, check classification, review, the lesson decision and the slot release.
- **11 contradictions:**
  1. **Claims:** IGI carries on when the claims API returns 404; PIB fails closed.
  2. **Branch naming:** `feat-issue-N-slug` vs `<type>/issue-N-slug`.
  3. **Base branch:** IGI detects `staging`; PIB uses the default branch.
  4. **Label skip lists** differ and apply in different selector shapes.
  5. **Incidents:** IGI writes `Refs #N`; PIB children always write `Closes`.
  6. **Admin merge:** PIB says `--admin`; IGI says never bypass branch protection. *(Round 2 correction: a false alarm. `--admin` appears only in the head-bound `never-executed` waiver (PIB L688), and IGI L642 permits that same exception.)*
  7. **Asking the operator:** IGI never asks; PIB defaults to `onAmbiguity=ask`.
  8. **Dependent issues:** PIB's bundle affinity allows them; IGI and the self-continuation skill forbid them.
  9. **`gh pr edit`:** both ban it and both use it.
  10. **Features present in only one playbook.**
  11. **Cost cap:** $25 vs $15.

## 2. What depends on the ids (coupling)

- **Code hard-codes `parallel-issue-batch` about 10 times**, all through `isParallelIssueBatchPlaybookId` (`src/core/pipeline-starvation.ts:430-434`):
  - the starvation re-entry spawner launches `parallel-issue-batch.md` with a fixed parameter set (`src/server/pipeline-starvation-service.ts:632, 658, 728-775`);
  - the terminal safety net (`:804, 882-887, 1084`);
  - the post-recovery queue fill (`src/server/post-recovery-service.ts:41, 562, 935-960`);
  - the ideation exclusion (`src/core/pipeline-starvation-ideation.ts:18, 169`);
  - the drained-pin alert (`src/core/batch-selector-pin.ts:89-98`);
  - the auto-complete regex for meta tasks (`src/core/finished-awaiting-ack-ttl.ts:146-151`). It matches `/issue-batch/i` and `/parallel-issue-batch/i`, and its test pins IGI to **not** match (`:1086`). **Danger:** any new id containing "issue-batch" would auto-complete implementer tasks.
- **Code hard-codes `implement-github-issue` once:** the other-author warning in the dashboard (`src/frontend/components/PlaybookBrowser.tsx:105, 529-536`).
- **Parameter names read by code:** `repoFullName ?? repo`, `issueSelector`, `mergeAfterImplementation`. The merge-authority header text is `TERMINAL-STATE CONTRACT (mergeAfterImplementation=true)` (`src/core/merge-required.ts:67-125`).
- **Validators that pin playbook text:**
  - `scripts/validate-rerun-bound.ts:18-19` (both files);
  - `scripts/delivery-ownership-rehearsal.ts:57` and `parent-implementer-fallback-rehearsal.ts:14, 47` (PIB path).
- **Contract tests:**
  - `src/core/implement-github-issue-playbook.test.ts` (16 tests);
  - `parallel-issue-batch-playbook.test.ts` (24 tests);
  - `playbook-parser.test.ts:446, 473-490`;
  - plus about 40 fixtures that use the PIB id.
- **Spawners and prose callers:**
  - `kookr-queue-feeder` and `goal-supervisor` tell children to follow "the Implement GitHub Issue playbook", by display name and in prose only;
  - `product-improvement-autoloop` launches PIB with an explicit `issueSelector`;
  - the `independent-merge-review` skill cites "IGI Phase 8 / PIB Phase 5".
- **Live local data:**
  - `~/.kookr/schedules.json` has 3 schedules pinned to `parallel-issue-batch.md`, 2 of them enabled;
  - `~/.kookr/playbook-state/parallel-issue-batch/` holds state.
- **Registry:** the id is the filename, and precedence is project > user > plugin (`src/core/playbook-discovery.ts:67`). There is **no alias, redirect or deprecation mechanism**; a renamed file only raises `schedule-resolution-alert` "resolves in no tier".
- **Versioning:** any `plugin/**` change needs a `plugin.json` version bump (currently 0.16.102), enforced by the pre-push hook.

## 3. Claims: what actually blocks multi-issue PRs

- "Atomic claim transfer" comes from `12059dbf` (#2778). It was never built, and no issue tracks it.
- **CORRECTION (round 1, verified against the code):** the bullets below are WRONG. `grant()` (`issue-claim-registry.ts:231`) starts with `this.releaseAllFor(claimant.taskId)`, under the comment "One claim per task (PR 1)". One claim per task is a registry invariant, and at least 10 server consumers read the single `issueClaim` field. The rest of this section is kept only as a record of the original claim.
- **In memory, a task can already hold several keys.**
  - `IssueClaimRegistry.owners` is a map from `key` to `taskId`. `claim()` is synchronous compare-and-set and re-entrant for the owner.
  - `releaseAllFor(taskId)` loops over **all** keys owned by the task (`src/core/issue-claim-registry.ts`).
  - The POST `/claims` route accepts any live `taskId` (`src/server/routes/issue-claim-routes.ts:50+`).
- **On disk, the projection holds one claim.** It is `Task.issueClaim?: IssueClaim` (`src/core/issue-claim-types.ts:97`). Each grant writes `port.setIssueClaim(taskId, claim)`, and `rebuildFromTasks()` restores one key per task at boot. A task that holds two claims therefore loses one of them across a server restart, which reopens the race window for the lost issue.
- `kookr spawn --claim-issue <n>` takes exactly one number (`bin/kookr-spawn.js:272, 444-447`).
- **So the real gap is a durable multi-claim per task, plus all-or-nothing acquisition, not a "transfer" between tasks.**

## 4. The operator's handwritten instruction (the motivating evidence)

In session e468f92d on 2026-11-14, the operator pasted this efficiency instruction into a task:

> "Implement issues in an efficient/fast way (parallizing, grouping issues in a single PR, etc.) according to best practices recommanded in existing skills. Suggest how to proceed so that i can validate you have the proper understanding"

The run that followed did all of this by hand, outside any playbook:
- it triaged 11 open issues;
- it skipped 7 `automation-blocked` issues and 1 that an existing PR already covered;
- it proposed a plan with 2 PRs and **one multi-issue PR** (#1258 + #1254), and waited for approval;
- it ran a lead plus parallel implementers, plus blind test writers given only the spec, following `agent-fleet-orchestration` "Coding fleets";
- it got an independent review and a gate on each head;
- it merged and filed follow-up issues;
- it spawned child tasks, including a 3-issue batch PR.

The result was 3 PRs merged in about 4 hours, with 1 BLOCK found and fixed by the reviewer. The cost was the operator having to write the strategy by hand.

## 5. What the skills prescribe

- **`agent-fleet-orchestration` "Coding fleets"** (an untested pilot):
  - the lead writes a spec and a strong model writes a plan;
  - an implementer gets spec plus plan, while a test writer gets the spec only, in a separate context;
  - the gate is the blind tests, checked by the lead;
  - cherry-pick one commit per issue onto the batch branch; review each commit's diff on its own;
  - route by observable features (more than one module, failed before, no clear spec → one strong agent outside the batch), never by an LLM rating how hard an issue is;
  - retry only the failing issue, at most 2 times.
- **`self-continuation-task`:** one unit per task, chosen from durable state, with a compact envelope; release the slot immediately.
- **`independent-merge-review`:** a fresh-context reviewer at full strength, with an exact-head verdict.
