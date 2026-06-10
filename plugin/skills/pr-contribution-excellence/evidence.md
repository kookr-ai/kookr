# Evidence

## Pattern -> Evidence Index

One row per entry in `patterns.md`. `citations` counts distinct inline
evidence references; when new PRs reinforce an existing pattern,
distillation appends to its evidence list and bumps the count (the dedup
signal) instead of adding a duplicate pattern.

- P1 Description Structure by PR Type — citations: 1 — 50 PRs across all types
- P2 Behavioral Risk Drives Review Effort, Not Line Count — citations: 1 — #15900 34min, #15885 57min, #15903 1hr, #15891 1hr, #15897 2hr, #15909 2hr, #15798 2.5hr, #15789 5hr, #15860 5hr, #15759 8.3hr, #15811 20hr, #15659 28hr, #15693 32hr, #15691 40hr, #15513 2d, #15067 8d
- P3 Scope Discipline Is the #1 External Contributor Concern — citations: 1 — #15513, #15067, #15791, #15691, plus `anomalyco/opencode` `#6170`
- P4 Iterative Bot Self-Review Before Human Review — citations: 1 — #15513 — fcoury invoked @codex review 5 times, engaged with every P2 suggestion
- P5 Transparency About Testing Limitations Builds Trust — citations: 1 — #15897, #15903, #15805, #15789, #15659 — all honestly documented gaps, all merged promptly
- P6 "Does Not Change Behavior" Is a Reviewer Accelerator — citations: 1 — #15813, #15835, #15811, #15661, #15900
- P7 Frame Removals as Eliminating Misleading Behavior — citations: 1 — #15900 — 517 lines deleted, merged in 34 minutes with this framing
- P8 Balanced Review Response: Defend and Concede Appropriately — citations: 1 — #15798, #15691
- P9 Proactive Debugging Narratives Earn Goodwill — citations: 1 — #15798 — framed as proactive investigation, merged in 2.5 hours
- P10 Root Cause Over Symptom Fix — citations: 1 — #15835, #15909, plus `anomalyco/opencode` `#20929` contrasted with `#20928`; n8n-io/n8n #26898 — cited 3 prior failed fix attempts by PR number, explained why each was insufficient → reviewer approved without questions in 4h
- P11 Match Existing Patterns to Reduce Review Burden — citations: 1 — #15860 — 1455-line port merged in 5 hours because it matched the classic `tui` crate pattern
- P12 Trust Tiers Determine Review Speed — citations: 1 — rust-lang/rust — petrochenkov's 7-line compiler change merged in 1.5 days with zero comments; chenyukang's bug fix in 2 days with zero comments; first-time contributor N1ark's PR took 16 days with 45+ review comments
- P13 Cut Scope to Unblock Merges — citations: 1 — rust-lang/rust #153380 — stabilization PR dropped `remainder` method mid-review to unblock the rest of the API; #154320 — only implemented `trim_prefix` without `trim_suffix`, accepted as-is
- P14 Show the Bug Inline in Descriptions — citations: 1 — rust-lang/rust #154185 — showed read/try_read/write/try_write implementations with inline comments highlighting the inconsistency
- P15 Handle Setbacks and Rejections Gracefully — citations: 1 — rust-lang/rust #154200 — first-time contributor's PR was reverted for perf; their response was "I'm learning a lot about the process!" with an immediate plan for improvement; k8s #137986 — author self-closed cleanly after KEP requirement, left a clear pointer for future contributors
- P16 Exact Verification Commands Are Table Stakes — citations: 1 — 50 of 50 merged PRs included verification commands
- P17 Screenshots for CLI/System-Level Changes — citations: 1 — #15693 — 4 terminal screenshots of bwrap behavior on Ubuntu 20.04; #15758 — annotated screenshot of duplicate reasoning
- P18 Follow-Up Sections De-Risk Large Changes — citations: 1 — #15691 — 5 follow-ups for a +1926 line change
- P19 The Prep-Work + Execution PR Pair — citations: 1 — #15810 → #15811, #15812 → #15906
- P20 Cross-Boundary Cleanup Must Be Atomic — citations: 0 — (no inline evidence; see chronological log)
- P21 In Bot-Gated Repos, Process Compliance Comes Before Code Quality — citations: 1 — anomalyco/opencode `#20714`, `#20866`, `#21091`
- P22 Do Not Copy Trusted-Insider Shortcut Patterns As An External Contributor — citations: 2 — anomalyco/opencode merged `#20956`, `#21047`, `#21053`, `#21054`, `#21016`, `#21070` versus externally closed `#20714`, `#21042`, `#21089`, `#11626`, `#7772`, `#7425`; #15906 — 30 files across multiple crate boundaries updated for one field removal
- P23 Process Compliance Before Code Quality — citations: 1 — langchain-ai/langchain — 7/8 rejected PRs auto-closed by bots within 30 seconds for process violations, despite several having high-quality code and tests
- P24 Description Brevity Scales with Change Size — citations: 1 — langchain-ai/langchain — merged PRs averaged 1-sentence descriptions; the 600+ word rejected PR had parameter tables and marketing language
- P25 Claim the Issue Before Writing Any Code — citations: 2 — langchain-ai/langchain #36194 — two contributors raced to submit fixes, both auto-closed; PR refused with "Comment on the issue first to let others know you're planning to work on it"
- P26 Subtool Changes Go to Subtool Repos — citations: 1 — rust-lang/rust #154381 — clippy-only change closed and redirected to rust-lang/rust-clippy
- P27 Use Project-Specific Formatting Tools — citations: 1 — rust-lang/rust #154400 — `cargo fmt` instead of `./x fmt` reformatted 30+ unrelated files, forcing author to abandon PR
- P28 Revert PRs Need Empathy and Structure — citations: 1 — rust-lang/rust #154488 — exemplary revert with "Sorry to be the bearer of bad news" + 4 specific problems + path forward
- P29 Automated/Bulk PRs Are Unwelcome — citations: 1 — rust-lang/rust #154414 — automated security PR closed immediately: "we prefer to not receive automated PRs like this"
- P30 Follow Up on Maintainer Suggestions — citations: 1 — rust-lang/rust #154512 — followed suggestion from prior PR, approved with "Sure, seems fine" in 17 hours
- P31 Survive Stale Bots Through Persistence — citations: 1 — grafana/grafana #111735 — went stale twice, auto-closed once, contributor persisted for 6 months until merge; #114047 — auto-closed TWICE, still merged after 4 months
- P32 Search for Duplicate PRs AND the Target Branch Before Submitting — citations: 1 — grafana/grafana #121041 — perfect PR description with screenshots, closed because fix already merged in #120096; anomalyco/opencode #21178 — high-quality duplicate detected by bot in 60 seconds; #17170 — fix landed independently on dev after 25 days; #19351 — fix landed via direct commit
- P33 Squash-Merge Repos: PR Title IS the Commit Message — citations: 1 — grafana/grafana — PRs with 8, 18, 50, and 59 commits all merged fine; title format `<Area>: Description` used for changelog
- P34 Before/After Visual Evidence Accelerates Review — citations: 1 — grafana/grafana #120880 — 1-line CSS change with before/after table merged in 2.5 days; #121382 — CI fix with quantitative metrics merged in 2.5 days; #119572 — feature with video demos merged with "Tremendous work, well done 💯"
- P35 Expect Both Bot and Human Review — citations: 1 — grafana/grafana #120560 — Copilot found 6 real issues; human reviewer found deeper semantic edge cases; #119572 — Copilot found missing analytics calls and test gaps
- P36 Feature Toggle / Feature Gate Discipline in Large Projects — citations: 1 — grafana/grafana #119572 — reviewer asked "what happens when toggle disabled after data saved?"; led to explicit serialization/toggle decoupling; k8s #137032 — feature gate if-check inside handler flagged by 3 independent reviewers, forced handler registration to be gated instead
- P37 Self-Annotate Critical Diff Lines — citations: 1 — grafana/grafana #121275 — author self-annotated two critical lines, reviewer approved within 35 minutes of annotations
- P38 Split Cross-Layer Changes into Paired PRs — citations: 1 — grafana/grafana #121236 + #121238 — paired backend/client schema PRs merged sequentially; #121521 + #121550 — prerequisite instrumentation merged before dependent feature
- P39 Link to External Evidence When Correcting Documented Drift — citations: 1 — grafana/grafana #121475 — feature flags set to "experimental" contradicted a public "public preview" announcement; PR linked to the whats-new page, got 4 approvals including CTO in 21 hours
- P40 Batch-Address All Review Comments in One Session — citations: 1 — grafana/grafana #118631 — 9 inline comments addressed in ~7 hours after 18-day gap; #120994 — reviewer-preferred approach implemented with commit reference
- P41 Number Stacked PRs with "(1/N)" Convention — citations: 1 — grafana/grafana #120136 — "(1/3
- P42 Document Design Tradeoffs in "Implementation Notes" — citations: 1 — grafana/grafana #121501 — 3 design tradeoffs documented, two silent approvals within 5h; #121034 — NOTE section flagging known limitation prevented confusion; n8n-io/n8n #27688 — "Key decisions for reviewers" section pre-empted bot objections about custom CodeMirror, library choice, and layout; author had crisp "won't fix" answers ready
- P43 Show Migration Evidence for Every Supported Platform — citations: 1 — grafana/grafana #121501 — migration screenshots for 3 DBs contributed to zero-comment approval
- P44 Over-Test to Eliminate Review Comments — citations: 1 — grafana/grafana #121572 — 14:1 ratio, zero comments, 3h to merge; #121498 — 2.4:1 ratio, zero comments, 24min approval
- P45 Close Superseded PRs with Thread Context — citations: 1 — grafana/grafana #121474 — closed after torkelo's UX feedback without a thread reply; the replacement PR #121636 lost review context
- P46 Get Design Alignment Before Coding Non-Trivial Changes — citations: 1 — grafana/grafana #121474 — 2 days of work discarded because a maintainer proposed a fundamentally different UX pattern; k8s #132181 — feature PR held day 2 for missing SIG discussion, rotted 10 months without resolution
- P47 Fix Regression Side-Effects In-PR — citations: 1 — rust-lang/rust #154074 — reviewer flagged diagnostic regression, author fixed in second commit within same PR, approved same day
- P48 Stabilization/Mechanical PRs Are High-Confidence Entry Points — citations: 1 — rust-lang/rust #152253 — stabilization PR, 1 file, +4/-4, approved in 5 hours; #154459 — destabilization, approved after Zulip consensus link
- P49 CC Domain Experts Alongside Assigned Reviewers — citations: 1 — rust-lang/rust #154592 — cc'd chenyukang caught a critical correctness bug (Span-as-key fails with macro expansions
- P50 Stale CI = Abandoned PR in High-Velocity Repos — citations: 1 — langgenius/dify #34227 — CI failures unfixed for 50h, superseded by #34265 which fixed 10 files vs 4 and merged in 6h
- P51 Bot-Delegated Review Culture — citations: 1 — langgenius/dify #32648 — QuantumGhost endorsed Copilot suggestions 3 times; #33044 — Copilot drove 22 comments across 8 review cycles, both Copilot and Gemini feedback drove real code changes
- P52 Verify "Unnecessary" Code Before Removing It — citations: 1 — rust-lang/rust #154399 — expert author misread a comment about extern types, proposed removal, got blocked by 5 domain experts on provenance concerns; gracefully self-closed and filed a comment-improvement PR instead
- P53 Get Policy Buy-In Before Behavioral or Architecture-Level Changes — citations: 1 — rust-lang/rust #153603 — well-implemented argv[0] fallback for current_exe(
- P54 Build a "Pattern Franchise" for Fast Review — citations: 1 — langgenius/dify #33696 — 3rd EnumText PR merged in 2.2h; #34414 — 19th SQLAlchemy migration PR merged in 1.7h (down from 14h on the 1st
- P55 Parity Fixes Are Low-Friction Entry Points — citations: 1 — langgenius/dify #34221 — replicated Console API pattern to Service API, zero code concerns; #33637 — replicated creation-time sync to update-time
- P56 CI Responsiveness > First-Push Perfection — citations: 1 — langgenius/dify #34221 — 2 fixup commits, 6h turnaround, merged in 2.3 days; #33704 — correct code, slow iteration, took 11 days
- P57 In Template-Gated Repos, Equivalent Content Does Not Count As Compliance — citations: 1 — anomalyco/opencode `#21089`, `#21091`, `#21094`
- P58 Eligibility Is Not Maintainer Priority In Stale-Bot Repos — citations: 1 — anomalyco/opencode `#11961`, `#11626`, `#10190`, `#10282`, `#12040`, `#12007`
- P59 Clean Branch History Is A Reviewability Signal — citations: 1 — anomalyco/opencode `#11976`, `#10332`, `#10282`, `#10271`, `#10190`
- P60 Use Hardware-Normalized Metrics for Performance PRs — citations: 1 — ggml-org/llama.cpp `#21527` — 3x tg speedup with 21%->66% BW util merged in 12h; `#21562` — excellent benchmarks but wrong file location still caused rework
- P61 Hardware-Owner Reviewers Substitute for Automated CI — citations: 1 — ggml-org/llama.cpp `#21527` — arthw tested on Arc 770 and confirmed; `#21273` — disclosed "not tested on other backends" and deferred GPU to future PRs
- P62 Before/After Examples Are the Strongest Bug-Fix Description Pattern — citations: 1 — berriai/litellm `#24998` — before/after PII output → silent merge in 2.5 days with zero human comments
- P63 Include Production Error Frequency to Add Urgency — citations: 1 — berriai/litellm `#20261` — production frequency mentioned, merged after community bump; contrast with `#24961` — perfect PR but no urgency signal, silently closed
- P64 You Can Argue With Bots Using Design-Intent Reasoning — citations: 1 — berriai/litellm `#24988` — author pushed back on P1, Greptile acknowledged; `#24440` — author added feature flag for bot score, maintainers told him to remove it
- AP1 Scope Creep from Rebase — citations: 0 — (no inline evidence; see chronological log)
- AP2 Hiding Testing Gaps — citations: 0 — (no inline evidence; see chronological log)
- AP3 Expanding Scope During Review — citations: 0 — (no inline evidence; see chronological log)
- AP4 Minimal Description for High-Risk Changes — citations: 0 — (no inline evidence; see chronological log)
- AP5 Defensive Responses to Review Feedback — citations: 0 — (no inline evidence; see chronological log)
- AP6 Ignoring or Dismissing Bot Feedback — citations: 0 — (no inline evidence; see chronological log)
- AP7 Leaving Duplicate Branches Open — citations: 0 — (no inline evidence; see chronological log)
- AP8 AI-Generated PR Detection Signals — citations: 1 — rust-lang/rust #154066 — technically correct PR banned as spam due to delivery pattern; #154070 — honest Claude disclosure accepted without issue
- AP9 Rework After Regression, Don't Abandon — citations: 1 — rust-lang/rust #154014 — reworked #152679 after perf regression, moved computation to error path, same reviewer approved
- AP10 Split Mechanical Changes from Controversial Decisions — citations: 1 — rust-lang/rust #154004 — module move split from stabilization; bikeshed deferred to sub-issue #154237
- AP11 AI-Generated Code Without Manual Review — citations: 0 — (no inline evidence; see chronological log)
- AP12 Rephrasing Reviewer-Provided Wording — citations: 0 — (no inline evidence; see chronological log)
- AP13 Sloppy Commit Messages as an External Contributor — citations: 0 — (no inline evidence; see chronological log)
- AP14 Large Features as First Contributions — citations: 0 — (no inline evidence; see chronological log)
- AP15 Self-Filing Issues to Satisfy Process — citations: 0 — (no inline evidence; see chronological log)
- AP16 Massive PRs Without Description — citations: 0 — (no inline evidence; see chronological log)
- AP17 Pinging Maintainers Without Escalation Plan — citations: 0 — (no inline evidence; see chronological log)
- AP18 Drive-By PRs Without Claiming the Issue First — citations: 2 — langgenius/dify #33653 — correct fix closed 13 seconds after competing PR merged; author hadn't read thread where someone claimed the issue 3h earlier; PR refused with "Comment on the issue first to let others know you're planning to work on it, this avoids duplicate effort and PR conflicts"
- AP19 Touching Infrastructure Maintainers Want to Own — citations: 1 — langgenius/dify #34399 — QuantumGhost's narrow Python 3.12 bump closed by maintainer WH-2099, replaced by 97-file modernization PR
- AP20 Broken Diffs from Botched Rebases — citations: 1 — langgenius/dify #33334 — sound concept, died because final diff deleted entire function bodies
- AP21 Enterprise/License-Sensitive Areas Are Off-Limits — citations: 1 — langgenius/dify #29070 — hardcoded `is_allow_create_workspace = True`, bypassing enterprise config, closed in 3 minutes by maintainer: "Please read our License first"
- AP22 Design Correctness > CI Status for Core Infrastructure — citations: 1 — langgenius/dify #33884 — CI green, tests passed, but XREADGROUP with per-subscription unique groups is functionally equivalent to XREAD. Gemini, Copilot, and QuantumGhost all identified the same flaw → superseded
- AP23 Structured Change Tables for Mechanical Refactors — citations: 1 — langgenius/dify #34027 — change table showing 15 queries migrated across 4 files, "zero occurrences remaining in this directory", merged in 14h; #34300 — enumerated columns/write/read sites
- AP24 Use Non-Closing Issue Links for Series Work — citations: 1 — langgenius/dify #34547, #34548, #34503, #34528, #33633, #34527, #34561, #34562, #34563
- AP25 Split Mechanical Series by Review Unit, Not by Narrative — citations: 1 — langgenius/dify #34412 blocked at 16 files despite a strong write-up; successors #34561, #34562, #34563 merged in about 80 minutes each. Same pattern reinforced by #34503 and #34528.
- AP26 Simpler Fix Wins When Competing PRs Exist — citations: 1 — n8n-io/n8n #27796 — 242-addition fix with helper checking headers+null+undefined superseded by #27793's 102-addition one-liner targeting only the actual bug path. Maintainer cited "slightly more elegant fix" when closing.
- AP27 Quantitative Metrics in Performance PR Descriptions — citations: 1 — n8n-io/n8n #27188 — ~250MB memory reduction (1GB→750MB
- AP28 Hiding a Feature Branch Under a Bug-Fix Title — citations: 1 — anomalyco/opencode `#21091`, `#21094`, `#20456`
- AP29 Maintainer Takeover Is a Positive Outcome — citations: 1 — n8n-io/n8n #27814 — new node absorbed into internal branch with authorship preserved; #19758 — maintainer pushed credential restructure directly after 6 months
- AP30 Scope Is a Queue-Time Multiplier in Bandwidth-Constrained Repos — citations: 1 — n8n-io/n8n #19758 — 3 features bundled → 6 months; similar-scope single-feature PRs merged in 1-3 weeks
- AP31 Cite Analogous Existing Code for Instant Credibility — citations: 1 — n8n-io/n8n #24517 — 10-line fix citing existing pattern, instant single-round approval; reinforces general pattern 11
- AP32 Real Tests Over Mocked Tests — citations: 1 — n8n-io/n8n #25810 — reviewer explicitly rejected over-mocked tests; author removed mocks and tested with real functions, approved next day
- AP33 Production Validation from Community Accelerates Merge — citations: 1 — n8n-io/n8n #22859 — two production confirmations spanning 2+ months (v2.1.2 → v2.6.3
- AP34 Scope Expansion Through Review Is a Time Trap — citations: 1 — n8n-io/n8n #17297 — started as 2-file Teams-only change, expanded to 23-file all-Microsoft-Graph-nodes change through review, took 192 days instead of potential weeks; #16612 — 2-file credential change was too shallow, successor needed 35 files
- AP35 AI Submissions Require Human Supervision During Compliance Windows — citations: 1 — anomalyco/opencode `#20704` — technically excellent AI-generated PR with 3 bug fixes, upstream coordination, 4 test artifacts, killed in 2 hours by compliance bot; `#20701` — 707-line feature with screenshots/video, same fate
- AP36 Study Existing Integration Patterns Before Adding New Ones — citations: 1 — anomalyco/opencode `#13765` — initial 200-line provider PR with dynamic model fetching rejected; final 12-line CUSTOM_LOADERS entry merged after author studied existing patterns
- AP37 Sign the CLA Before Opening the PR — citations: 1 — n8n-io/n8n #27171 — technically perfect 1-line fix with excellent description, 0 humans looked in 17 days because CLA unsigned; #26988 — unsigned CLA + other failures = 22 days of bot-only interaction; tensorflow/tensorflow #108327 — CLA never signed, 1500-line PR stale-closed after 71 days with zero code review; #88124 — CLA failure on day 1 may have deprioritized a trivially correct 1-line fix for 12 months
- AP38 Signal Refactor Safety with [no-op] Tags — citations: 1 — grafana/grafana #122041 — 60-file refactor, +624/-581 net +43, merged in 1.5h with single approval after [no-op] tag
- AP39 Debuggability Over DRY — citations: 1 — grafana/grafana #121814 — reviewer flagged helper hiding call-site context; consistent with grafana's observability-first culture
- AP40 Approval ≠ Merge: Follow Up After 3-5 Days — citations: 1 — grafana/grafana #119180 — approved day 1, reviewer never clicked merge, sat 31 days, closed because another PR fixed the same typo first
- AP41 Target Maintainer-Neglected Areas for Fast-Track Merges — citations: 1 — anomalyco/opencode #21134 — maintainer: "I actually love merging things for ACP support because I've been lackluster at maintaining it myself" — merged in 3.5h for an external contributor; #20399 — Cloudflare provider fix attracted domain-expert reviewer from Cloudflare team in 18h
- AP42 Use the Project's Preferred Communication Channel for Follow-Up — citations: 1 — anomalyco/opencode #20272 — maintainer explicitly: "GH notifications are overwhelming" and pointed to Discord
- AP43 Cross-Reviewer Coordination with "LGTM with Hold" — citations: 1 — k8s #137032, #138035 — reviewers used LGTM+hold to coordinate across SIG boundaries; held reviewer response time dropped when authors pinged them directly
- AP44 Self-Imposed Hold with Documented Verification — citations: 1 — k8s #138035 — author self-held, posted test results 48h later, reviewer approved without further questions on the verification aspect
- AP45 Causal Chain in First Paragraph for Regression Fixes — citations: 1 — k8s #138178 — this structure got first-round approval; PRs without the regressing commit link required a round-trip asking "what introduced this?"
- AP46 Document CI Retests with Classification — citations: 1 — k8s #138178 — classified retest comments prevented reviewers from blocking on CI noise; unclassified retests in peer PRs led to reviewer holds pending investigation
- AP47 Performance Awareness and Cache Safety in Subsystem Changes — citations: 1 — k8s #134660 — reviewer caught 3-5 CRI calls/pod/reconcile, forced redesign; DeepCopy violation identified in same PR, caught only in integration test suite
- AP48 Fork-Master Contamination Kills PRs Instantly — citations: 1 — tensorflow/tensorflow #115135 — 5-line TFLite fix buried in 567-line diff from 3 months of fork-master accumulation; author self-corrected to clean #115190 within minutes
- AP49 Adopt Reviewer Design Suggestions — They Improve Outcomes — citations: 1 — tensorflow/tensorflow #105000 — reviewer suggested generalizing `ReadStringsFromEnvVar` with custom delimiters instead of point fix; author adopted, approved; #100869 — reviewer requested `@parameterized` convention, author delivered next day, approved in 48h
- AP50 Second Attempts Win When First Attempts Teach — citations: 1 — tensorflow/tensorflow #100869 — successful second attempt after #99904, itemized 4 improvements from prior feedback, merged in 17 days; #115135 → #115190 self-correction
- AP51 Naive Mechanical Changes Without Verification Are Reputationally Toxic — citations: 1 — tensorflow/tensorflow #111046 — `except:` → `except Exception:` find-and-replace corrupted `if may_exit_via_except:` into syntax error and turned docstring prose "except:" into "except Exception:"; 5 of 38 replacements wrong
- AP52 AI Co-Author Trailers Break CLA Gates — citations: 1 — berriai/litellm #25300 — `Co-Authored-By: claude` created permanent CLA block, forced complete refile; #24268 — body-level AI disclosure merged without issue
- AP53 Self-Correction and Refiling Is a Valid Contributor Pattern — citations: 1 — berriai/litellm #25433 → #25437 — self-closed after 22 minutes when Codecov showed 0% patch coverage; #25300 → #25353 — refiled to fix CLA and cyclic imports
- AP54 Codecov Patch Coverage 0% Is a Red Flag Even When Tests Pass — citations: 1 — berriai/litellm #25433 — all tests passed but 0% patch coverage on handler lines; author self-closed to refile with proper integration tests
- AP55 Follow-Up Fix PRs Build Trust Faster Than New Features — citations: 1 — browser-use/browser-use #4590 — reviewed merged #4514, found 3 security/correctness issues, submitted fix PR that merged in 3h; reinforces general pattern 45
- AP56 Unsolicited Infrastructure PRs Are Dead on Arrival — citations: 1 — browser-use/browser-use #4614 — CI workflow for external skill-publishing tool, +35/-0 across 1 file, closed in 3 days with zero human engagement; no issue, no prior discussion, no maintainer request
- AP57 Resolve CHANGES_REQUESTED Before Merge — Or Face a Revert — citations: 1 — berriai/litellm #25340 — merged over ishaan-berri's CHANGES_REQUESTED, immediately reverted by krrish-berri-2 because the semantic value assignment was wrong; mock tests only verified the keyword arg was passed, not that the value was correct
- AP58 Clear the Bot Round Before Humans Engage — citations: 1 — n8n-io/n8n #27688 — 10 bot comments, all replied to within 2h, human reviewer approved same day; #28021 — @claude /review caught a real test inconsistency that the author fixed before merge; grafana/grafana #120560 — Copilot found 6 real issues before human review
- AP59 Separate Public API Response Shapes from Internal Types — citations: 1 — n8n-io/n8n #27637 — reviewer escalated through 3 rounds to get from raw passthrough to Zod-schema-validated mapper + negative-scope test
- AP60 Issue Invitation Is Not an Open Call — citations: 1 — pydantic/pydantic-ai #5021 — closed in 88 minutes because a different contributor's invitation was hijacked; maintainer closed without reviewing the code
- AP61 Match Fix Complexity to Problem Complexity — citations: 1 — pydantic/pydantic-ai #5003 — maintainer closed a shared utility PR in 4 hours, preferring a one-line `ImportError` → `ModuleNotFoundError` change per provider
- AP62 "Right Fix, Wrong Layer" — Confirm the Fix Belongs Here — citations: 1 — modelcontextprotocol/servers #2812 — 88-day discussion, community pain confirmed, rejected because type coercion belongs in the MCP SDK, not individual servers
- AP63 Empirical Data in PR Descriptions Collapses Review Time — citations: 1 — modelcontextprotocol/servers #3515 — one-line fix with crash-rate data merged in 5 days with zero review comments; #3545 — threat model + test counts → 2-day merge
- AP64 Proactively Ping Reviewers After Queue Timeout — citations: 1 — modelcontextprotocol/servers #3230, #3229 — author pinged olaservo by name referencing related merged PR; batch got attention; #2609 — maintainer self-rescued their own PR after 6 months by refreshing and rebasing
- AP65 Don't Spray-Submit Multiple Similar PRs Simultaneously — citations: 1 — modelcontextprotocol/servers #3643, #3655, #3664 — 3 annotation PRs by same author all bulk-closed within 1 second; competing PR by trusted contributor preferred
- AP66 Use Review Bots as Interactive Pair Programmers — citations: 1 — berriai/litellm #24135 — author used `@greptileai how would you address…` interactively, implemented suggestions as commits, merged in 10h with zero human review; #23532 — 5 interactive Greptile rounds drove quality from initial to production-ready
- AP67 Bundle Docs-Only Changes with Code Changes in High-Volume Repos — citations: 1 — berriai/litellm #16302 — technically correct, CLA-signed, 1-file docs fix stale-closed after 5 months with zero maintainer engagement; community recognized it as valid but no one had merge authority
- AP68 The Two-Ping Rule — Set a PR Budget Before You Start — citations: 1 — browser-use/browser-use #4292 — giulio-leone's technically excellent Windows tunnel fix with issue link, root-cause analysis, and proactive bot-fix commits. Author pinged twice (day 2 and day 5
- AP69 Bot Approval Is Not Design Approval — citations: 1 — browser-use/browser-use #4442 — cubic reported "No issues found across 1 file" on the Bedrock schema fix. Maintainer @laithrw still rejected the PR because the approach (pass raw schema through

