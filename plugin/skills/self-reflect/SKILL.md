---
name: self-reflect
description: Reflect on a mistake or unnecessary user correction — root-cause why it happened, then propose and implement structural fixes (skills, hooks, CLAUDE.md, memory, scripts). Use after the user corrects behavior, repeats guidance, or points out an avoidable error.
keywords: reflect, mistake, feedback, correction, self-improve, root-cause, meta, why, should have, remember, told you, wrong approach, improve
related: placement-picker, token-efficiency, testing-patterns, pre-pr-review
---

# Self-Reflection Workflow

## When to Use

- The user says "I told you to...", "remember that...", "why did you...", "you should have...", "don't do X", "you must do Y before Z"
- The user provides guidance that they shouldn't need to provide (it was already documented, previously corrected, or obvious from context)
- You realize mid-task that you took a wrong approach and wasted effort
- You can also trigger this proactively when you catch yourself about to repeat a past mistake

## Core Principle

**Every correction is a system failure, not a one-time event.** If the user had to tell you something, the system (instructions, skills, hooks, memory) should be updated so that no future conversation requires the same correction. The goal is zero repeated corrections.

## Step 1: Reproduce the Mistake

Before analyzing, clearly state what happened:

```
**What I did:** [the incorrect action or omission]
**What I should have done:** [the correct action]
**User's correction:** [what the user said]
```

Be precise. "I forgot to run tests" is vague. "I created a PR without running `pnpm typecheck && pnpm test` first" is actionable.

## Session Analyzer CLI

A bundled script at `${CLAUDE_SKILL_DIR}/scripts/session-analyzer.ts` parses `~/.claude` session data. Run it with:

```bash
SA="${CLAUDE_SKILL_DIR}/scripts/session-analyzer.ts"

# Find corrections in recent sessions for this project
bun "$SA" -p kookr --corrections -n 10 --since 2026-03-25

# View timeline of a specific session where the mistake happened
bun "$SA" -s <session-id-prefix> --timeline

# Check if similar corrections were given in past sessions (repeated pattern)
bun "$SA" -p kookr --patterns --since 2026-03-20

# Get session summary with tool usage and human messages
bun "$SA" -s <session-id-prefix> -d summary

# JSON output for structured analysis
bun "$SA" -s <session-id-prefix> -f json

# Analyze the current session
bun "$SA" --current ${CLAUDE_SESSION_ID} -d summary
```

See `bun "$SA" --help` for all options (filtering, detail levels, output formats).

## Step 2: Root-Cause Analysis

Ask **why** the mistake happened. There are fundamentally different root causes, and each demands a different fix. Walk through these categories in order — stop at the first one that matches.

### Category A: Instruction Gap

The correct behavior isn't documented anywhere the agent would see it.

**Diagnosis:** Search CLAUDE.md, skills, memory, and agents for the expected behavior. If it's genuinely absent, this is the root cause.

**Check:**
- `grep -r` in `.claude/skills/` for relevant keywords
- Read CLAUDE.md for relevant sections
- Read memory files for relevant feedback
- Check `.claude/agents/` for relevant agent instructions

### Category B: Instruction Exists but Wasn't Followed

The correct behavior IS documented (in CLAUDE.md, a skill, or memory), but Claude didn't follow it.

**Diagnosis:** Find the exact instruction. Then determine why it was missed:
- **Discoverability problem** — the skill's keywords/description didn't match what Claude was doing, so it wasn't loaded
- **Ambiguity** — the instruction is vague or could be interpreted multiple ways
- **Conflict** — two instructions contradict each other, and Claude followed the wrong one
- **Buried** — the instruction is in a long document and was overlooked

### Category C: Memory Exists but is Stale or Wrong

A memory file contains outdated information that led Claude astray, or the memory was correct but Claude didn't check it.

**Diagnosis:** Read the relevant memory files. Compare against current project state.

### Category D: Approach/Trajectory Problem

The instructions were fine, but Claude chose a suboptimal approach to the task. This isn't about what to do but *how* — the sequence of steps, the decision to dive in vs. plan first, the failure to verify assumptions, etc.

