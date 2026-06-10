# RFC: Plugin Skill Quality Improvements — Audit Findings and Remediation Plan

**Status:** Draft (v4 — post-review revision, rounds 1–3)
**Date:** 2026-06-10
**Author:** Jean Ibarz (with Claude)
**Implementation branch:** `rfc/plugin-skill-improvements`

---

## Problem

The `kookr-toolkit` plugin ships 58 skills (~11,000 lines of SKILL.md content). They grew organically — distillation loops append to them, new workflows clone old ones, and codebase refactors don't update the guidance that referenced the old layout. Notably, `git log -- plugin/skills/` shows only **21 commits ever**: these files are written once and rarely revisited, so an error sits uncorrected until an agent loads it and acts on it.

A six-agent audit of all 58 skills (2026-06-10), with headline findings hand-verified against this worktree, found systematic gaps in nine recurring themes:

1. **Stale and broken references** — `related:` frontmatter naming skills that don't exist, docs never written, renamed source files, a wrong project name.
2. **Codebase drift** — pattern skills asserting things about Kookr that are no longer (or were never) true.
3. **No dedup-before-generate** — generator skills (trending repos, reviewer suggestions, mockups, new issues, distilled patterns, persisted rules) that never check what already exists before creating more.
4. **No diversity enforcement** — generative skills with no rule forcing distinct outputs.
5. **Hardcoded personal values and unexplained constants** — `jeanibarz` baked into commands (7 files: 2 skills, 5 playbooks); thresholds and version pins with no provenance.
6. **Missing failure handling** — corrupt `state.json`, failed `gh` calls, empty batches, malformed bundles mostly unhandled.
7. **Token bloat** — single skills over 500 and even 1,000 lines; one (`pr-contribution-excellence`) grows unboundedly by design.
8. **Family duplication with silent drift** — `codex-pr-*` vs `oss-pr-*` are 60–95 % copies that have already diverged (a bug fixed on one side persists on the other); the two `rust-lang-rust-*` skills repeat each other.
9. **Missing "when NOT to use" guards** — most descriptions say when to fire but not when to stay quiet.

Verified bugs (each confirmed by `grep`/`ls` against this worktree; one initially-reported bug was *falsified* during verification — see Audit method):

- `codex-pr-distill` writes the **literal string `"TIMESTAMP"`** into `state.json` (`plugin/skills/codex-pr-distill/SKILL.md:169`). The parallel `oss-pr-distill` command is correct — direct evidence of family drift (theme 8).
- `playwright-e2e-patterns` is written for a different project: "E2E testing patterns for **AegisCore** dashboard", `cd packages/e2e` (lines 10, 15–18); Kookr's tests live in `e2e/`.
- `websocket-dashboard` teaches Hono's `upgradeWebSocket` (`hono/bun`, lines 44–45); Kookr's server uses the `ws` library (`src/server/ws-connection-handler.ts`).
- `logging-design-patterns` is built around Pino; `grep -rl pino src/ package.json` returns nothing — Kookr logs via `console`.
- `claude-code-hooks` contradicts itself: "all 25 event types" (lines 3, 21) vs "the definitive enum has exactly 26 valid hook event names" (line 203).
- `rfc-iterative-review` cites `docs/rfc/rfc-hamming-subagents.md`; the file does not exist.
- Cross-reference resolution is split along an undocumented naming convention: playbooks and `related:` fields reference skills **unprefixed** (`oss-pr-state`, `pr-lifecycle`, `oss-repo-recon`), but those skills exist only project-locally under `.claude/skills/` with a `kookr-` prefix (`kookr-oss-pr-state`, …). Locally the references quietly resolve by fuzzy matching or not at all; for **marketplace-installed users**, shipped playbooks (`plugin/playbooks/oss-contribution-pipeline.md`, `oss-pr-lessons.md`) genuinely depend on skills that don't ship with the plugin. Separately, ~25 `related:` targets across 18 skill files resolve to nothing anywhere (`resilience-patterns`, `vitest-bun-mocking`, `caching-strategies`, …).
- `tdd-workflow` directs writes to `docs/requirements/INDEX.md`, `docs/FUNCTIONAL_SPECIFICATIONS.md`, and `PROGRESS.md` — none exist (the real file is the flat `docs/requirements.md`).

These four wrong-stack/wrong-project skills share one root failure mode: **a skill drifted from reality and nothing was positioned to catch it.** That observation drives the design — most of this RFC is one-time cleanup, but the part that matters most is the small set of mechanical checks that keep the cleanup from rotting again.

The toolkit's own ecosystem already shows the target standard: the `repository-idea-scout` playbook (`.kookr/playbooks/`) — the motivating example for this RFC — encodes dedup (`minimumIssueScan: 100` open issues inspected before proposing) and diversity (idea-dimension rotation across product/DX/reliability/…) as first-class parameters. The plugin's generator skills should meet that same bar.

## Requirements