> Log entries below predate the 2026-06-10 renumbering and reference the old
> (ambiguous, partially duplicated) pattern numbers.

## Distillation Log (chronological)

- **Distillation #1** (2026-03-26): 10 PRs from openai/codex (#15860, #15892, #15813, #15796, #15835, #15897, #15903, #15067, #15811, #15900)
- **Distillation #2** (2026-03-26): +5 PRs (#15791, #15891, #15885, #15881, #15661). Total: 15 PRs.
- **Distillation #3** (2026-03-27): +15 PRs (#15880, #15877, #15869, #15866, #15864, #15910, #15898, #15805, #15839, #15829, #15759, #15513, #15789, #15798, #15785). Total: 30 PRs.
- **Distillation #4** (2026-03-27): +20 PRs (#15906, #15812, #15825, #15800, #15817, #15758, #15861, #15851, #15749, #15810, #15909, #15784, #15806, #15802, #15820, #15691, #15693, #15659, #15707, #15748). Total: 50 PRs. 48 merged, 2 self-closed duplicates. Includes 3 external contributor PRs (fcoury), multiple Codex-co-authored PRs, full coverage of core/established/team/external tiers.
- **Distillation #5** (2026-03-28): +10 PRs from langchain-ai/langchain (#36320, #36319, #36199, #36298, #36287, #36125, #36289, #36285, #36276, #36271). 3 merged, 7 auto-closed by bots. Added rules 17-19 and anti-patterns 11-12 from process-gate analysis. Total: 60 PRs across 2 repositories.
- **Distillation #6** (2026-03-29): +15 PRs from rust-lang/rust (#153632, #153834, #154110, #154190, #154468, #154200, #154453, #154043, #153821, #154320, #153380, #154472, #154459, #154185, #154504). 14 merged, 1 merged-then-reverted. Added patterns 12-15 (trust tiers, scope cutting, inline bug showing, graceful setback handling). Repo-specific patterns in `~/.claude/rust-lang-rust-pr-lessons/patterns.md`. Total: 75 PRs across 3 repositories.
- **Distillation #7** (2026-03-29): +20 PRs from rust-lang/rust (#154520, #154512, #154502, #154499, #154475, #154515, #154500, #154488, #154485, #154464, #154450, #154431, #154414, #154418, #154410, #154375, #154400, #154394, #154381, #154361). 15 merged, 2 closed-by-author, 2 closed-by-maintainer, 1 self-closed duplicate. Added patterns 24-28 (subtool routing, project-specific formatting, revert protocol, anti-bulk-PR, maintainer suggestion follow-ups). Total: 95 PRs across 3 repositories.
- **Distillation #8** (2026-03-30): +15 PRs from grafana/grafana (#120696, #121355, #118428, #121041, #121382, #120994, #120723, #121334, #112944, #120859, #111735, #114047, #120880, #120560, #119572). 11 merged, 3 closed without merge, 1 deep review case. Added patterns 29-34 (stale bot survival, duplicate prevention, squash-merge awareness, visual evidence, bot+human review, feature toggle discipline) and anti-patterns 13-14. Repo-specific patterns in `~/.claude/grafana-grafana-pr-lessons/patterns.md`. Total: 110 PRs across 4 repositories.
- **Distillation #9** (2026-03-30): +10 PRs from grafana/grafana (#121110, #121374, #121028, #121435, #121370, #121452, #121448, #121266, #121382, #121355). 8 merged, 1 self-closed, 1 replaced. Reinforced patterns 31-34. No new general patterns — Grafana-specific learnings (advisory coverage checks, single-approval gate, Codex bot workflow, Storybook-as-testing, internal export convention) added to repo-specific patterns at `~/.claude/grafana-pr-lessons/patterns.md`. Total: 120 PRs across 4 repositories.
- **Distillation #10** (2026-03-31): +5 PRs from grafana/grafana (#121222, #118631, #121369, #120994, #121275). 5 merged. Added patterns 35-36 (self-annotate critical diff lines, batch-address review comments). Grafana-specific patterns updated with: self-annotation, bugfix description template, post-merge label audit, SDK-study-first, approach pivot risk. Total: 125 PRs across 4 repositories.
- **Distillation #11** (2026-03-31): +10 PRs from grafana/grafana (#121241, #121484, #121473, #121552, #120282, #121550, #121238, #121475, #121521, #121487). 8 merged, 1 closed-by-author, 1 closed-by-maintainer. Added patterns 36-37 (paired cross-layer PRs, external evidence for drift correction). Grafana-specific patterns updated with: feature flag governance, paired PRs, observability PR scrutiny, pattern replication, config snippets, PR ordering dependencies. Total: 135 PRs across 4 repositories.
- **Distillation #12** (2026-04-01): +10 PRs from grafana/grafana (#121499, #119378, #121442, #121498, #121257, #121034, #121490, #121572, #121501, #120136). 9 merged, 1 CI experiment (closed intentionally). Added patterns 39-42 (stacked PR numbering, design tradeoff documentation, migration evidence, over-testing). Grafana-specific patterns updated with: known limitation flagging, fresh-install vs upgrade testing, implicit testing justification, dependency blockers, parameterized tests, manual UI testing, commit convention, docs-in-same-PR, coverage-improving refactors, performance PR causal chains, CI experiment PRs. Total: 145 PRs across 4 repositories.
- **Distillation #13** (2026-04-01): +5 PRs from grafana/grafana (#118432, #121474, #121513, #121444, #121533). 3 merged, 1 closed-by-author (superseded after UX pushback), 1 long-lived merged after stale. Added patterns 43-44 (close superseded PRs with thread context, get UX alignment before coding). Grafana-specific patterns updated with: UX alignment, thread etiquette, cross-repo descriptions, dependency bundling, stale bot paradox, Copilot advisory. Total: 160 PRs across 4 repositories.
- **Distillation #14** (2026-04-01): +10 PRs from rust-lang/rust (#154074, #154301, #148590, #141987, #153603, #154576, #154040, #152432, #153980, #154399). 5 merged, 3 closed-by-author, 2 closed-by-maintainer. Added patterns 45-47 (fix regression side-effects in-PR, verify "unnecessary" code before removing, get policy buy-in before behavioral stdlib changes). Repo-specific patterns at `~/.claude/rust-lang/rust-pr-lessons/patterns.md` (34 patterns covering bots, compiler internals, stdlib, soundness, review dynamics, CI). Total: 170 PRs across 4 repositories.
- **Distillation #15** (2026-04-01): +10 PRs from rust-lang/rust (#154356, #153018, #152935, #153207, #152584, #154459, #152253, #154655, #152492, #154592). 9 merged, 1 closed-by-author. Added general patterns 46-47 (stabilization PRs as entry points, CC domain experts). Repo-specific patterns expanded to 58 (added stability/stabilization, new API conventions, extended test/review/compiler patterns). Total: 180 PRs across 4 repositories.
- **Distillation #16** (2026-04-01): +10 PRs from langgenius/dify (#22658, #34350, #34352, #34158, #34311, #32648, #33105, #34227, #33044, #34241). 5 merged, 2 closed-by-author, 1 closed-by-maintainer, 1 superseded, 1 stale. Added general patterns 48-49 (stale CI = abandoned PR, bot-delegated review culture). Repo-specific patterns (15) at `~/.claude/langgenius-dify-pr-lessons/patterns.md`. Total: 190 PRs across 5 repositories.
- **Distillation #17** (2026-04-01): +10 PRs from langgenius/dify (#34334, #34316, #34325, #34097, #34300, #33657, #29070, #33884, #29983, #34027). 6 merged, 1 closed-by-author, 1 closed-by-maintainer, 2 superseded. Added general anti-patterns 17-19 (enterprise/license areas, design correctness > CI, structured change tables). Dify-specific patterns expanded to 25. Total: 200 PRs across 5 repositories.
- **Distillation #18** (2026-04-05): +15 PRs from langgenius/dify (#34547, #34548, #34532, #34510, #34412, #34563, #34562, #34561, #34505, #33579, #34503, #34528, #33473, #33633, #34527). 12 merged, 2 closed-by-author, 1 closed-by-maintainer. Added general patterns 20-21 (non-closing issue links for series work, split mechanical series by review unit). Dify-specific patterns expanded with refactor-series issue-linking, TypedDict fast-lane, and frontend migration-path expectations. Total: 215 PRs across 5 repositories.
- **Distillation #19** (2026-04-05): +10 PRs from anomalyco/opencode (#20714, #15852, #21042, #20866, #20788, #21104, #21089, #21091, #21094, #20456). 1 merged, 3 auto-closed by bots, 6 closed by authors or superseded. Added general pattern 55 (literal template compliance in bot-gated repos) and anti-pattern 22 (hiding a feature branch under a bug-fix title). Repo-specific patterns at `~/.claude/anomalyco/opencode-pr-lessons/patterns.md`. Total: 225 PRs across 6 repositories.
- **Distillation #20** (2026-04-06): +15 PRs from anomalyco/opencode (#11961, #11945, #11931, #11882, #11850, #11998, #11993, #11976, #11970, #11968, #11626, #10332, #10282, #10271, #10190). 15 closed without merge, mostly stale-closed after green CI but low maintainer priority. Added general patterns 56-57 (eligibility vs priority in stale-bot repos, clean branch history as a reviewability signal). Repo-specific patterns for `opencode` updated with stale-queue, UI-priority, and branch-discipline learnings. Total: 240 PRs across 6 repositories.
- **Distillation #21** (2026-04-06): +10 PRs from n8n-io/n8n (#26550, #16067, #26988, #27814, #21934, #26970, #19758, #26566, #24517, #22510). 6 merged, 4 closed without merge. Added general patterns 58-60 (maintainer takeover as positive outcome, scope as queue-time multiplier, cite analogous code for instant credibility). Repo-specific patterns at `~/.claude/n8n-io-n8n-pr-lessons/patterns.md`. Total: 265 PRs across 7 repositories.
- **Distillation #22** (2026-04-07): +8 new PRs from n8n-io/n8n (#27171, #25810, #22859, #21790, #17297, #19231, #16612, #25883). 5 merged, 3 closed. Added general patterns 61-64 (real tests over mocks, production validation, scope expansion as time multiplier, CLA-first as hard gate). Repo-specific patterns comprehensively updated with merge speed factors, 15-PR evidence base. Total: 273 PRs across 7 repositories.
- **Distillation #23** (2026-04-07): +5 PRs from n8n-io/n8n (#27796, #27947, #27188, #27853, #28110). 3 merged, 2 closed without merge. Added general patterns 22-23 (simpler fix wins in competing PRs, quantitative metrics in performance PRs). Repo-specific patterns expanded with: competing PR dynamics, maintainer community stewardship, defense-in-depth, protocol-level review, AI co-authorship acceptance, founder fast-track. Total: 278 PRs across 7 repositories.
- **Distillation #24** (2026-04-07): +5 PRs from anomalyco/opencode (#20545, #20701, #20704, #17105, #13765). 2 merged, 1 merged after discussion, 2 auto-closed by compliance bot. Added general patterns 65-66 (AI submission supervision during compliance windows, study existing integration patterns before adding new ones). Repo-specific patterns updated with: compliance bot timing (12s flag, 2h window), provider addition patterns (models.dev/CUSTOM_LOADERS), scope reduction responsiveness, AI submission monitoring. Total: 298 PRs across 7 repositories. 1 PR skipped (#20670, accidental/instant close).
- **Distillation #25** (2026-04-08): +10 PRs from ggml-org/llama.cpp (#21558, #21562, #21485, #21257, #21451, #21219, #20238, #21527, #20993, #21273). 6 merged, 4 closed without merge. Added general patterns 67-68 (hardware-normalized metrics for performance PRs, hardware-owner reviewer as CI substitute). Repo-specific patterns at `~/.claude/ggml-org-llama.cpp-pr-lessons/patterns.md` covering: module-specific conventions (webui/SYCL/ggml-cpu/quantization/server/arch), AI disclosure strategy, key maintainers, collaborative culture (direct fixup commits). Total: 308 PRs across 8 repositories. 2 PRs skipped (#21561 duplicate, #21520 accidental).
- **Distillation #25** (2026-04-08): +15 PRs from grafana/grafana (#121271, #119180, #120746, #120909, #121445, #122031, #121789, #121995, #121814, #122043, #122067, #122052, #122041, #122016, #122033). 12 merged, 3 closed without merge. Added general patterns 72-74 (no-op tags for refactors, debuggability over DRY, approval ≠ merge follow-up). Grafana-specific patterns expanded with: approval follow-up, self-review comments, vague title smell, feature toggle retirement, multi-layer deprecation, Codex self-review, debuggability priority, no-op tags, AI Co-Authored-By acceptance, golden file evidence, net-negative line trust, test-as-deliverable, commit SHA references, manual reproduction steps. Total: 313 PRs across 7 repositories.
- **Distillation #26** (2026-04-08): +20 PRs from anomalyco/opencode (#19953, #13748, #20925, #21082, #20589, #20399, #21138, #20272, #10340, #21134, #20180, #21178, #21168, #12236, #12170, #12093, #12127, #9854, #17170, #19351). 8 merged, 3 self-closed by author, 5 stale-closed by bot, 2 auto-closed for template violations, 2 bot-closed after inactivity. Added general patterns 70-71 (target maintainer-neglected areas for fast-track merges, use project's preferred communication channel). Updated pattern 30 (search target branch, not just PRs). Repo-specific patterns at `~/.claude/anomalyco-opencode-pr-lessons/patterns.md` comprehensively updated with: communication channels (Discord), attention accelerators, bot dynamics (Copilot substantive, /review lgtm ≠ approval), branch hygiene (rebase not merge), AI disclosure patterns, graceful self-closing. Total: 333 PRs across 8 repositories. 5 PRs skipped (#21136 accidental, #21118 26s close, #21109 10s close, #12188 draft, #12145 draft).
- **Distillation #27** (2026-04-08): +10 PRs from kubernetes/kubernetes (#137032, #138035, #138178, #132181, #137986, #134660, and 4 additional). Added general patterns 75-79 (LGTM-with-hold coordination, self-imposed hold with verification, causal chain for regression fixes, classified CI retest comments, performance awareness and cache safety). Merged k8s findings into existing patterns: 34 (feature gate hygiene — gates control wiring not execution), 44 (SIG discussion before feature PRs), 51 (KEP-first for architecture-level changes), 15 (graceful self-close with signal). Repo-specific patterns at `~/.claude/kubernetes-kubernetes-pr-lessons/patterns.md`. Total: 343 PRs across 9 repositories.
- **Distillation #28** (2026-04-09): +5 PRs from browser-use/browser-use (#4464, #4587, #4577, #4212, #4489). 5 merged. No new general patterns — browser-use findings reinforced existing patterns (production evidence, focused scope, CLA-first, AI disclosure acceptance). Repo-specific patterns at `~/.claude/skills/pr-contribution-excellence/repo/browser-use-browser-use.md` covering: tabs-not-spaces, no-mock testing, CLA Assistant, bot review culture (cubic-dev-ai/cursor), merge speed factors (production evidence = minutes, benchmarks = hours, clean-but-non-urgent = weeks). Total: 348 PRs across 10 repositories.
- **Distillation #29** (2026-04-09): +5 PRs from BerriAI/litellm (#24268, #24438, #25263, #25337, #25370). 5 merged. No new general patterns — litellm findings strongly reinforce existing patterns 48 (bot-delegated review culture) and 58 (scope as queue-time multiplier). Repo-specific patterns at `~/.claude/skills/pr-contribution-excellence/repo/BerriAI-litellm.md` covering: Greptile as primary quality gate (4/5+ confidence), staging branch targeting, pre-existing CI failure documentation, feature flag discipline, AI disclosure acceptance (CLAUDE.md + AGENTS.md present). Total: 353 PRs across 11 repositories.

