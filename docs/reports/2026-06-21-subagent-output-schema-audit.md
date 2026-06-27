# Subagent Output-Shape Audit — Schema-Force Where Parsed Prose

**Date:** 2026-06-21
**Issue:** [#1089](https://github.com/kookr-ai/kookr/issues/1089) — *Schema-force subagent output only where it is currently parsed prose* (RFC *Agent-Workflow Efficiency & Correctness Improvements* v4, item 6).
**Companion:** [#1088](https://github.com/kookr-ai/kookr/issues/1088) (item 5, named-loop-list / durable-state migration).

## Why

A subagent that returns unstructured prose which an orchestrator then field-extracts is a
correctness risk (mis-parse) and an extra round trip. Forcing a structured output block at
the point a result is *parsed* removes the heuristic and costs ~zero human friction. The fix
is targeted: add a forced schema **only** to agents whose output is parsed as prose, and
**leave already-structured agents untouched**.

## How this repo expresses a "forced output schema"

The load-bearing pattern (exemplar: `reviewer-distillation-judge`,
`plugin/skills/reviewer-distillation-judge/SKILL.md:56-99`): the agent writes its
human-readable reasoning, then ends with **EXACTLY** a documented machine-readable fenced
` ```json ` block; the orchestrator parses that block (not the prose) to compute its result.
The meta skill marks the judge's JSON schema as a contract the orchestrator depends on
(`reviewer-distillation-meta/SKILL.md:159-160`). This audit applies that same form to the one
pure-prose parsed agent below.

## Table 1 — Already structured (leave untouched)

These agents pin an exact output shape (mandatory JSON block, or a fixed table whose columns
drive orchestration). They are **not** changed by this issue.

| Agent / skill | Path | Forced-structure evidence |
|---|---|---|
| reviewer-distillation-judge | `plugin/skills/reviewer-distillation-judge/SKILL.md:56-99` | Mandatory ` ```json ` block; orchestrator parses it (issue's own exemplar). |
| boundary-critic | `plugin/agents/boundary-critic.md:37-54` | `Output format` → Findings table + Verdict line. |
| failure-mode-analyst | `plugin/agents/failure-mode-analyst.md:21-32` | Mode/Likelihood/Impact/Detection table. |
| design-minimalist | `plugin/agents/design-minimalist.md:35-41` | Findings table. |
| ambition-amplifier | `plugin/agents/ambition-amplifier.md:46-64` | Pinned table + Verdict column. |
| assumption-archaeologist | `plugin/agents/assumption-archaeologist.md:41-55` | "Single table only"; `Status` column drives rfc-iterative-review hand-off. |
| operability-reviewer | `plugin/agents/operability-reviewer.md:36-51` | Findings table + Operability Verdict. |
| delivery-pragmatist | `plugin/agents/delivery-pragmatist.md:36-51` | Findings table + Delivery Verdict. |
| module-interface-auditor | `plugin/agents/module-interface-auditor.md:78-113` | Pinned tables. |
| state-machine-verifier | `plugin/agents/state-machine-verifier.md:68-96` | Pinned transition/terminal-state tables. |
| design-experimenter | `plugin/agents/design-experimenter.md:62-78` | Per-claim Verdict enum `HOLDS/FAILS/PARTIAL/CANNOT TEST`. |
| macos-compat-reviewer | `plugin/agents/macos-compat-reviewer.md:25,60` | Pinned per-finding line + verdict. |
| architecture-drift-detector | `plugin/agents/architecture-drift-detector.md:71+` | Scored report tables. |
| dependency-graph-analyzer | `plugin/agents/dependency-graph-analyzer.md:62+` | Layering-violation tables. |
| architecture-smell-scanner | `plugin/agents/architecture-smell-scanner.md:90+` | Pinned report. |
| api-surface-auditor | `plugin/agents/api-surface-auditor.md:62+` | Route/message tables. |
| test-fixer | `plugin/agents/test-fixer.md:131+` | Summary + root-cause table. |
| test-quality-reviewer | `plugin/agents/test-quality-reviewer.md:140+` | Pinned report. |

## Table 2 — Prose-parsed agents (candidates)

| Agent / skill | Path : line | Current output shape | How orchestrator consumes it | Disposition |
|---|---|---|---|---|
| **kookr-oss-issue-scout** (agent) | `.claude/agents/kookr-oss-issue-scout.md:370-446` (Step 9) | **Pure labeled prose** — explicitly "Do not dump raw JSON." Success template embeds `CLAIM COMMAND:` and `File:` lines; abort template is free text. | Caller (`.claude/skills/kookr-oss-issue-scout/SKILL.md:438`) reads the prose to locate the `gh api` claim command + body-file path and **runs it verbatim** to post a public claim. | **SCHEMA-FORCED in this PR.** Highest mis-parse risk: a parsed free-text command line drives a public POST. |
| reviewer-distillation-predict | `plugin/skills/reviewer-distillation-predict/SKILL.md:36-68` | Semi-structured markdown (`### Finding N` with bold fields + `### Overall`). | Judge subagent parses the `### Finding N` / `### Overall` blocks. | **Deferred.** Already documented field set; field carrier is markdown, not pure prose. A move to JSON requires a coordinated change to the judge parser, which the meta skill marks as a load-bearing contract (`reviewer-distillation-meta/SKILL.md:159-160`) — its own unit, not folded in here. |
| reviewer-specialists (conventions / correctness / deadcode / test / a11y) | `plugin/reviewer-specialists/*-specialist.md` | Semi-structured markdown `### Finding N` with a `**Severity**` enum line. | `pre-pr-review/SKILL.md:231` reads the `**Severity**` line to gate blocking vs suggestion (human triage). | **Leave.** Documented severity enum + human-in-the-loop triage; low mis-parse risk. |
| rfc-iterative-review generic critic template | `plugin/skills/rfc-iterative-review/SKILL.md:103-105` | Prose "(1)/(2)/(3) per finding" fallback template. | Human triage: incorporate / reject / defer (`:109`). | **Leave.** Human-judgment consumer, not field-extracted. |
| socratic-challenger | `plugin/agents/socratic-challenger.md:42-50` | **Intentionally prose** — "No headers, no tables, no sections," questions only. | rfc-iterative-review triage (human). | **Leave (carve-out).** Prose is the design intent; output is not field-extracted. Forcing structure would break it. |

## Non-candidates (verified, no field-extraction of subagent prose)

- **codex-pr-critic / oss-pr-critic** — emit a markdown observation block appended to a
  `learnings-raw.md` state file; the distill phase reads the *whole file* for pattern
  recognition, not a per-call record. No mis-parse contract.
- **find-best-reviewers** — spawns no subagent; parses GitHub GraphQL JSON, not prose.
- **reviewer-distillation select / prepare / mutate / meta** — operate on JSON state files
  and write skill files; they do not consume parsed prose from a spawned agent.

## Change applied by this PR

Schema-forced `kookr-oss-issue-scout` only:
- `.claude/agents/kookr-oss-issue-scout.md` Step 9 — after the human-readable summary, the
  agent now ends with EXACTLY a documented ` ```json ` result block for both the **claim** and
  **abort** decisions, carrying the load-bearing fields (`decision`, `issueNumber`,
  `claimBodyFile`, `claimCommand`, `recommendedBranch`, `baseBranch`, `score`).
- `.claude/skills/kookr-oss-issue-scout/SKILL.md` — the caller now parses the trailing JSON
  block (reads `decision`; on `claim`, runs `claimCommand` / `gh api … -F body=@<claimBodyFile>`)
  instead of scraping the prose for the command line.

Both files are Kookr-internal (`.claude/`), so no `plugin/.claude-plugin/plugin.json` bump is
required. No `plugin/` agent was changed.
