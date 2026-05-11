# kubernetes/kubernetes PR Patterns

Distilled from analysis of 10 PRs: 7 merged, 3 closed/rejected.
PRs span sizes XS–XXL, covering flake fixes, version bumps, and full KEP implementations.

---

## 1. Process Patterns

### 1.1 Use the full PR template — every field, every time

**Pattern:** Merged PRs that used the complete PR template (What this PR does, Why it's needed, Which issue it fixes, Special notes for reviewers, Does this PR introduce a user-facing change) moved through review faster and attracted fewer "what's the scope?" clarification rounds.

**Evidence:** #138035 (XS, CDI bump) used the full template and self-hold with documented testing; it merged cleanly with re-lgtm after rebase. #138059 (flake fix) used only a partial template and suffered an 11-day queue delay plus an independent maintainer stress-test before trust was established.

**Guideline:** Fill every template section. For the "Does this PR introduce a user-facing change?" field, answer it explicitly even if the answer is "No — internal refactor only." Leaving it blank signals incomplete preparation and invites reviewers to fill the gap themselves, which costs their time and yours.

---

### 1.2 Self-triage with correct labels from day 1

**Pattern:** Authors who apply the right SIG labels, kind labels (`kind/bug`, `kind/feature`, `kind/flake`), and priority labels at creation time reduce the time their PR spends invisible in the queue.

**Evidence:** #138199 (version drift fix) was self-triaged. #132181 (health check feature) lacked SIG buy-in from the start and was held on day 2 for missing label alignment with a SIG discussion that had never happened.

**Guideline:** Before opening, identify the owning SIG (check `OWNERS` files up the path from your change). Apply `/sig <name>` and `/kind <type>` in the PR body or as a first comment. Do not wait for a bot or reviewer to do this — it signals that you understand the project's triage flow.

---

### 1.3 OWNERS gates are sequential and non-negotiable

**Pattern:** kubernetes/kubernetes uses a two-gate review model: `lgtm` (approves the code looks correct) from a reviewer, then `approve` from an OWNERS approver (often a different person). Both are required. Force-pushing after an LGTM invalidates it automatically — the bot removes the label.

**Evidence:** #138199's LGTM was invalidated by a force push and had to be re-earned. #138035 explicitly did a rebase and triggered a `/lgtm` re-grant. #134627 (gRPC API) hit the API approver bottleneck — passing code review does not bypass the approver gate.

**Guideline:** After receiving LGTM, do not rebase, amend, or force-push unless you have discussed it with the reviewer and they have agreed to re-lgtm. If you must rebase (e.g., merge conflict), notify the reviewer with `/cc @reviewer` and a note explaining exactly what changed. For large KEP PRs, identify your API approver early and loop them in before the final round — they are often a separate person from your reviewer.

---

### 1.4 The `build/dependencies.yaml` pipeline convention

**Pattern:** Version bump PRs that touch dependencies must update `build/dependencies.yaml` in a specific format that the release pipeline consumes. This is not obvious from the diff alone.

**Evidence:** #138199 followed this convention correctly for a version drift fix. PRs that omit it fail CI in a confusing way.

**Guideline:** For any dependency version change, check whether `build/dependencies.yaml` needs a corresponding entry. Search the file for the dependency name before submitting. If your CI fails with a pipeline-related error, this file is the first place to look.

---

### 1.5 Urgency framing unlocks faster review

**Pattern:** PRs that explain *why urgency matters* (release deadline, user-facing regression, blocked downstream work) are triaged higher than equivalent PRs without that context.

**Evidence:** #138199 needed urgency framing to compete with a large queue. #138178 (liggitt's flake fix) closed in 2.5 hours partly because the author's OWNERS status created implicit urgency, but the causal chain in the body communicated impact clearly.

**Guideline:** If your PR is time-sensitive, say so in the first paragraph of the PR body with a specific deadline or consequence: "This blocks the v1.32 release cut scheduled for [date]" or "This is a regression introduced in #NNNNN affecting production clusters." Vague urgency claims are ignored; specific ones are acted on.

---

## 2. Commit Discipline

### 2.1 Imperative mood in commit subjects

**Pattern:** kubernetes/kubernetes expects commit subjects in the imperative mood ("Fix flaky test" not "Fixed flaky test" or "Fixing flaky test"). Violation is a common first-pass review comment that delays the LGTM.

**Evidence:** #138059 missed imperative mood on its commit and received a correction comment, contributing to its queue delay.

**Guideline:** Write commit subjects as commands: "Add", "Fix", "Remove", "Refactor", "Update". Before pushing, read your commit subject aloud as if completing the sentence "If applied, this commit will…" — if it reads naturally, the mood is correct.

---

### 2.2 Squash fixup commits before requesting final review

**Pattern:** Reviewers tolerate WIP fixup commits during the review cycle but expect them squashed before the final LGTM. Leaving fixups in the history signals the PR is not ready for merge.

**Evidence:** #138059 and #134627 both had fixup commits that needed cleanup. #138178 (maintainer merge) used a single atomic commit — one commit, one logical change, clean history.

**Guideline:** Before requesting final review (or after your last round of changes), run `git rebase -i origin/master` and squash all fixup commits into the logical commit they fix. Aim for one commit per logical change. The PR can have multiple commits if the changes are genuinely independent, but each must be self-contained and have a clean message.

---

### 2.3 `kep-NNNN:` prefix for KEP-implementing commits

**Pattern:** Commits that implement a KEP (Kubernetes Enhancement Proposal) use the `kep-NNNN:` prefix in the commit subject, where NNNN is the KEP number. This makes the release-note generation and changelog tooling work correctly.

**Evidence:** #138035 used the `kep-NNNN:` prefix explicitly and it was noted as correct practice in the review.

**Guideline:** If your PR implements or advances a KEP, prefix all commits with `kep-NNNN: ` (e.g., `kep-4188: Add gRPC API for device plugin`). Check the KEP directory (`keps/`) to confirm the KEP number. For non-KEP changes, do not add a prefix — it implies KEP tracking that doesn't exist.

---

### 2.4 No issue links in commit messages

**Pattern:** kubernetes/kubernetes does not use `Fixes #NNN` or `Closes #NNN` in commit messages. Issue references belong in the PR body only. Adding them to commits creates noise in the git log and can trigger unintended issue-closing behavior.

**Evidence:** The repo's commit conventions are consistent across all analyzed PRs — issue references appear only in PR descriptions, not commit messages.

**Guideline:** Put issue references (`Fixes #NNN`, `Related to #NNN`) in the PR body under the "Which issue(s) this PR fixes" section. Keep commit messages free of issue links. The one exception is the `kep-NNNN:` prefix, which is a KEP reference, not a GitHub issue link.

---

### 2.5 Single atomic commit for self-contained fixes

**Pattern:** Small, self-contained fixes (flakes, typos, version bumps) should land as a single commit. This makes cherry-picks, reverts, and `git blame` straightforward.

**Evidence:** #138178 (liggitt's 2.5-hour merge) was a single atomic commit. #138035 (XS CDI bump) similarly had a clean single-commit history.

**Guideline:** For XS and S PRs, target a single commit. If you end up with multiple commits during development, squash before marking ready for review. For M–XXL PRs, multiple commits are acceptable if each is genuinely independent, but document the commit structure in the PR body.

---

## 3. Review Dynamics

### 3.1 Queue times scale non-linearly with PR size

**Pattern:** XS and S PRs from contributors with OWNERS status can merge in hours. XS/S PRs from external contributors take days to weeks. M–L PRs take weeks. XL–XXL KEP PRs take months and require 4+ review rounds.

**Evidence:**
- #138178 (S, maintainer): 2.5 hours
- #138035 (XS, CDI bump): fast, self-hold resolved quickly
- #138059 (S, flake fix, external): 11-day queue delay
- #134660 (XL, KEP): 151 days, 4+ rounds
- #134627 (XXL, KEP): 5 months, multi-round

**Guideline:** Set realistic expectations per PR size. For XL–XXL KEP work, plan for 3–6 months from first draft to merge. Build this into project timelines. Do not interpret silence as rejection — the queue is long. Use `/ping` sparingly (no more than once per 2 weeks) and pair it with a status update ("rebased on latest master, addressed all open comments").

---

### 3.2 Proto/API type errors must be caught before first review submission

**Pattern:** Type errors in `.proto` files or generated API types that surface on day 0 of review are expensive: they signal incomplete local verification, erode reviewer trust, and add a full round-trip before substantive review begins.

**Evidence:** #134627 (gRPC API) had a proto type error on day 0 that cost a full review round before any API design discussion could happen.

**Guideline:** For any PR touching `.proto` files or generated API types, run `make generate` locally and verify the generated code compiles before submitting. Add `make verify` to your pre-submission checklist. If the project has a `hack/verify-*.sh` script for your area, run it.

---

### 3.3 LGTM-with-hold is a coordination signal, not rejection

**Pattern:** Reviewers use the `lgtm` + `/hold` combination to signal "the code is correct but I want another reviewer or the author to address X before merge." This is a positive signal — it means you're close.

**Evidence:** #137032 (KEP-5547 Workload APIs) showed the LGTM-with-hold pattern across 5 reviewers managing scope negotiation and feature gate hygiene while not blocking code correctness sign-off.

**Guideline:** When you receive LGTM + hold, read the hold reason carefully. It is almost always either (a) a scope concern that needs SIG discussion or (b) a dependency on another PR. Respond to the hold reason specifically — don't just ping for resolution. If the hold reason is a SIG concern, post to the SIG mailing list or Slack and link the thread in the PR.

---

### 3.4 Performance objections require quantitative responses

**Pattern:** Reviewers who raise performance concerns (especially in critical paths like CRI calls) expect benchmark data, not reasoning. "This is infrequent" is not sufficient — "This adds 0.3ms to pod startup in the p99 case, measured by benchmark X" is.

**Evidence:** #134660 (RuntimeHelper) faced a performance objection about CRI call overhead. The objection required multiple rounds to resolve because the initial response was qualitative.

**Guideline:** If your PR touches a hot path (scheduling, container lifecycle, network dataplane), prepare microbenchmarks before submitting. If a performance objection arises during review, respond with numbers from `go test -bench` or a relevant e2e benchmark. Include the benchmark command so reviewers can reproduce it.

---

### 3.5 E2E tests are demanded mid-review for behavioral changes

**Pattern:** For PRs that change runtime behavior (not just code structure), reviewers will demand e2e tests even if unit tests exist. This requirement often surfaces mid-review, not at submission time.

**Evidence:** #134660 had e2e tests demanded mid-review despite having unit test coverage, because the behavioral change (RuntimeHelper lifecycle) needed integration-level verification.

**Guideline:** For any PR that changes observable cluster behavior, add e2e tests preemptively. Check `test/e2e/` for existing test patterns in your area. If you're unsure whether e2e tests are needed, ask in the PR body: "I've added unit tests. Should I also add e2e coverage for X?" — asking is better than having the reviewer demand it later.

---

## 4. KEP Implementation Patterns

### 4.1 Scope negotiation is an expected part of the process

**Pattern:** Large KEP PRs routinely negotiate scope mid-review — features get deferred to beta, optional fields get dropped, and implementation phases get reordered. This is normal, not a failure.

**Evidence:** #134627 descoped `FieldMask` mid-review after API approver feedback. #137032 documented "deferred-to-beta" items explicitly in the PR body.

**Guideline:** When opening a KEP implementation PR, explicitly list what is in scope and what is deliberately deferred. Use a "Not in this PR" section in the body. This preempts scope negotiation by starting the conversation proactively. When a reviewer asks to defer a feature, agree quickly and document the deferral in the KEP itself — this makes the next PR's scope clear.

---

### 4.2 Dependency sequencing must be explicit

**Pattern:** KEP implementations often depend on other in-flight PRs (API changes, infrastructure changes, generated code). Failing to document dependencies leads to merge ordering problems and reviewer confusion.

**Evidence:** #134627 (gRPC API) had dependency on generated proto code that wasn't clearly sequenced, causing confusion about what to review first.

**Guideline:** List dependent PRs explicitly in the body: "This PR depends on #NNNNN (merged) and #NNNNN (in review). It can be reviewed independently but should not merge until both dependencies land." Use the `Depends-On` convention if the project supports it. For generated code, land the generator change first and reference it.

---

### 4.3 Feature gate hygiene is non-negotiable

**Pattern:** New features must be gated behind a feature flag with the correct `featureGate` annotation, default value (usually `false` for alpha), and documentation. Missing or incorrectly configured feature gates are a blocking review comment.

**Evidence:** #137032 (KEP-5547) required feature gate hygiene review across 5 reviewers. Getting this wrong would have blocked merge regardless of code correctness.

**Guideline:** For any alpha or beta feature, search for `featureGates` in existing code to understand the pattern. Ensure your feature gate: (1) is registered in `pkg/features/`, (2) has the correct default for its stage (`false` for alpha, possibly `true` for beta with explicit SIG approval), (3) is consistently checked at all use sites, and (4) has a corresponding entry in the API documentation or KEP. Run `hack/verify-feature-flags.sh` if it exists.

---

### 4.4 API approvers are a separate bottleneck from code reviewers

**Pattern:** For PRs touching the Kubernetes API (types, validation, conversion), the API approver (`sig-architecture` or API machinery team) is a distinct gate from the code reviewer. A PR can have 3+ LGTMs and still wait weeks for the API approver.

**Evidence:** #134627 explicitly hit the API approver bottleneck after passing code review.

**Guideline:** Identify your API approver early by checking `staging/src/k8s.io/api/OWNERS` and `OWNERS_ALIASES`. Ping them with `/cc @approver` in the PR body at submission time, not after code review completes. Consider asking for a preliminary API review on the design before writing implementation code.

---

### 4.5 Deep subsystem knowledge is a prerequisite, not an asset

**Pattern:** XXL KEP PRs in specialized subsystems (device plugins, scheduler, network) require contributors who already understand the subsystem deeply. PRs from contributors without demonstrated subsystem context receive more skeptical review.

**Evidence:** #134627 (gRPC API for device plugin) and #134660 (RuntimeHelper) both required multi-round deep dives that would have been impossible without pre-existing subsystem knowledge.

**Guideline:** Before contributing to a specialized subsystem, read the existing code, attend SIG meetings, and comment on related issues or PRs first. Build a visible track record. A PR from a known contributor in a subsystem will receive faster, more collaborative review than an identical PR from an unknown contributor.

---

## 5. Flake/Bug Fix Patterns

### 5.1 Empirical evidence is the entry ticket for flake fixes

**Pattern:** Flake fix PRs are not taken on faith. Reviewers expect test history, failure logs, or CI run links that demonstrate the flake exists and that the fix addresses the root cause, not a symptom.

**Evidence:** #138059 required the maintainer to stress-test the fix independently before trusting it. #138178 (liggitt's fix) included a full causal chain in the PR body, which accelerated review to 2.5 hours.

**Guideline:** For flake fixes, include in the PR body: (1) a link to 2–5 CI failures showing the flake, (2) the failure log excerpt that shows the root cause, (3) an explanation of why the fix addresses the root cause rather than the symptom, and (4) optionally, a link to a CI run after the fix. "This test sometimes fails" is not evidence — "This test fails in 3 of the last 10 runs on CI [links] because of a race between X and Y" is.

---

### 5.2 Causal chain in the PR body, not just in comments

**Pattern:** The most efficiently reviewed bug/flake fixes include a causal chain — "A happens, which causes B, which causes C to fail" — written in the PR body, not discovered by reviewers through comments.

**Evidence:** #138178 (2.5-hour merge) had the full causal chain documented in the body. Reviewers did not need to ask "but why does this fix it?" — the answer was already there.

**Guideline:** Structure the PR body for bug/flake fixes as: (1) Symptom (what the user/CI sees), (2) Root cause (what is actually wrong), (3) Fix (what this PR changes and why it addresses the root cause), (4) Test plan (how you verified the fix). Use plain language — no jargon that assumes subsystem knowledge the reviewer may not have.

---

### 5.3 Document `/retest` usage and policy compliance

**Pattern:** `/retest` is a Prow command that re-runs failed CI jobs. It has a rate limit and should be used with justification, not as a reflexive response to any red CI. Reviewers notice if you `/retest` without explanation.

**Evidence:** #138178 used `/retest` with explicit documentation of why the retest was warranted (pre-existing flake unrelated to the change, with a link to the flake tracking issue).

**Guideline:** When using `/retest`, add a comment explaining: (1) which job failed, (2) whether the failure is pre-existing/known, and (3) a link to evidence (known flake issue, unrelated failure log). Never use `/retest` as a way to hope CI passes without understanding why it failed.

---

### 5.4 Self-hold + documented testing for dependency bumps

**Pattern:** For version/dependency bumps (even XS), authors who self-hold with documented test results (built, ran tests, verified no regressions) build reviewer trust and accelerate merge.

**Evidence:** #138035 (CDI bump) used a self-hold explicitly to document that the author had tested the bump before releasing it for review.

**Guideline:** For dependency bumps, add a "Testing" section to the PR body: "Built with this bump: `make`. Ran unit tests: `go test ./...`. Ran relevant e2e: [link to CI run or manual test output]." Self-hold until this section is complete, then `/hold cancel` when ready.

---

## 6. Anti-Patterns from Rejected PRs

### 6.1 Code before design (no SIG buy-in)

**Pattern:** PRs that implement features without prior SIG discussion are held immediately ("not discussed with SIG") and rarely recover. The hold typically comes on day 2 from a senior reviewer who gates on process, not code quality.

**Evidence:** #132181 (health check feature) was held on day 2 with "not discussed with SIG." Despite 10 months of pinging, it was never unblocked and became rotten.

**Guideline:** Before writing a single line of implementation code for a non-trivial feature: (1) post to the relevant SIG mailing list or Slack with a design sketch and get explicit "+1" responses, (2) open a KEP if the change is significant, and (3) attend the SIG meeting to present the proposal if it's controversial. Only then write the implementation PR. The PR body should reference the SIG discussion: "Discussed at SIG-Node 2024-11-15 meeting [link]; consensus was to proceed with approach X."

---

### 6.2 Pinging without resolving

**Pattern:** Pinging reviewers repeatedly without addressing the blocking concern (SIG discussion, design question, test gap) does not unblock the PR — it trains reviewers to ignore your pings.

**Evidence:** #132181 accumulated pings over 10 months without addressing the root concern (no SIG buy-in). Each ping was received and ignored because nothing had changed.

**Guideline:** Before pinging, ask: "Has the blocking concern been resolved?" If not, address it first. A ping should always be paired with a status update: "I've now gotten SIG buy-in [link to discussion]. The hold from @reviewer should now be addressable — can you re-review?" Ping at most once every 2 weeks, and only after the concern has changed.

---

### 6.3 `Made-with: <tool>` AI disclosure trailer draws scrutiny

**Pattern:** The `Made-with: Cursor` trailer in #132181's commits drew attention and likely increased reviewer skepticism. The kubernetes project does not have a documented AI disclosure policy, but undisclosed AI-generated code is riskier than disclosed AI-generated code, and disclosed AI-generated code attracts more scrutiny on correctness.

**Evidence:** #132181 used `Made-with: Cursor` trailers. The PR was already troubled by missing SIG buy-in, but the trailer likely added to reviewer caution.

**Guideline:** If using AI tools, do not add proprietary tool trailers (`Made-with: X`) in commit messages — this format is not a kubernetes convention and creates noise. If you want to disclose AI assistance, do it in the PR body (not commits), briefly, and only if it's relevant. The code quality and design process matter more than the tools used. Never let AI tooling substitute for SIG engagement.

---

### 6.4 PR-as-RFC: valid but sets different expectations

**Pattern:** Using a PR to probe a design (rather than propose a ready implementation) is a legitimate pattern in kubernetes, but it must be framed explicitly. An unmarked PR that is actually a design probe will be reviewed as if it's ready for merge, causing confusion.

**Evidence:** #137672 (thockin's design probe) was a PR-as-RFC by a maintainer who understood the pattern. It was closed after productive design discussion and explicitly spawned follow-on work. The pattern worked because the intent was clear.

**Guideline:** If you're opening a PR to probe a design rather than propose a final implementation, mark it clearly: add `[WIP]` or `[RFC]` to the title, add `/hold` in the body, and state explicitly in the first paragraph: "This is a design probe, not a final implementation. I'm opening it to gather feedback on approach X before writing the full implementation." Do not do this as a substitute for a KEP if a KEP is required.

---

### 6.5 Correctness traps: conflated concepts require KEP-level fixes

**Pattern:** Some bugs look like implementation bugs but are actually design ambiguities. Submitting an implementation fix for a design ambiguity will be closed as "this requires a KEP-level discussion" — the fix may be correct in isolation but wrong at the system level.

**Evidence:** #137986 (kube-proxy UDP) conflated two distinct "not-ready" states (pod terminating vs. endpoint not-yet-ready) at the implementation level. The correct fix required clarifying the design at the KEP level, not patching the implementation.

**Guideline:** Before implementing a fix for a systemic behavioral bug, ask: "Does this bug exist because the spec is ambiguous?" If yes, the right path is (1) open an issue documenting the ambiguity, (2) bring it to the relevant SIG for design clarification, and (3) then implement the agreed fix. A PR that implements an opinionated resolution of an unresolved design ambiguity will be closed. Recognize this category early and save everyone's time.

---

## 7. Maintainer Fast-Path

### 7.1 Self-approval via OWNERS is earned, not assumed

**Pattern:** Maintainers with their name in the relevant `OWNERS` file can approve their own PRs. This creates a dramatically faster path (hours vs. weeks) that external contributors cannot replicate. Understanding this explains velocity differences that might otherwise seem arbitrary.

**Evidence:** #138178 (liggitt) merged in 2.5 hours via self-approval. External contributors with identical code quality waited days to weeks.

**Guideline:** Understand the OWNERS hierarchy in your area before estimating review time. If you are not in `OWNERS`, you cannot self-approve. The path to faster reviews is building a track record in the subsystem and eventually getting added to `OWNERS` — this takes multiple merged PRs and sustained engagement with the SIG.

---

### 7.2 Maintainers front-load causal explanation

**Pattern:** Maintainer PRs consistently have more complete PR bodies than contributor PRs of equivalent size. The causal chain, test evidence, and scope boundaries are documented upfront — not extracted through review comments.

**Evidence:** #138178's body had a complete causal chain. This is the maintainer pattern: write the PR body as if you are the reviewer, anticipating every question.

**Guideline:** Write your PR body by imagining you are a reviewer who knows nothing about this change. For each section, ask: "Would a reviewer need to ask a follow-up question here?" If yes, add the answer. The goal is zero clarification comments — every question should be answered before it's asked.

---

### 7.3 Maintainers use `/retest` with documentation, not reflexively

**Pattern:** Maintainers document their `/retest` usage. They don't retest hoping for green — they retest because they've identified a specific pre-existing failure and can point to it.

**Evidence:** #138178 documented the retest rationale explicitly, citing the known flake being unrelated to the change.

**Guideline:** Match maintainer behavior: treat `/retest` as a documented action, not a button to press when CI is red. If you can't explain why the CI failure is unrelated to your change, investigate before retesting.

---

### 7.4 Maintainers engage design concerns at the right level

**Pattern:** When a maintainer sees a design ambiguity, they do not try to fix it in the PR — they either close the PR and redirect to the right forum (SIG meeting, KEP), or they narrow the scope to the unambiguous part.

**Evidence:** #137986 was self-closed by a contributor after recognizing the correctness trap. #137672 was closed by the author after design discussion produced follow-on work. Both closures were clean and constructive.

**Guideline:** Learn to recognize when a PR has hit a design ceiling. Signs: reviewers are disagreeing about what the correct behavior *should be* (not just how to implement it), or a reviewer says "this needs SIG discussion." At that point, close the PR voluntarily, write up the design question clearly, and bring it to the right forum. A voluntary clean close is better than a 10-month rotten PR.

---

### 7.5 Maintainers scope KEP work to what can merge in one cycle

**Pattern:** Experienced contributors scope their KEP PRs to what they know can land in one release cycle, explicitly documenting deferred work. This avoids the multi-cycle limbo that causes KEP PRs to bitrot.

**Evidence:** #137032 (KEP-5547) documented "deferred-to-beta" items explicitly. #138035 (XS bump) scoped narrowly and merged fast. Contrast with #134660 (151 days) where scope was not preemptively bounded.

**Guideline:** Before opening a KEP implementation PR, ask: "What is the minimum viable implementation that (a) passes the KEP graduation criteria for this stage and (b) can merge in the current release window?" Implement only that. Put everything else in a "Future work" section of the PR body and in the KEP itself. Narrow scope that merges beats broad scope that rots.

---

## Summary: External Contributor Checklist

Before opening any PR to kubernetes/kubernetes:

- [ ] SIG buy-in exists (mailing list thread, meeting minutes, or issue comment from a SIG member)
- [ ] KEP opened (if the change is non-trivial or behavioral)
- [ ] PR template filled completely, including user-facing change field
- [ ] Correct labels applied (`/sig`, `/kind`, `/priority`)
- [ ] Commit messages in imperative mood, no issue links
- [ ] `kep-NNNN:` prefix on commits (if implementing a KEP)
- [ ] Fixup commits squashed before first review request
- [ ] `make generate` and `make verify` run locally, output is clean
- [ ] Causal chain documented in PR body (for bug/flake fixes)
- [ ] Test evidence included (links to CI failures and/or post-fix CI run)
- [ ] API approver identified and `/cc`'d at submission (if touching API types)
- [ ] Feature gate correctly registered and consistently checked (if adding a feature)
- [ ] Scope bounded: "Not in this PR" section documents explicit deferrals
- [ ] No `/retest` without documented rationale for why failure is pre-existing