**Diagnosis:** Replay the sequence of actions. Identify the decision point where things went wrong. Common patterns:
- **Didn't verify before acting** — assumed something was true without checking (file exists, test passes, type is correct)
- **Went too deep before validating direction** — implemented a full solution before confirming the approach with the user
- **Didn't read enough context** — started editing without understanding the surrounding code
- **Brute-forced instead of diagnosing** — retried a failing approach instead of investigating why it failed
- **Premature optimization** — added complexity (abstractions, error handling, generalization) not needed for the task
- **Scope creep** — fixed/improved things the user didn't ask for

### Category E: Inconsistency in Existing Instructions

Two or more instructions give conflicting guidance. The mistake happened because Claude followed one instruction that contradicts another.

**Diagnosis:** Identify both instructions. Determine which should win. Flag the inconsistency for resolution.

### Category F: External/Tooling Issue

The mistake wasn't due to Claude's behavior but to tooling limitations, environment issues, or missing infrastructure.

**Diagnosis:** Identify what tool or infrastructure would have prevented the mistake.

## Step 3: Propose Remediation

Based on the root cause, propose the **minimum effective fix** — but minimum does not mean "lightest in bytes". It means "the lightest mechanism that is *still visible to every agent that needs to follow the rule*". A feedback memory is lightweight but invisible to non-Claude-Code agents; that's not "light", that's "broken for half the runtime."

### Placement Picker (do this FIRST, before picking a fix type)

Load `placement-picker` and use its routing matrix before proposing any fix. This keeps one canonical body for memory-vs-skill-vs-hook-vs-CLAUDE.md decisions.

For behavioral rules and workflow corrections, memory is banned in mixed-runtime Kookr work because Codex CLI cannot read Claude Code memory. Use a hook, skill, or CLAUDE.md.

**Calibration question**: If you are tempted to save a feedback memory as a fix, ask yourself: *"Would this memory still protect the user if they ran the exact same task on Codex CLI tomorrow?"* If no, pick a skill / CLAUDE.md / hook instead.

### Fix Type Ranking (for behavioral rules in mixed-runtime projects)

```
Strongest ──────────────────────────────────────── Weakest
(always works)                          (depends on who's reading)

Hook          Skill update     CLAUDE.md       New skill       Memory
(determi-     (content or      line            (new file)      (feedback)
 nistic       frontmatter)     (concise)                       ⚠ Claude Code only
 enforce-                                                        — do not use for
 ment)                                                           behavioral rules
```

Memory moved to the weakest column because memory is *invisible to Codex CLI agents* in this project. For pure context (user profile, project history), memory is still fine — but you are almost never self-reflecting about context, you are self-reflecting about behavior.

### Scope Guide

Before choosing a fix type, decide the **scope** — where the fix applies:

| Scope | Location | When to use |
|-------|----------|-------------|
| **User** (all projects) | `~/.claude/CLAUDE.md` | Universal workflow rules (git hygiene, PR conventions, communication preferences) |
| **Project** (this repo) | `CLAUDE.md` in repo root | Project-specific conventions (build commands, architecture rules, tech stack decisions) |
| **Project memory** | `memory/*.md` | **Context only** — who the user is, project goals, external references. Not behavioral rules. |

**Rule of thumb:** If the fix would help in *any* repo, it belongs in `~/.claude/CLAUDE.md`. If it's specific to this codebase, it belongs in the project `CLAUDE.md`, a skill, or a hook. Memory is for context, not rules.

### Decision Guide

