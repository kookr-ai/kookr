# RFC: `kb-scout` — Haiku Subagent for Knowledge Retrieval

## Status

**Draft (v5 — pivoted back to subagent-primary after user feedback that cost-asymmetry was the load-bearing motivation iterative-review had buried)**

**Date:** 2026-05-08
**Author:** Jean Ibarz (with Claude)

---

## TL;DR

You asked for a Haiku subagent because Haiku is faster + cheaper than Opus for retrieval-shaped ranking work. v3/v4 of this RFC pivoted to a deterministic skill that kept everything on Opus — burying that motivation. v5 puts the Haiku subagent back as the primary proposal, accepts honor-system enforcement (the round-2 hook-mutation blocker is real, but only kills the *enforcement* story; it doesn't block shipping the agent), and reframes the eval around cost-asymmetry as the central question.

The deterministic skill (`kb-deep-search`) is preserved as Alternative A — the right step-down if Haiku ranking quality turns out poor.

## Why a Haiku subagent (the load-bearing argument re-centered)

When the calling agent is Opus and needs to do a real survey across local KBs, four things are true:

1. The work — query reformulation, re-ranking 6-10 chunks, deciding "is this on-point" — is well within Haiku's range.
2. Haiku 4.5 is roughly **5× cheaper per output token** than Opus and faster end-to-end.
3. A real survey is 5-8 `kb search` calls × ~2k tokens of returned chunks = ~10-15k tokens of context that the main agent has to read and reason about.
4. The main agent doesn't need to *carry* those 10-15k tokens for the rest of the task — it only needs the conclusions / 3-4 most relevant passages.

A Haiku subagent does (1)-(3) on cheaper tokens and returns only what (4) needs. That's the cost-asymmetry argument. It's real and the deterministic skill does not deliver it because the skill keeps every retrieval token on Opus.

## What got verified vs assumed

Verified against `/home/jean/git/kookr/plugin/skills/claude-code-hooks/SKILL.md`:

- `SubagentStop` is **blocking but not mutating**. Hook can read `last_assistant_message` and `agent_transcript_path`, can fail-closed via exit 2, but cannot rewrite what reaches the caller. **Consequence**: external enforcement of caps/refusal/dedup is impossible. We accept honor-system.
- `SubagentStop` matcher is "agent type name" — needs verification at week 0 that `matcher: "kb-scout"` actually matches a subagent declared with `name: kb-scout` in frontmatter (existing fixture shows `agent_type: "Explore"`, suggesting builtin agent names not custom).

Not yet verified — week-0 prerequisites:

- **`model: haiku-4.5` honored by the agent loader.** No in-repo precedent (only `model: opus` exists in `.claude/agents/oss-issue-scout.md`). If silently ignored, every scout invocation runs on the caller's model and the cost argument collapses. Verification: one invocation with parent forced to Opus, check transcript model field for strict equality.
- **`kb search --format=json` exists and works.** RFC 012/013 mentions it; verify on this machine.

If either week-0 check fails, the RFC is paused pending upstream fix or design adjustment. No partial deployment.

## Problem (unchanged from v1)

Among tasks that already do `kb search`, four problems persist on tasks warranting a real survey:

1. Single-shot syndrome — one literal `kb search`, scan top, move on.
2. Context pollution — wide search dumps ~10 multi-paragraph chunks + JSON into the main agent's context.
3. **Cost asymmetry** — Opus tokens for retrieval-shaped work. *(This RFC's central claim.)*
4. No "look harder" affordance.

Out of scope: the 84% zero-kb cohort. Different problem (CLAUDE.md/discoverability), different fix.

## Solution

A `.claude/agents/kb-scout.md` Haiku subagent. Project-scope (consumers don't have `bin/kb` or local KBs).

### Design

- **Free-form output, no JSON contract.** Round-1 design-minimalist was right that pinning a structured contract was over-built for a single-author project. Haiku writes ranked passages with provenance in whatever format reads well. The caller reads it like prose.
- **Caps as prompt instructions, not enforced.** `<=8` `kb search` calls, `<=6` returned passages, `~2,500` token budget. Honor-system. Named as honor-system in the agent prompt.
- **No external verifier.** Round-2 verified that `SubagentStop` cannot mutate output. We accept that Haiku may occasionally paraphrase, miscount, or pad. The eval at week 4 catches systematic drift; we do not pretend to prevent it per-invocation.
- **`SubagentStop` log-only**: transcript copied to `~/.kookr/scout-invocations/<ts>.md` for spot-checks. No enforcement, no truncation, no JSON parsing. ~10 lines of hook handler.
- **`kb search --format=json` for parsing stability**, but Haiku doesn't have to round-trip the JSON — it reads the results, picks chunks, writes a free-form summary.
- **Read-only by Bash allowlist.** Hook PreToolUse on Bash inside the subagent restricts to `kb (list|search|where|compare|stale-check)` — no write subcommands. This *can* be enforced (PreToolUse on Bash CAN block per Claude Code hook docs), unlike output mutation.
- **Caller contract**: free-text task gist (1-3 sentences). Optional `kbHint` (KB name, hard filter via `--kb=<name>`).

### Eval — reframed around cost-asymmetry

The central question is no longer "does the scout surface chunks the baseline missed" — it's **"does the scout deliver the same retrieval value at significantly lower cost than Opus would?"** Quality is necessary but not sufficient.

**Pre-committed thresholds** (decided here, before any invocation):

Three measurements per invocation, captured by the `SubagentStop` hook:

1. **Haiku tokens consumed** (input + output) — read from the transcript.
2. **Estimated Opus-equivalent tokens** — main agent's would-have-been: estimated as 1.5× the Haiku input (similar work + context-isolation savings already factored) using public per-model pricing ratios. This is rough but honest.
3. **Quality label** (manual, week 4): does the scout's output give the caller usable retrieval, per a 3-line rubric.

**Decision bands** at week 4 over N>=10 invocations:

- **Keep:** quality-usable in >=7/10 cases AND Haiku-tokens × Haiku-price < 0.5 × estimated-Opus-tokens × Opus-price (i.e., >=2× cost reduction).
- **Iterate (refine prompt):** quality 4-6/10 OR cost reduction in [1.5×, 2×).
- **Remove (fall back to skill — Alternative A):** quality <=3/10 OR cost reduction <1.5×.

The cost-reduction threshold is the real gate. If the scout produces excellent retrieval but only 1.2× cheaper than equivalent Opus work, the cost argument that motivated this whole RFC has not landed and we should ship the deterministic skill instead. If quality is poor at any cost, Alternative A is also right.

**Eval honesty mitigations** (from round-3 failure-mode analysis):

- **Rubric for "quality-usable"** (pre-committed, written here): the scout's output (a) cites at least one chunk via `kb`+path with a recognizable excerpt, (b) the cited chunk(s) is on-point per the author's actual usage on the task, (c) the scout did not fabricate a chunk that doesn't exist in the source. Verifying (c) is a 60-second `kb search` re-check by the author per labelled invocation.
- **Frozen prompt during eval** — no edits between week 1 and week 4. Edit-temptation = signal for the iterate band.
- **Capture-rate denominator** — count scout invocations from `~/.kookr/scout-invocations/` directory. Ratio of labelled vs total. If <80%, eval is reported as selection-biased.
- **Cost numbers verified at week 0** with one calibration invocation: confirm transcript-token-count is readable and the price ratio assumption is reasonable.
- **N is opportunistic, not aspirational.** If 4 weeks produces N=10, gate fires. If it produces N=6, default decision is **iterate** (lightest action), not extend.

### Files to change

- `.claude/agents/kb-scout.md` — agent definition (the deliverable).
- `.claude/hooks/kb-scout-stop.sh` — log-only `SubagentStop` handler (~10-line shell script that copies the transcript). Shell, not TypeScript, matching the existing kookr hook style.
- `.claude/hooks/kb-scout-pretool.sh` — PreToolUse on Bash inside scout, restricting to read-only `kb` subcommands. This one CAN be enforced (PreToolUse-on-Bash supports blocking).
- `.claude/settings.json` — register both hooks with `matcher: "kb-scout"` (verify week 0).
- `CLAUDE.md` — one-line pointer marked `[KB-SCOUT-EVAL-2026-W4]` for grep-based rollback.

### Edge cases

- **`bin/kb` not on PATH** — scout's first call fails. Returns a brief failure message in free-form output. Caller falls back to `kb search` directly.
- **No KBs ingested** — `kb list` returns empty. Scout returns a brief "no kbs available" message.
- **Stale index** — `kb search` emits the warning. Scout copies it into its output verbatim. No auto-refresh.
- **Haiku unavailable** (rate limit, regional issue) — Claude Code surfaces the error to the caller; the scout never runs. Caller falls back.
- **Haiku produces garbled / truncated output** — caller treats it as advisory, not authoritative. The whole RFC is honor-system; this is the same failure mode in degree, not in kind.
- **`model: haiku-4.5` silently ignored by loader** (week-0 risk) — RFC is paused. No deployment. The cost argument is the whole point; we don't ship without verifying it lands.
- **Caller invokes scout for trivial work** — scout still runs, costs Haiku tokens. The `description` "do NOT invoke me when..." clause is advisory. Eval will measure invocation appropriateness via spot-check.

### Rollback

`grep -rln "KB-SCOUT-EVAL-2026-W4" .claude .kookr scripts CLAUDE.md plugin` finds every reference. Files to delete on remove:
- `.claude/agents/kb-scout.md`
- `.claude/hooks/kb-scout-stop.sh`
- `.claude/hooks/kb-scout-pretool.sh`
- The hook entries in `.claude/settings.json`
- The CLAUDE.md pointer line

Files to archive on remove (not delete):
- `~/.kookr/scout-invocations/` → `~/.kookr/archive/scout-invocations-<date>/`

## Alternatives considered

### A. Deterministic skill `kb-deep-search` (was v3/v4 primary)

A `.claude/skills/kb-deep-search/SKILL.md` with a fixed query template the calling agent runs itself. No subagent, no second model.

**Status:** named fall-back. If the v5 eval shows quality-usable >=7/10 but cost reduction <1.5× — i.e., Haiku is good enough but not cheap enough to matter — the deterministic skill is the right next move. Same retrieval pattern, no second-model overhead. v3/v4 of this RFC fully designed it.

### B. `search_many` MCP server expansion

Add fan-out to `bin/knowledge-base-mcp-server`.

**Rejected as primary.** Doesn't address cost-asymmetry — main agent still pays Opus prices for query reformulation. Worth revisiting once telemetry shows >=80% of scout invocations use a fixed query template that could be folded into the MCP tool.

### C. Synthesized-answer retriever

**Rejected.** Lossy synthesis. Free-form passage-preserving output is the better default.

### D. Plugin-scope agent

**Rejected.** Other Kookr Toolkit consumers don't have `bin/kb`.

## Critic feedback incorporated (compressed across rounds 1-3)

| Round | Finding | v5 resolution |
|---|---|---|
| 1 | "Wrong end of funnel" — 84% zero-kb tasks | Out of scope, named in §Problem |
| 1 | Synthesis vs passage-preserving contradiction | Free-form output; caller decides what to read |
| 1 | `intent` enum has no defined behavior | Dropped |
| 1 | "Promote to Sonnet on evidence" is premature | Removed; remove-or-iterate, no promote |
| 1 | Author bias + N=20 too low | N>=10, opportunistic, default-on-slip is iterate |
| 2 | `SubagentStop` cannot mutate response | Acknowledged; shifted to honor-system |
| 2 | `loc.lines` chunk-internal not file-line | No verifier in v5 |
| 2 | Realistic cadence makes N>=40 unreachable | N>=10, default-on-slip |
| 2 | God-handler doing 7 jobs | Hook is now ~10-line shell, log-only |
| 2 | Blinded labelling for single-author is theater | Dropped |
| 3 | RFC document was 2-3x too long | v5 trimmed |
| 3 | Single-author labelling is the new dominant failure | Rubric pre-committed; capture-rate denominator; spot-check with rubric on (c) fabrication |
| 3 | Eval doesn't compare scout vs subagent (in v3/v4) | v5 eval is scout vs Opus-equivalent — directly addresses the cost-asymmetry question |
| 3 (user) | iterative review buried the cost-asymmetry argument | v5 puts it as the central claim of the whole RFC |

## Open questions

- **Cost-ratio assumption (1.5× Haiku-input ≈ Opus-equivalent tokens) is rough.** Should be calibrated against one real invocation at week 0 and adjusted before week 1. Worth pinning.
- **Haiku may produce a passage-by-passage paraphrase that is plausible-but-fabricated.** Honor-system means we can't prevent it; the rubric (c) check catches it at label time but not at use time. Caller must read scout output skeptically. Document this as a known limitation in the agent's `description`.
- **Should the scout be invocable from `oss-issue-scout` or other existing playbooks?** Defer to week-5+ once the eval has fired. Pre-gate playbook embedding is a sequencing trap (round-2 delivery finding).