- **R1 (correctness):** No skill may contain a verified-false claim about the codebase, a broken command, or a reference to a nonexistent file/skill/hook/doc.
- **R2 (dedup before generate):** Every skill that generates suggestions or artifacts must check existing state first and exclude/update duplicates instead of re-creating them.
- **R3 (diversity):** Every skill that generates multiple options must state the axis each option must differ on.
- **R4 (portability):** No hardcoded personal username, machine path, or project-specific assumption presented as universal — anywhere under `plugin/` (skills *and* playbooks).
- **R5 (failure paths):** Skills that read state files or call external APIs must define behavior for missing file, malformed content, API failure, and empty result. This applies equally to any *new* state file this RFC introduces.
- **R6 (trigger hygiene):** "When NOT to use" clauses where misfire risk exists; sibling skills with adjacent triggers disambiguate against each other by name.
- **R7 (token economy):** No SKILL.md over ~300 lines without either trimming or a progressive-disclosure split; unbounded-growth files get a cap-and-merge rule.
- **R8 (constants provenance):** Selectively — genuinely opaque constants (version pins, tuned thresholds like F1 deltas) carry a one-line origin + revalidation note. Constants already explained in prose, or obviously proportional, are exempt.
- **R9 (no silent family drift):** Duplicated families either share a common core or carry an explicit divergence note per intentional difference.

R1, R4, R6 (presence of the clause), and R7 (line counts) are **mechanically checkable** and become CI invariants via the existing `scripts/validate-skills.ts` (already run by `npm run validate:skills`); the rest are review-time criteria.

## Audit method

Six parallel read-only agents each covered a thematic group (PR-lessons family; OSS/GitHub workflow; reviewer-distillation + RFC workflow; engineering pattern references; testing/dev workflow; meta/reflection), applying a shared rubric (triggers, dedup, diversity, verification, stale refs, overlap, failure handling, token economy, hardcoded values) with file:line citations. Headline findings were re-verified by hand. Verification both falsified and corrected agent claims:

- *Falsified:* the alleged `oss-pr-distill` timestamp quoting bug — the command is correct; only the codex variant is broken.
- *Corrected (by critics, confirmed by probe):* `oss-pr-plan` already guards the missing `oss-registry-check` hook (exit-code 126/127 branch, lines 52–58) — the remaining fix is only to label the hook "not yet implemented"; `scripts/check-portability.sh` exists (the issue is foreign-repo resolution, not absence); `self-reflect` already delegates to `placement-picker` (line 123) — the previously-claimed "incomplete picker consolidation" is in fact complete.
- *Re-corrected in round 2 (a correction that was itself wrong):* round-1 critics declared the 0.05 convergence threshold "unverified — appears nowhere", because they searched only the skill files. It exists at `.kookr/playbooks/reviewer-distillation.md:119`; the original audit agent was right. The same blind spot produced the round-1 "phantom skills" diagnosis: 7 of the 9 "nonexistent" skills exist under `.claude/skills/` with a `kookr-` prefix.

Two calibration lessons are folded into the plan: (1) every prescriptive item below that depends on a factual claim was probed before being kept; (2) **verification must cover all resolution surfaces** (`plugin/skills/`, `.claude/skills/` with its prefix convention, `plugin/playbooks/`, `.kookr/playbooks/`) — both wrong "corrections" came from grepping only one directory. Soft findings (duplication percentages, "no diversity") carry lower confidence and are scoped accordingly.

## Design

Nine themes, sequenced into four phases. The unifying principle: **fix what's false, then make falseness detectable, then consolidate only where churn justifies it.**

### Theme T1 — Fix verified bugs and broken references

**T1a — mechanical fixes (no semantic change):**