| Root Cause | Fix Type | Example |
|------------|----------|---------|
| **A: Instruction gap** (universal, one-liner) | CLAUDE.md | "Always run typecheck before creating a PR" |
| **A: Instruction gap** (conditional, needs examples) | New or updated skill | Add a skill for the pattern, or update an existing skill's content |
| **B: Discoverability** | Skill frontmatter update | Add keywords/sharpen description so the skill gets loaded when relevant |
| **B: Ambiguity** | Rewrite the instruction | Make it unambiguous with concrete do/don't examples |
| **B: Conflict** | Resolve + remove one | Pick the correct instruction, remove or update the conflicting one |
| **B: Buried** | Promote to CLAUDE.md or restructure | Move critical instruction to a more visible location |
| **C: Stale memory** | Update or delete memory | Correct the memory file to match current state |
| **D: Approach problem** | **Skill update or CLAUDE.md** (not memory) | Encode the correct approach pattern where every agent can see it |
| **D: Approach problem** (deterministic enforcement viable) | **Hook** | If the wrong behavior can be detected by a shell command, block it at tool-call time |
| **E: Inconsistency** | Resolve the conflict | Update one or both instructions to be consistent |
| **F: Tooling gap** | Script or hook | Create a pre-commit hook, a validation script, or suggest a tool improvement |

### Skill-Driven Workflows

When the mistake happened during a skill-driven workflow (a playbook, a multi-phase pipeline, a recurring analysis loop), **update the skill, not memory.** Skills are loaded every time the workflow runs; they are visible to every agent type. Ask:

- Was I executing a skill (oss-pr-critic, pre-pr-review, tdd-workflow, etc.) when the mistake happened?
- Does the skill's instructions cover this scenario? If not → add the missing instruction to the skill.
- Does the skill mention the right behavior but vaguely? → Sharpen the instruction with concrete steps.

A skill update is the right fix for workflow-level gaps. Even for one-off corrections, prefer updating an adjacent skill over saving a memory that half the runtime can't read.

### What NOT to Do

- **Don't default to memory for behavioral rules.** Memory is the *weakest* mechanism for rules in this project, not the lightest. Walk the Persistence Mechanism Picker before proposing any fix.
- **Don't save feedback memories for cross-agent behavioral rules.** Codex CLI can't read them. The Kookr project `CLAUDE.md` explicitly bans this.
- Don't add a CLAUDE.md line for every correction — CLAUDE.md must stay concise.
- Don't create a new skill for a genuinely one-time issue — but if in doubt between "one-time" and "recurring pattern", prefer the skill. Skills are visible to every agent; memory isn't.
- Don't add redundant guardrails (CLAUDE.md line + skill + memory all saying the same thing).
- Don't propose fixes that are heavier than the problem warrants.
- Don't just save a memory and call it done if the issue is structural.

## Step 4: Implement the Fix