## Distillation from pydantic/pydantic-ai (2026-04-09, 2 rounds)

### Distillation #1 (5 PRs)
- **Illustrative starting point culture** — new repo-specific pattern: maintainers rewrite large feature PRs (evidence: PR #4865)
- **Umbrella migration issues** — reinforces general pattern of picking pre-scoped tasks (evidence: PR #4945 via issue #4818)
- **Advisory bot reviews** — new repo-specific nuance: push back with evidence when wrong (evidence: PR #4911)
- **PR Guard bot enforcement** — new repo-specific: auto-closes duplicate PRs and PRs targeting closed issues
- **Reviewer-specific style** — new repo-specific: DouweM does 20+ comments on features, takes over iteration (evidence: PR #4865)

### Distillation #2 (15 PRs)
- Added general pattern 80 (issue invitation is not an open call — evidence: #5021 closed in 88 min)
- Added general pattern 81 (match fix complexity to problem complexity — evidence: #5003 over-engineered, simpler fix existed)
- Added general anti-pattern 23 (submitting code to the wrong package in a monorepo — evidence: #4802 put code in meta-package)
- Expanded repo-specific patterns: bot ecosystem taxonomy (4 bots with different authority levels), reviewer profiles (Kludex, alexmojaki), fast-close taxonomy (2 mechanisms), test convention rules, cross-cutting type change patterns, response culture (16% verbal ratio)
- Reinforced: pre-work search (now with semantic dimension), bot authority levels, 100% branch coverage

### Evidence base (20 PRs total)
- PR #5020 (Ricardo-M-L): Bug fix, merged same day. Exceptional description with per-bug examples.
- PR #4945 (1Ninad): Migration, merged 5 days. Picked umbrella issue from maintainer.
- PR #4865 (Alex-Resch): Feature, merged 8 days. 47 files, DouweM rewrote with Claude.
- PR #4860 (Spectual): Bug fix, merged 6 days. Iterated on Devin bot feedback.
- PR #4911 (majdalsado): Bug fix, merged ~2 hours. Pushed back correctly on wrong bot feedback.
- PR #4053 (otto-sellerstam): Large feature, closed after 79 days. 58 review comments. Replaced with fresh PR.
- PR #5021 (Ricardo-M-L): Feature rejected in 88 min. Wrong contributor jumped invitation.
- PR #5003 (GopalGB): Fix rejected in 4 hours. Over-engineered solution.
- PR #5018 (DougTrajano): Docs merged in 18 hours. Silent approval.
- PR #4108 (15r10nk): Test infra merged after 72 days. Library maintainer, 1 clean commit.
- PR #4123 (DougTrajano): Feature merged after 62 days. 155 review comments (42% bots).
- PR #4687 (JasonCZMeng): Fix merged after 15 days. 54 review comments. Survived duplicate-close.
- PR #4111 (mpfaffenberger): Feature abandoned after round 1. Stale-closed 60 days.
- PR #4894 (NithiN-1808): Feature bot-closed in 11 seconds. Duplicate detection.
- PR #4897 (Yuki-Imajuku): Fix superseded in 12 hours. Perfect process, lost the race.
- PR #4432 (thisisarko): Feature merged after 33 days. 57 review comments. 31-file provider fan-out.
- PR #4661 (jaiwinshah3): Fix merged after 16 days. 63 review comments. OTel semantic debates.
- PR #4402 (syumpx): Example rejected after 44 days. Third-party maintenance burden.
- PR #4802 (jhawpetoss6-collab): Feature rejected. SyntaxError, wrong package, zero tests.
- PR #4970 (Ricardo-M-L): Trivial fix merged in 3 days. Zero friction, AI disclosure accepted.

## Distillation from berriai/litellm (2026-04-09)

### Patterns added
- #84: AI co-author trailers break CLA gates (evidence: PR #25300 — permanent CLA block from `Co-Authored-By: claude`)
- #85: Self-correction and refiling is valid (evidence: PR #25433→#25437, #25300→#25353)
- #86: Codecov patch coverage 0% is a red flag (evidence: PR #25433 — all tests passed but 0% on handler lines)
- #87: Resolve CHANGES_REQUESTED before merge (evidence: PR #25340 — merged over objection, immediately reverted)

### Patterns reinforced
- #64 (Sign CLA before opening PR): now supported by litellm #24496 (unlinked email) and #25300 (AI co-author)
- #48 (Stale CI = abandoned): now supported by litellm #15166 (lint failure killed PR after 108 days)
- #21 (Process compliance before code quality): now supported by litellm #19340 (blank CI section, zero engagement)
- #49 (Bot-delegated review culture): now supported by litellm #24268 (Greptile 3 rounds), #24972 (P1 merged over)
- #66 (Study existing integration patterns): now supported by litellm #23769 (over-scoped by not reading docs)
- #5 (Scope discipline): now supported by litellm #19340 (auth + transformation bundled)

### Evidence base
- PR #25007 (stuxf): Infra migration, merged 7d. 170 files, Greptile refused (>100 files), documented verification.
- PR #25340 (michelligabriele): Fix, merged-then-reverted 1d. Merged over CHANGES_REQUESTED, semantic value wrong.
- PR #19340 (krakenalt): Feature, stale-closed 80d. Zero maintainer engagement, blank CI section, scope creep.
- PR #24268 (acebot712): Guardrail integration, merged 19d. Greptile 3 rounds, 40 tests, AI disclosure accepted.
- PR #24496 (NIK-TIGER-BILL): Fix, abandoned 6d. CLA blocked (unlinked email), no maintainer engagement.
- PR #25433 (joereyna): Fix, self-closed 22min. 0% Codecov patch coverage, refiled as #25437.
- PR #23769 (kedarthakkar): Callback integration, merged 24d. Over-scoped initially, docs requested late, JSON pattern only needed 1 file.
- PR #15166 (danielaskdd): Fix, stale-closed 108d. Lint failure unresolved, superseded by #20750.
- PR #24972 (silencedoctor): Embedding feature, merged 6d. P1 bug merged over, excellent description.
- PR #25300 (matt-greathouse): Provider integration, self-closed 23h. AI co-author CLA block + 6 cyclic imports, refiled as #25353.

## Distillation from browser-use/browser-use (2026-04-10, distillation #4)

### Patterns added
- Pattern 100 (Two-Ping Rule): evidence from PR #4292 (18-day self-close after 2 ignored pings; perfect PR quality but maintainer dead-zone)
- Pattern 101 (Bot Approval ≠ Design Approval): evidence from PR #4442 (cubic clean → laithrw rejection → #4524 using SchemaOptimizer)

### Patterns reinforced
- Competitive Dynamics / Maintainer supersession: 2 new cases (#4442+#4421 → #4524; #4448 → #4512); now 5 observed cases in 35 PRs (~14% of closed external fixes)
- Trust Tiers: 4-minute self-merges by Alezander9 (#4513) and laithrw (#4512) quantify the maintainer-vs-external gap
- Volume-Over-Quality / Platform dead-zone: #4292 reinforces #4030 and passionworkeer's Windows PRs

### Evidence base
- PR #4442: Bedrock schema fix (Thatgfsj, external), 4 days closed. Clean cubic review, but maintainer preferred SchemaOptimizer — rejected on architecture, not code quality.
- PR #4421: Bedrock + SignalHandler (Jah-yee, external), 6 days closed. Scope creep (bundled unrelated signal handler change), cubic flagged both parts with P1/P2 issues; author never responded.
- PR #4292: Windows tunnel.py process checks (giulio-leone, external), 18 days, **self-closed**. Excellent description, issue link, proactive bot-fix commits, 2 polite pings — zero human response. Reinforces that maintainer attention is the binding constraint, not PR quality.
- PR #4513: Benchmark plot update (Alezander9, org member), empty body, merged in 4 minutes. Trust-tier bypasses repo's own "clear justification" rule.
- PR #4512: Linux chromium profile fix (laithrw, maintainer), +6/-2, merged in 4 minutes. Superseded external #4448 (+121/-1) within the same minute — smaller diff wins.

## Distillation from denoland/deno (2026-04-10)

### Patterns added/updated (repo-specific → repo/denoland-deno.md)
- Conventional Commit CI gate + valid prefixes + common scopes (evidence: batches 1-4, every PR)
- Squash merge: PR title is the final commit (evidence: #33020 commit vs title divergence)
- Mandatory AI disclosure — universal even for maintainers (evidence: all 5 batch-4 PRs + #33110, #33226 etc.)
- Clippy `#[allow]` walked back in-PR toward idiomatic fix (evidence: #33224)
- `RUSTFLAGS="-D warnings"` for deletion PRs (evidence: #33222)
- Multi-platform CI matrix is the real gate (evidence: #33154 approved then CI-killed, #33225 cfg(unix) follow-up)
- Superseded-by is the dominant close reason (evidence: #33154→#33230, #33078→#33221, #32888→#33163, #33107→#33080)
- "Too much churn" as a literal close reason on reorg-only PRs (evidence: #32796)
- miracatbot catches self-review gaps on parser/security code (evidence: #33223)
- AI thoroughness = over-scoping anti-pattern; 3-in-1 PRs lose to minimal successor (evidence: #33078 vs #33221, same author)
- Negative-sum changesets merge fastest (evidence: #33222, #33221, #33179, #33196)
- Cross-PR lineage ("Supersedes", "complement to", "Closes") in description (evidence: #33221)
- Upstream reference-implementation grounding (libuv, Node.js) in descriptions (evidence: #33225, #33221)
- Node compat polyfill pattern: polyfills/ → lib.rs register → lazy load → deferred init (evidence: #33226)
- Security fix template: bypass example → enumerated changes → checked test plan (evidence: #33223)
- Grep every early-return when adding normalization (evidence: #33223 SocketAddr fast-path gap)

### Universal patterns reinforced (SKILL.md — no new additions this round)
- "Simpler Fix Wins When Competing PRs Exist" — reinforced by same-author supersede #33078 → #33221
- "Maintainer Takeover Is a Positive Outcome" — variant where author takes over from themselves
- "Match Fix Complexity to Problem Complexity" — reinforced by minimal #33221 beating thorough #33078
- "AI-Generated PR Detection Signals" — reinforced by maintainer rejecting #33094 as "AI slop"

### Evidence base (batch 4: 2026-04-10)
- PR #33225: Platform-gated test constants → CI failure → follow-up cfg(unix) gate commit
- PR #33224: Clippy `#[allow]` walked back to idiomatic struct init within same PR
- PR #33222: Deletion PR with `RUSTFLAGS="-D warnings"` in test plan; bare `refactor:` title accepted
- PR #33221: Successor to #33078; minimal surface fix wins; cross-PR lineage in description
- PR #33020: Test infra fix using uncatchable SIGKILL; commit message `fix(tests):` vs title `test:` resolved by squash

## Distillation from microsoft/vscode (2026-04-10)

### Patterns added/updated
- Repo-specific patterns file created: `repo/microsoft-vscode.md` (based on 15 PRs across 3 batches)
- Reinforced "don't benchmark against vouched-contributor fast path" rule: 14/15 vscode PRs analyzed were insider merges with empty-body human approvals in <2h
- Reinforced "always verify bug on main before coding" rule: #303333 fixed an already-closed issue (9 months stale) and rotted 22 days before auto-closing
- Reinforced "bots are gates, not noise": `copilot-pull-request-reviewer[bot]` caught real bugs on every PR in the batches (type errors, grammar bugs, race conditions, tautological tests)

### Evidence base (batches 1-3)
- **Batch 1**: #308626 (abandoned refactor), #303333 (already-fixed bug, ghost author), #309098 (insider trivial merge), #308339 (insider multi-issue batch with `on-testplan`), #309087 (insider-only `build/hygiene.ts` change)
- **Batch 2**: #307849 (external-style polite pushback with doc citations), #308925 (external gold-standard same-day merge), #308973 (Copilot agent PR with self-review), #308836 (superseded by centralizing #308840), #308857 (AI PR closed despite 2 approvals — stale-HEAD verification + tautological test + CI regression after rebase)
- **Batch 3**: #309054, #309066, #309050, #309058, #309055 — all insider merges illustrating the fast-path (empty approvals, ignored bot feedback, unfilled templates merging anyway)

### VS Code-specific insights worth propagating if seen elsewhere
- Two-gate review systems (CLA + "Community PR Approvals") create a visible velocity gap between insiders and externals
- CODENOTIFY (path-based, bot-driven) is an alternative to CODEOWNERS worth recognizing when you see `vs-code-engineering[bot]` or similar
- "Engineering system lockdown" workflows that hard-block external PRs from `.github/`, `build/`, `package-lock.json` are common in large MS repos
- `on-testplan` label as a manual-QA substitute for inline tests is a VS-Code-specific artifact, not general