| Fix | Where |
|-----|-------|
| Literal `"TIMESTAMP"` → `"$(date -u +%Y-%m-%dT%H:%M:%SZ)"` (copy the working oss-pr-distill form) | `codex-pr-distill/SKILL.md:169` |
| "AegisCore" → Kookr; `packages/e2e` → `e2e/` | `playwright-e2e-patterns/SKILL.md:10,15–18` |
| `fake-terminal-manager.ts` → `fake-terminal-backend.ts` | `e2e-agent-testing/SKILL.md:56` |
| Phantom paths → flat `docs/requirements.md`; drop the PROGRESS.md step | `tdd-workflow/SKILL.md:24,58` |
| Normalize `related:` syntax to one grammar, then run a full reference inventory (93 distinct targets exist; the audit's 9-name list was **not exhaustive**) and disposition each target three ways: **(a) truly absent** (~25 names across 18 files, e.g. `resilience-patterns`, `vitest-bun-mocking`, `test-quality-discipline`, `caching-strategies` — remove or re-target); **(b) prefix-mismatched** (`pr-lifecycle`, `post-push`, `pre-push`, `oss-repo-recon`, `oss-issue-scout`, `codex-pr-state`, `oss-pr-state`, `session-reflect`, `spawn-child-task` — these exist as `.claude/skills/kookr-*`; do NOT delete; resolve the naming convention instead, see T1-guard); **(c) valid** — leave alone | all of `plugin/skills/` |
| Fix the false glob claim "`*test*` already covers `.spec.` files" (`*.test.ts` does not match `.spec.ts`; use `*.{test,spec}.ts`) | `token-efficiency/SKILL.md:34` |
| Drop the `rfc-hamming-subagents.md` citation; inline its one-line falsifier criterion in place | `rfc-iterative-review/SKILL.md:87` |
| Label the `oss-registry-check` hook reference "(not yet implemented; the existing 126/127 branch already degrades gracefully)" | `oss-pr-plan/SKILL.md:38` |
| Remove or implement the `scripts/lint-execsync.ts` reference | `shell-subprocess-safety/SKILL.md` |
| Relative path → `${CLAUDE_SKILL_DIR}/scripts/init_mbse_docs.py` | `mbse-system-modeling/SKILL.md:52–62` |
| `jeanibarz` → `$(gh api user --jq .login)` in **all 7 files**: `oss-fork-manager`, `github-issue-workflow`, and playbooks `oss-bug-pr`, `oss-pr-lessons`, `oss-bug-fix`, `oss-contribution-pipeline`, `oss-bug-triage` | `plugin/skills/`, `plugin/playbooks/` |

**T1b — content rewrites (these change what the skill teaches; each verified against real source, reviewed separately):**

| Fix | Where |
|-----|-------|
| Rewrite the server section around the `ws` library as actually used (`ws-connection-handler.ts`, `viewer-connection-registry.ts` — reflect the registry pattern, not a generic example); as an interim measure the misleading `hono/bun` section may simply be deleted before the rewrite lands — a skill teaching the wrong API is worse than a shorter skill | `websocket-dashboard/SKILL.md` |
| Reframe as logger-agnostic (Kookr uses `console`) with Pino as a clearly-labelled option, or adopt Pino first — the skill must not document a stack the project doesn't run | `logging-design-patterns/SKILL.md` |
| Resolve the event count by establishing ground truth against the current Claude Code binary/enum — **not** by picking 25 or 26 for internal consistency — then reconcile *all* occurrences including the body header at line 21 | `claude-code-hooks/SKILL.md:3,21,203` |
| Reframe `monorepo-architecture` for reality: Kookr is a single package; scope workspace-specific rules to actual monorepos or retitle as layered-architecture guidance | `monorepo-architecture/SKILL.md` |
| Verify the `~/.claude/telemetry/`, `stats-cache.json`, `history.jsonl` paths and `tengu_*` event names against the installed Claude Code version; correct or caveat | `claude-code-metrics-analysis/SKILL.md:19–25,154–189` |

**T1c — shipped-surface dependency resolution:** `plugin/playbooks/oss-contribution-pipeline.md` and `oss-pr-lessons.md` ship in the marketplace plugin but invoke `oss-repo-recon`, `oss-pr-state`, and `oss-issue-scout`, which exist only as project-local `.claude/skills/kookr-*` / `.claude/agents/` artifacts. For each such reference, decide: (a) promote the referenced skill into `plugin/skills/` so it ships, or (b) make the playbook degrade gracefully with an explicit "requires a Kookr checkout — not bundled" note. The linter's shipped-surface rule (T1-guard) then keeps this class closed. `plugin/playbooks/oss-contribution-pipeline.md:195` also carries the `*-pr-state` pipeline reference and joins the T8/Phase 2 contract decision.

**T1-guard — the reference linter (ships with T1, not after it):** extend `scripts/validate-skills.ts` (exists; already scans `['.claude/skills', 'plugin/skills']`; run via `npm run validate:skills`; ensure CI invokes it) to resolve `related:` entries and `[[wiki-links]]`, check repo-relative paths exist, and flag hardcoded usernames. Specification points settled here, not at implementation time:

- **Resolution scope is the shipped surface.** A reference *from* `plugin/` must resolve *within* `plugin/` — references from shipped content into the dev-only `.claude/` tree are broken for marketplace-installed users even when they resolve locally. References from `.claude/`-scoped content may resolve across both roots.
- **Prefix convention decision — settled by reading `kookr-skill-naming-convention`.** The convention is deliberate and tier-based: `.claude/skills/` names **must** start with `kookr-` (repo-local tier, enforced by `hooks/skill-placement-gate.sh` on push); `plugin/` names are unprefixed (shipped tier). Therefore unprefixed references from `plugin/` content to `kookr-*` artifacts are not a renaming problem — they are **cross-tier dependencies**, and the shipped-surface rule above is the fix: promote the referenced skill into `plugin/` (where it takes an unprefixed name) or degrade gracefully. Renaming shipped refs to `kookr-*` slugs is explicitly wrong — it would bake repo-local names into distributed content (an R4 violation). References inside `.claude/`-scoped content use the prefixed names verbatim.
- **Add `plugin/playbooks/` to the scanned roots** (one line) — five of the seven username-portability files are playbooks, and R4's scope is "anywhere under `plugin/`"; without this the gate covers half the corpus.
- **Exclude fenced code blocks** from `[[wiki-link]]`/`related:` scanning — e.g. `oss-pr-distill/SKILL.md:107` contains a `related:` line inside a template example that would otherwise false-positive.
- **Warning-only first.** Run the linter in warn mode against the full corpus, audit the real backlog (it is larger than the audit's fix table), fix or explicitly waive every hit, and only then flip to failing. The gate must never be enabled while known-broken refs remain.

### Theme T2 — Dedup-before-generate

- **`github-trending-repos`** : add diversity-aware ranking first (see T3) — the cheapest fix for "same famous repos every run". A persistent history file (`~/.claude/trending-repos-history.json`, excluding repos surfaced in the last 30 days) is the second step, added only if diversity rules prove insufficient; if added, it gets the full R5 failure shape (missing → init; malformed → stop, don't default; empty → proceed) and a note that it is per-machine.
- **`github-issue-workflow`**: search existing open issues (`gh issue list --search`) before creating; on a near-duplicate, surface it and ask instead of filing a twin.
- **`ui-mockup-variants`**: check for an existing `<feature>-mockups.html` before generating (this repo's working tree currently holds three stale galleries); offer reuse/extend.
- **`find-best-reviewers`**: fix the non-executable `cutoff = "YYYY-MM-DD"` placeholder (compute it) and implement the documented-but-absent pagination loop. Cross-run suggestion memory is *not* added — repeat invocations can pass "exclude these" explicitly; stateless and idempotent is a feature here.
- **`codex/oss-pr-distill`**: before adding a pattern, check `evidence.md` for an existing equivalent. In Phase 2 this is a duplicate-pattern-*text* check against the current chronological log (the file has no citation counts yet); the citation-count increment arrives only with Phase 3's pattern→evidence index, in that PR.
- **Reflect family + placement-picker**: add the dedup rule **once, in `placement-picker`** (the canonical body all three reflect skills already load): *before persisting a rule, grep CLAUDE.md (user+project), skills, hooks, and memory; if found identical → cite/update; if found with conflicting wording → stop, surface both versions to the user, and treat the inconsistency as the root cause.* The conflict path is an explicit stop-and-ask, not silent resolution, and must respect the existing `type: feedback` memory-frontmatter gate.

### Theme T3 — Diversity enforcement

- **`ui-mockup-variants`**: each variant must occupy a named, distinct design axis (minimal vs information-dense vs animated vs icon-led …); reject galleries where two variants differ only by a token tweak.
- **`github-trending-repos`**: diversify the final ranking across language, domain, and size.
- **`reviewer-distillation-mutate`**: if two consecutive mutations edit the same section/axis with no F1 gain, the next mutation must target a different axis. (Expressed as a prompt rule, not new state — the skill already carries a revert instruction at line 57; sharpen it rather than adding a counter.)

### Theme T4 — Portability and constants provenance

- Username portability is folded into T1a (all 7 files).
- `pre-pr-review`: derive `owner/repo` via `gh repo view --json nameWithOwner` (the `basename` parse breaks on SSH remotes); guard the `scripts/check-portability.sh` call for *foreign* repos where the script won't exist.
- Provenance notes applied **selectively** (per R8): the `v2.1.87+` pin and event count in `claude-code-hooks`, the 0.03 F1 stall delta, and the drift-ratio bands in `architecture-drift-signals` (plus a "calibrate for your codebase" disclaimer and a note that its scan commands are TypeScript-specific). Constants with existing prose justification (e.g., the 200-line distill threshold) are left alone.

### Theme T5 — Failure paths

Add a short "Failure handling" section with a consistent three-case shape (missing → initialize or stop with message; malformed → stop, never default to zero; empty → explicit "nothing to do") to:

- `codex/oss-pr-{plan,threshold,distill}` — `jq empty` validation of `state.json`; empty-batch and repo-exhausted behavior.
- `task-feedback-reflect`, `task-snapshot-reflect` — missing/malformed `bundle.json`, empty `sessions[]` ⇒ report and stop, with the env-var hint.
- `find-best-reviewers`, `github-trending-repos` — GraphQL `errors` array and rate-limit handling.
- `pr-review-triage` — skip the resolve mutation when no thread ID found.
- `self-continuation-task` — all-units-exhausted reporting (failed-unit list + reason codes); atomic read-verify-write on the queue file.
- `ui-mockup-variants` — the "user rejects all variants" path (offer: refine / best-guess / defer).
- `oss-fork-manager` — `|| exit 1` after jq pipelines; existence check on the tracking-template file.

### Theme T6 — Trigger hygiene

Add negative triggers to: `github-issue-workflow` (not for editing/reopening/bulk), `github-trending-repos` (landscape scans only), `pr-review-triage` (only after a PR is open and comments exist), `rust-lang-rust-*` (rust-lang/rust only), `reviewer-distillation-select` vs `oss-pr-lessons` (improve-the-reviewer vs learn-the-repo), and the reflect family, which must disambiguate by name:

- `self-reflect`: any-session correction or self-caught mistake; *not* for Kookr task bundles.
- `task-feedback-reflect`: completed Kookr task with a thumbs rating; *not* for live tasks.
- `task-snapshot-reflect`: live/terminal Kookr task snapshot; *not* for rated, completed tasks. Also gains a one-line pointer to `placement-picker` (the only reflect skill missing it).

`testing-patterns` additionally gains a cross-reference to `e2e-agent-testing` (agent-mock strategy) and a definition of which coverage metric its "<2 % coverage delta" stopping rule means (statement/branch/function).

### Theme T7 — Token economy

| Skill | Today | Action |
|-------|-------|--------|
| `pr-contribution-excellence` | 1,065 lines, grows on every distillation | Split: lean SKILL.md (~150 lines: rules + index) + `patterns.md` + indexed `evidence.md` (pattern→evidence index). **Must land atomically with updates to both distill skills' write targets** (`oss-pr-distill/SKILL.md:45,65–66` and the codex equivalent currently write directly to `…/SKILL.md`) **and with the T2 dedup instruction's source path** (Phase 2 points dedup at the chronological `evidence.md`; the Phase 3 restructure changes that file's shape); otherwise the first post-split distillation re-bloats the index or dedups against a stale structure. The `install-hooks.sh` symlink is directory-level (`scripts/install-hooks.sh:84`), so new companion files resolve through it — verified, no install-script change needed. Add a cap rule: distillation merges/replaces rather than appends forever. |
| `hook-driven-workflow-enforcement` | 533 lines | **Trim, don't split**: cut the worked-examples section; if that lands under ~300 lines, no companion files needed. Add the missing failure-modes notes (jq parse errors, concurrent hook runs, non-git cwd) while in there. |
| `self-reflect` | 318 lines | Front-load the 5-step core; move the category taxonomy's worked examples to a reference file only if trimming can't get it near 300. |
| `async-flow-control` | ~300 lines | Trim duplicated Promise-concurrency items; cross-reference `process-lifecycle-patterns` for shutdown instead of restating it. |
| `find-best-reviewers` / `pre-pr-review` | 40 %/30 % inline code | Extract the Python/shell into `scripts/` files in the skill dir. |

### Theme T8 — Family consolidation (deliberately conservative)

- **`codex-pr-*` vs `oss-pr-*`**: in this RFC, only (a) fix the TIMESTAMP bug (T1a), (b) make both critics state their output destination (`learnings-raw.md`) explicitly, and (c) add a divergence note to each codex skill listing its intentional differences from the oss twin (R9). **Full parameterization (codex as a preset/config of the oss family) is deferred**: the corpus changes ~21 commits/year, and the consolidation's hard part — migrating `~/.claude/codex-pr-lessons/` state to a new slug path without silently losing `processed_prs`/`distillation_count` — has a larger blast radius than the duplication costs at current churn. If a second divergence bug appears, consolidate then, using this procedure: check old state dir exists → copy/symlink to the new slug path → verify schema fields with a `jq` transform → only then retire the codex skills.
- **`rust-lang-rust-tests` + `rust-lang-rust-pre-push`**: merge into one `rust-lang-rust-contributions` skill (*Writing tests → Pre-push checklist → PR description*). The survivor's description carries the union of both keyword sets, both old names appear in the body for grep-ability, and the merge PR includes a **firing-regression fixture**: a short list of prompts each old skill should match, checked against the merged description before landing. Keyword-union is necessary but not sufficient — the fixture is the actual safety net.
- **`event-driven-messaging-patterns` + `realtime-state-sync`**: bidirectional cross-references now; merge **deferred** — neither has a blocking bug, and expanding content during a quality pass is the wrong direction.
- **Discriminated-union guidance**: `typescript-type-safety` owns it; `state-machine-workflow-patterns` and `error-handling-patterns` cross-reference instead of restating.
- The placement-picker consolidation previously believed incomplete is **already done** (`self-reflect:123` delegates correctly); only the `task-snapshot-reflect` pointer (T6) remains.

### Theme T9 — Loop integrity for reviewer-distillation

Led by the measurement-validity problem, because the other fixes are worthless against a corrupted metric:

1. **Measurement validity first.** All F1 numbers the loop produces today are contamination-suspect: nothing prevents scoring on PRs the mutator was tuned against. Until the evaluated corpus reaches ~30+ PRs, a formal hold-out split would leave both partitions too small — so the immediate fix is a caveat in `select`/`judge`/`meta`: *treat F1 as directional, not authoritative*. When the corpus crosses ~30 PRs, introduce a hold-out partition in `select` and report F1 only on held-out PRs.
2. **Phase 0: INITIALIZE** in the playbook (state dirs, `state.json` schema, `v0-base.md` creation) — first run is currently unspecified.
3. **Document and fix the dual-threshold design.** Both thresholds exist — stall at 0.03 (`reviewer-distillation-meta:52,62`, playbook:123) and convergence at 0.05 (`.kookr/playbooks/reviewer-distillation.md:119`) — but their relationship is undocumented and underspecified. Stall has explicit counter pseudocode (`stall_count` with reset-on-miss); convergence ("delta < 0.05 for 2 consecutive iterations", checked first at playbook:116) has **no counter pseudocode at all**, so its consecutiveness semantics are ambiguous. Because every stall-qualifying delta (<0.03) also qualifies for convergence (<0.05), if both counters reach 2 on the same iteration and convergence is checked first, the run stops before meta-mutation fires. The fix must pin three things in one place (the playbook), with `meta` reading rather than re-deriving: (a) convergence's counter semantics (2-consecutive, with its own reset rule), (b) check precedence (stall first; a meta-mutation resets the convergence counter), (c) the invariant `stall < convergence` with its rationale — the 0.03–0.05 band is the meta-mutation window.
4. `judge`: define the missing-ground-truth path (`{"error":"missing_reviews"}`, excluded from aggregates).
5. `mutate`: sharpen the existing revert instruction (line 57) to name the trigger ("if F1 dropped for two consecutive iterations, revert to the best-known version before mutating further") — instruction wording, not new state.

### Staleness detection (upgraded from "alternatives considered")

The four wrong-stack bugs prove the signal is mechanical: *skill claims library X → X absent from `package.json`/`src/` → stale.* Phase 4 adds a library-claim check to `validate-skills.ts`: extract import statements and package names from skill code blocks, warn when a claimed dependency isn't in `package.json`. This is what would have caught the Pino and Hono drift at introduction time; the path-existence linter alone cannot. (Free-form prose claims remain out of scope — this checks code blocks only, keeping false positives low.)

## Per-skill verdict summary

Verdicts: ✅ solid (minor or no actions) · 🔧 needs-work · 🚨 major-issues · 🔀 merge candidate.

**PR-lessons family:** codex-pr-plan ✅ · codex-pr-critic 🔧 (no output destination) · codex-pr-threshold ✅ · codex-pr-distill 🚨 (TIMESTAMP bug; merge semantics undefined) · oss-pr-plan 🔧 (label phantom hook; empty-batch path) · oss-pr-critic 🔧 (no output destination) · oss-pr-threshold ✅ · oss-pr-distill 🔧 (init of missing repo file; merge semantics) · pr-contribution-excellence 🚨 (1,065 lines, unbounded growth, no evidence index).

**OSS/GitHub workflow:** oss-fork-manager 🔧 (hardcoded user; jq error handling) · github-issue-workflow 🔧 (hardcoded assignee; no duplicate-issue search; phantom refs) · github-labels ✅ (reference doc) · github-trending-repos 🚨 (no dedup/diversity) · find-best-reviewers 🔧 (placeholder date; missing pagination; no GraphQL error handling) · pr-review-triage ✅ (guard empty thread ID) · pre-pr-review 🔧 (specialist-dir gate not enforced; fragile repo parsing) · rust-lang-rust-pre-push 🔀 · rust-lang-rust-tests 🔀 · git-commit-discipline ✅.

**Reviewer-distillation + RFC:** select 🔧 (no init spec; no measurement-validity caveat) · prepare ✅ · predict ✅ · judge 🔧 (missing-reviews path) · mutate 🔧 (sharpen revert trigger; diversity rule) · meta 🚨 (no convergence criterion; stall logic only) · rfc-iterative-review 🔧 (phantom citation; no worktree-cleanup step).

**Pattern references:** async-flow-control 🔧 (shutdown overlap) · dependency-injection-patterns ✅ · domain-driven-design ✅ · error-handling-patterns ✅ (cross-ref logging) · event-driven-messaging-patterns 🔧 (cross-ref; merge deferred) · logging-design-patterns 🔧 (Pino vs reality) · monorepo-architecture 🔧 (wrong premise for Kookr) · process-lifecycle-patterns ✅ · realtime-state-sync 🔧 (cross-ref; merge deferred) · shell-subprocess-safety ✅ (one stale script ref) · state-machine-workflow-patterns ✅ (cross-ref TS skill) · typescript-type-safety ✅ · websocket-dashboard 🚨 (teaches the wrong WS stack) · playwright-e2e-patterns 🔧 (wrong project name/paths).

**Testing & dev workflow:** tdd-workflow 🔧 (three phantom paths) · testing-patterns 🔧 (no link to agent-mock strategy; undefined coverage metric) · e2e-agent-testing ✅ (one renamed file) · safe-refactoring ✅ · requirements-engineering ✅ (cross-link tdd-workflow) · token-efficiency 🔧 (wrong glob claim: `*test*` ≠ `.spec.`) · ui-mockup-variants 🔧 (no dedup pre-check; no distinctness rule; contradictory cleanup policy) · self-continuation-task ✅ (state-corruption guard; all-fail reporting).

**Meta & reflection:** claude-code-hooks 🔧 (25/26 contradiction incl. body header; version pin) · claude-code-metrics-analysis 🔧 (unverified telemetry paths) · claude-code-permissions ✅ · hook-driven-workflow-enforcement 🚨 (533 lines; missing failure modes) · placement-picker 🔧 (gains the canonical dedup rule) · self-reflect 🔧 (length; memory-ban enforcement note) · task-feedback-reflect 🔧 (bundle failure paths) · task-snapshot-reflect 🔧 (empty-sessions path; picker pointer) · architecture-drift-signals 🔧 (threshold disclaimer; TS-only note) · mbse-system-modeling ✅ (relative script path).

## Files to change

- `plugin/skills/*/SKILL.md` — per themes T1–T9.
- `plugin/playbooks/oss-{bug-pr,pr-lessons,bug-fix,contribution-pipeline,bug-triage}.md` — username portability (T1a); shipped-surface dependency resolution (T1c).
- `plugin/playbooks/oss-pr-lessons.md`, `plugin/playbooks/oss-contribution-pipeline.md` (line 195), `.kookr/playbooks/codex-pr-lessons.md` — `*-pr-state` reference resolution. `.kookr/playbooks/reviewer-distillation.md` — Phase 0, dual-threshold precedence (T9).
- `scripts/validate-skills.ts` — `related:`/path resolution with shipped-surface rule and prefix decision, `plugin/playbooks/` root, fenced-block exclusion, username check, line-count warning (Phase 1); library-claim check (Phase 4). Ensure CI runs `npm run validate:skills`.
- New supporting files only where splitting wins: `pr-contribution-excellence/{patterns.md,evidence-index}`, extracted scripts for `find-best-reviewers`/`pre-pr-review`.

## Sequencing

- **Phase 1a — mechanical bug fixes + linter.** TIMESTAMP, renames, usernames across all 7 files, the validate-skills.ts extension (the **warn-mode flag is the first commit** — the current script always exits 1, so reference checks added before warn mode would brick CI mid-phase), and a lightweight skill-load counter so load data accumulates during Phases 2–3 and informs their scope. The counter is conditional on first verifying a hook surface actually fires on Skill invocations (e.g. `PreToolUse` with matcher `Skill`) — if none does, demote the counter to Open questions rather than shipping silent-zero telemetry. The `related:` cleanup runs as: normalize grammar → warning-only linter inventory → disposition all hits (absent / cross-tier / valid) → fix → enable gate. The inventory is larger than the audit's fix table (93 distinct targets, ~25 truly phantom across 18 files; the numbers are estimates until the warn-mode run), so this splits into two PRs (fixes; then gate-enable) whenever the inventory exceeds the audit table.
- **Phase 1b — content rewrites.** websocket-dashboard, logging, hooks count (after external ground-truth check), monorepo reframe, metrics-analysis path verification. Each verified against real source; may interim-delete misleading sections. One PR, separate review.
- **Phase 2 — guardrails.** T2/T3/T4/T5/T6 per skill family; the `*-pr-state` contract decision (rename refs to the existing `kookr-*-pr-state` skills, promote them into `plugin/`, or fold state-writes into the critics) lands here, in the PR-lessons family PR, together with the T1c shipped-surface decisions, because both change the critic→distill contract and the plugin's shipped dependency set. Parallelizable; one PR per family.
- **Phase 3 — consolidation.** The rust merge (with firing fixture) and the `pr-contribution-excellence` split. The split PR's atomic boundary explicitly includes: the SKILL.md/patterns.md split, **the `evidence.md` migration from chronological log to pattern→evidence index** (a real migration — 30+ entries), both distill skills' write targets, and the upgrade of their dedup step to citation counts. Each consolidation its own PR.
- **Phase 4 — loop integrity (T9) + library-claim staleness check.** Distillation-loop changes dry-run against real state dirs before merging.

## Edge cases

- **Installed-plugin users:** `install-hooks.sh` symlinks `pr-contribution-excellence` and `reviewer-specialists` at directory level — companion files added inside survive the symlink (verified at `scripts/install-hooks.sh:82–84`). Marketplace installs receive new files on plugin update. The remaining real coupling is the distill write-target atomicity (T7).
- **Skill merges change trigger surfaces:** mitigated by keyword-union + firing-regression fixture; rollback is restoring two files from git history (cheap, no state involved).
- **CI gate ordering:** the linter must not be enabled while known-broken refs remain, or every unrelated PR fails. Phase 1a sequences normalize → fix → enable.
- **History files (if T2's deferred trending-repos history lands):** per-machine, R5 failure shape, and documented as advisory-only; rolling back the skill leaves a stale but harmless file.
- **Distillation runs during Phase 3:** the `pr-contribution-excellence` split PR must update both distill skills in the same commit; a distillation run in a gap would append patterns into the new lean index.
- **Corrected findings are retained in Audit method** rather than silently dropped, so future readers can calibrate trust in the unverified remainder.

## Open questions

- **Skill-load telemetry interpretation.** The counter itself now ships in Phase 1a (it costs one hook line); the open question is the decision rule — how many months of zero loads justifies skipping a skill's Phase 2/3 polish, and who reviews the data before Phase 3 scope is cut.
- **Claude Code hook-event ground truth.** The 25-vs-26 fix requires checking the current binary's enum, which may have moved since v2.1.87. Who owns periodic revalidation?
- **Pattern-skill value.** Several pattern skills are largely textbook content the model already knows, wrapped around a thin project-specific layer. Deletion was rejected this round (irreversible; some distilled signal), but the telemetry question above should reopen it per-skill.

## Alternatives considered

- **Delete generic pattern skills instead of fixing them.** Rejected for now — each contains some project-specific signal, and deletion is irreversible. Revisit with load telemetry (Open questions).
- **Delete (not rewrite) the wrong-stack skills.** Partially adopted: Phase 1b allows interim deletion of misleading sections ahead of the rewrite, since wrong guidance is worse than none.
- **Full codex→oss family consolidation now.** Deferred with a documented trigger (second divergence bug) and a migration procedure sketch — see T8 for the reasoning.
- **One mega-PR.** Rejected: merges change trigger behavior and need isolated review; bug fixes shouldn't wait on consolidation debates.
- **A new standalone `lint-skill-refs.sh`.** Rejected in favor of extending the existing `scripts/validate-skills.ts`, which already parses frontmatter and has a package.json entry.
- **Cron-driven agent staleness audits.** Still deferred — the mechanical library-claim check (Phase 4) captures the proven part of the signal; free-form prose drift detection remains speculative.

## Critic feedback incorporated

Round 1 (2026-06-10) — five critics in parallel; all substantive findings triaged.

- `design-minimalist` 2026-06-10: novel findings — drop `rfc-hamming-subagents.md` creation (inline the citation); trending-repos history file is a band-aid over a ranking problem (diversity rules first); hook-enforcement split → trim instead; circuit-breaker duplicates mutate's existing revert instruction; oss-pr-plan guard already exists; 0.05 threshold unverified; placement-picker consolidation already complete; event-driven/realtime merge is net content increase. **All incorporated.**
- `ambition-amplifier` 2026-06-10: novel findings — CI gate deferral inverts the correct order (the gate prevents re-accumulation; `validate-skills.ts` already exists); hold-out set is architecturally prior to other T9 fixes; library-claim staleness check is proven mechanical, not speculative; `jeanibarz` extends to playbooks. **Incorporated** (hold-out made corpus-size-conditional per the minimalist's counterpoint).
- `failure-mode-analyst` 2026-06-10: novel findings — "no behavior change" mischaracterized Phase 1 (split into 1a/1b); `related:` has 3+ syntaxes so "zero false-positive" was unproven (normalize-first ordering added); hooks fix must cover the line-21 header and establish external ground truth; new history files need R5 too; merges need a firing-regression fixture; install-hooks symlink granularity verified directory-level (risk lower than feared). **All incorporated.**
- `socratic-challenger` 2026-06-10: novel findings — 21-commits-ever churn fact (reframes consolidation ROI and motivates the telemetry open question); "nine themes are one failure mode: drift with nothing to catch it" (adopted as the design's framing sentence); deletion-as-fastest-fix for wrong-stack skills (adopted as interim option); statefulness concern on history files (adopted: stateless-first). **Incorporated.**
- `delivery-pragmatist` 2026-06-10: novel findings — linter to Phase 1; `*-pr-state` decision out of Phase 1; codex state-migration procedure must be concrete (folded into the deferred-consolidation trigger); distill write-target atomicity with the T7 split; jeanibarz full file list. One finding corrected: `plugin/playbooks/codex-pr-lessons.md` "does not exist" — it exists project-locally at `.kookr/playbooks/`. **Incorporated with correction.**

**Adversarial pair resolution (`ambition-amplifier` vs `design-minimalist`):** on codex-family consolidation I side with the minimalist — at 21 commits/year, two annotated copies are cheaper than one shared abstraction plus a state migration — while on CI gating I side with the amplifier, because the audit itself proved the checks are mechanical and the existing `validate-skills.ts` makes them nearly free.

Round 2 (2026-06-10) — four critics on v2.

- `failure-mode-analyst` 2026-06-10: novel finding (**critical**) — the "phantom skills" diagnosis was wrong: 7 of 9 exist as `.claude/skills/kookr-*`; the real defects are a naming-convention split and shipped playbooks depending on non-shipped skills. Executing v2 as written would have deleted working cross-references. **Incorporated** (T1a three-way disposition, T1-guard prefix decision, new T1c).
- `delivery-pragmatist` 2026-06-10: novel findings — the `related:` backlog is ~25 truly-phantom names across 18 files, so the "gate after 100 % fixed" condition was unmeetable with the 9-name table (warning-first inventory added); fenced-code-block false positives (`oss-pr-distill:107`); Phase 2 dedup instruction vs Phase 3 `evidence.md` restructure atomicity. **Incorporated.**
- `ambition-amplifier` 2026-06-10: novel findings — the convergence threshold *does* exist (playbook:119) and the real T9 issue is the undocumented 0.03/0.05 dual-threshold with a meta-mutation reachability bug; `validate-skills.ts` must scan `plugin/playbooks/` or R4 is an invariant for only half the corpus; the skill-load counter should ship in Phase 1a, not remain an open question. **Incorporated.**
- `design-minimalist` 2026-06-10: novel findings — verdict-table ↔ theme gaps (`token-efficiency` glob falsehood → T1a; `testing-patterns` cross-link → T6; `claude-code-metrics-analysis` → T1b; T4 missing from the Phase 2 line; `oss-contribution-pipeline.md` missing from the `*-pr-state` scope). Declared the structure otherwise appropriately scoped. **Incorporated.**

Round 3 (2026-06-10) — verification round, two critics on v3.

- `failure-mode-analyst` 2026-06-10: confirmed all round-2 incorporations faithful and the document internally consistent (no surviving wrong-diagnosis residue). Novel findings — T9's dual-threshold diagnosis was imprecise (both gates require 2 consecutive iterations; convergence lacks counter pseudocode entirely — the fix must pin counter semantics, not just precedence); the prefix decision depended on the unread `kookr-skill-naming-convention` doc. **Incorporated** — the convention doc was then read: it mandates the tier split, settling the decision as promote-or-degrade rather than rename (renaming shipped refs to `kookr-*` would itself violate R4).
- `delivery-pragmatist` 2026-06-10: confirmed sequencing executable with two fixes — the Phase 2 distill dedup must target the chronological `evidence.md` (citation counts arrive with Phase 3's index); the skill-load counter had no verified hook surface; warn-mode must be the first validate-skills commit. **Incorporated.**

Convergence: round 3 produced no objections to the design itself — only precision fixes, all applied. Review stopped here.