After proposing, implement immediately (don't wait for a separate request):

1. **For memory updates:** Write/update the memory file, update MEMORY.md index
2. **For CLAUDE.md changes:** Edit CLAUDE.md directly (keep it concise)
3. **For skill updates:** Edit the skill's SKILL.md (content or frontmatter)
4. **For new skills:** Create `.claude/skills/{name}/SKILL.md` with proper frontmatter
5. **For hooks/scripts:** Create the file, add to settings if needed
6. **For instruction removal:** Delete or edit the conflicting/outdated content

## Step 5: Verify the Fix

After implementing, do a quick sanity check:

- If you updated a skill's keywords: mentally confirm the skill would be discovered for the scenario that triggered the mistake
- If you added a CLAUDE.md line: re-read CLAUDE.md to check it's still concise and non-contradictory
- If you updated memory: re-read MEMORY.md to check the index is consistent
- If you resolved a conflict: grep for the old instruction to make sure all instances are updated

## Output Format

Keep the reflection concise. Use this structure:

```
## Reflection

**Mistake:** [one sentence]
**Root cause:** [category letter + one sentence]
**Fix:** [what was done — e.g., "Updated skill X frontmatter to add keyword Y" or "Added feedback memory about Z"]
**Verification:** [one sentence confirming the fix is sound]
```

For complex cases with multiple contributing causes, list each with its own fix.

## Examples

### Example 1: Forgot to run tests before PR

```
## Reflection

**Mistake:** Created a PR without running `pnpm typecheck && pnpm test` first.
**Root cause:** B (Discoverability) — `pre-pr-review` skill exists but its keywords didn't
include "create PR" or "gh pr create", so it wasn't loaded when I was creating the PR.
**Fix:** Updated `pre-pr-review` skill frontmatter to add keywords: "create PR", "gh pr create",
"pull request".
**Verification:** Searching for "create PR" in skills now matches `pre-pr-review`.
```

### Example 2: Used `gh pr edit` which is broken

```
## Reflection

**Mistake:** Tried to use `gh pr edit` to update PR body, which doesn't work
reliably for multi-line bodies.
**Root cause:** A (Instruction gap) — no skill or CLAUDE.md line tells agents
to prefer `gh api repos/.../pulls/N -X PATCH`.
**Fix considered and REJECTED:** Saving a feedback memory. Walked the Persistence
Mechanism Picker: this is a behavioral rule ("don't use X, use Y instead") and
Codex CLI agents run Kookr tasks too, so memory is invisible to half the runtime.
**Fix chosen:** Added a one-line rule to project `CLAUDE.md` under the
"Git workflow" section: "To edit PR bodies, use `gh api repos/.../pulls/N -X PATCH`
— `gh pr edit` breaks on multi-line bodies." Every agent loads CLAUDE.md.
**Verification:** Grepped CLAUDE.md for `gh pr edit` — the override rule appears
before any other `gh pr edit` mention. Loaded by every agent on every session.
```

### Example 3: Over-engineered a simple feature

```
## Reflection

**Mistake:** Added error handling, validation, and an abstraction layer for a
simple 10-line function. User asked me to remove the extras.
**Root cause:** D (Approach) — Premature optimization. The system prompt says
"don't add features beyond what was asked" but I defaulted to defensive coding.
**Fix considered and REJECTED:** Feedback memory capturing "minimal code preference."
Walked the picker: (a) this is a behavioral rule that must apply across runtimes,
(b) the system prompt already has "don't add features beyond what was asked", so
the gap isn't missing instructions — it's that the existing instruction didn't win
against the defensive-coding default.
**Fix chosen:** Sharpened the existing `simplify` skill's frontmatter to include
the keyword "defensive coding", added a concrete do/don't example to the skill body
showing the exact pattern (added error handling for a trusted internal call). The
skill now loads proactively when this pattern is about to happen.
**Verification:** Re-ran the skill loader mentally against the original scenario.
The new keyword matches. The concrete example makes the rule unambiguous.
```

### Example 4: Was tempted to save memory for a behavioral rule

```
## Reflection

**Mistake:** In a prior reflection I proposed saving a feedback memory for
"don't use the /issues/N/timeline endpoint for competition checks — it paginates
and drops late cross-ref events." User corrected me: "avoid memory, use the other
approaches."
**Root cause:** E (Inconsistency in existing instructions). The system-prompt
auto-memory section teaches me to save feedback memories actively; the project
CLAUDE.md has a counter-rule but it was buried in a bullet list and the
self-reflect skill itself defaulted to memory.
**Fix:** Did NOT save a memory (the instinct to do so was itself the problem).
Instead: (a) baked the banned-endpoint rule directly into the `oss-issue-scout`
agent definition and the `oss-issue-scout` skill's Competition Check section,
where every scout run sees it; (b) implemented a `claim-gate` PreToolUse hook
that runs the correct check deterministically, so even if the skill rule is
forgotten the hook enforces it; (c) elevated the "don't use memory for behavioral
rules" rule out of the CLAUDE.md bullet list into a dedicated subsection with a
decision table; (d) rewrote this self-reflect skill to put memory LAST in the
fix-type ranking and to require walking the Persistence Mechanism Picker before
proposing any fix.
**Verification:** Grepped the repo — the banned endpoint is documented in three
places (agent, skill, CLAUDE.md cross-reference). Hook was tested live against
the exact incident that motivated the fix. Picker now gates any future memory
proposal.
```

## Anti-Patterns for Reflection Itself

- **Don't over-reflect on trivial issues.** A typo fix doesn't need root-cause analysis.
- **Don't blame the user.** If the user's instructions were unclear, the fix is to clarify them — not to note that "the user didn't specify."
- **Don't be defensive.** The point is improvement, not justification.
- **Don't propose 5 fixes for 1 problem.** Pick the single most effective fix.
- **Don't reflect without implementing.** A reflection without a concrete change is just talking.
