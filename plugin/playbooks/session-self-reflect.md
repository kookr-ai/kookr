---
name: Session Self-Reflection
description: Analyze recent Kookr supervision sessions to identify friction patterns, workflow improvements, and actionable recommendations
checklist:
  - Run interaction stats script and reviewed output
  - Ran session analyzer CLI for corrections, patterns, and tool usage
  - Ran repeated instructions analysis on user messages
  - For efficiency investigations, sampled Claude/Codex conversations in bounded slices instead of reading raw transcripts wholesale
  - Analyzed cross-session patterns (friction, corrections, detection gaps)
  - Ranked recommendations by implementation ease and expected token/tool-call savings
  - Cross-referenced with prior reflection report for trends
  - Generated structured reflection report with evidence
  - If user explicitly requested implementation, applied the minimum structural fix in a fresh worktree and verified it
  - Updated state file with analyzed session timestamps
  - Reported summary to user (sessions, findings, recommendations)
---

## Objective

Analyze recent Kookr supervision sessions to identify recurring friction patterns, workflow inefficiencies, and improvement opportunities. Produce an actionable reflection report. Present findings to the user — never auto-apply changes unless the user explicitly asks to implement the recommendations.

When the user asks for token/tool-call efficiency work, reproduce the process as an **efficiency retrofit**:

1. Mine recent Claude Code and Codex CLI conversations with bounded, low-context slices.
2. Find repeated inefficient tool calls, repeated setup mistakes, failed retries, prompt boilerplate, and noisy hooks.
3. Rank up to 10 fixes by expected savings and implementation ease.
4. If the user says "go ahead", use placement-picker to choose the right surface, then implement the smallest structural fix that future agents will actually see.

## Phase 1: Gather structured data

Run the interaction stats script to get pre-computed summaries (replaces manual JSONL parsing):

```bash
STATS="${CLAUDE_SKILL_DIR:-plugin/skills/self-reflect}/scripts/kookr-interaction-stats.ts"

# Human-readable summary of new sessions
bun "$STATS"

# JSON for structured analysis (pipe to file if large)
bun "$STATS" --json > /tmp/kookr-reflect-data.json

# All sessions (for cumulative analysis)
bun "$STATS" --all
```

If the script reports "No new sessions to analyze", stop.

Also fetch task store data:
```bash
curl -s http://localhost:4800/api/tasks
```

Also gather the **issue-backlog inflation signal** (issue #1607) so the reflection can see whether emitters are outrunning drain:

```bash
# Prefer the stable path emitters write after each publish run:
#   ~/.kookr/playbook-state/emission-metrics/<repoSlug>.json
# Fall back to a live query. Field of record: netBacklogDelta7d (opened7d − closed7d).
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "kookr-ai/kookr")
REPO_SLUG=$(printf '%s' "$REPO" | tr '/.' '--')
METRICS_FILE="$HOME/.kookr/playbook-state/emission-metrics/${REPO_SLUG}.json"
if [ -s "$METRICS_FILE" ]; then
  cat "$METRICS_FILE"
else
  kookr emission metrics --repo "$REPO" --json 2>/dev/null || true
fi
# Include netBacklogDelta7d, openBacklogCount, and the current emission budget
# action in the reflection report's signal summary (Signal: backlog).
```

The script outputs:
- Per-session summaries (events, agents, interventions, findings, user input classifications)
- Aggregate stats (totals, ratios, averages)
- Snooze storm detection (agents with 5+ consecutive snoozes)
- Finding breakdown by anomaly type and resolution method
- State file info (previously analyzed sessions, run count)

## Phase 1b: Extract high-intervention details from JSON

The JSON output has a known schema. Use it directly instead of re-discovering the structure:

```python
# Key paths in the JSON:
# data["sessions"][i]["sessionDir"]        — session directory name
# data["sessions"][i]["userInputs"]        — count (integer)
# data["sessions"][i]["userInputDetails"]  — list of {agentId, content, classification}
# data["sessions"][i]["agentsLaunched"]    — count (integer)
# data["sessions"][i]["launchedPrompts"]   — list of {agentId, prompt}
# data["sessions"][i]["findingsByType"]    — dict of anomalyType → {input, snooze, skip}
# data["sessions"][i]["durationMinutes"]   — float
# data["sessions"][i]["isEmpty"]           — boolean
# data["stats"]                            — aggregate {sessionsAnalyzed, agentsLaunched, ...}
# data["inputClassification"]             — {approval, directive, question} counts
# data["state"]                            — {analyzed_sessions, last_run, run_count, cumulative_stats}
```

Extract high-intervention sessions (3+ user inputs) and mass-launch sessions (10+ agents) directly from the JSON. This replaces the previous drill-down step that required Claude Code session IDs.

## Phase 2: Analyze Claude Code agent sessions

Use the session analyzer CLI for signals from the full Claude Code conversation logs:

```bash
SA="${CLAUDE_SKILL_DIR:-plugin/skills/self-reflect}/scripts/session-analyzer.ts"

# Find corrections (repeated corrections = skill/CLAUDE.md gap)
bun "$SA" -p kookr --corrections -n 30 --since <earliest-new-session-date>

# Cross-session patterns: correction themes, interruption rates, token trends
bun "$SA" -p kookr --patterns -n 0 --since <earliest-new-session-date>

# Tool usage report (spot permission friction, tool errors)
bun "$SA" -p kookr --tools-report -n 30 --since <earliest-new-session-date>
```

**Note:** The `-s <id>` flag expects Claude Code session UUIDs, not Kookr tmux session names (e.g., `kookr-73d29760`). Do NOT use tmux session names with `-s`. For per-agent analysis, use the Phase 1 JSON data instead — it already contains `userInputDetails` and `launchedPrompts` per session.

## Phase 2b: Analyze user messages for repeated instructions

Extract and analyze what users actually type to agents — this is the highest-signal, lowest-token-cost analysis:

```bash
SA="${CLAUDE_SKILL_DIR:-plugin/skills/self-reflect}/scripts/session-analyzer.ts"

# Find instructions repeated across sessions (default threshold: 3+)
bun "$SA" -p kookr --repeated-instructions -n 0 --since <earliest-new-session-date>

# Lower threshold to catch emerging patterns
bun "$SA" -p kookr --repeated-instructions --repeat-threshold 2 -n 0 --since <earliest-new-session-date>

# Extract just user messages for manual review (lightweight)
bun "$SA" -p kookr --user-messages -n 20 --since <earliest-new-session-date>
```

The `--repeated-instructions` mode:
- Normalizes messages (lowercase, strip acknowledgments, truncate to 80 chars) for fuzzy matching
- Groups repeated messages and counts occurrences across sessions
- Classifies each by intent: `approval`, `lifecycle`, `correction`, `process`, `question`, `directive`
- Suggests improvements by category (e.g., repeated lifecycle commands → agents should auto-complete delivery)
- Filters out playbook-injected prompts (## headers, frontmatter) to focus on organic user input

**Each repeated instruction is a system gap.** A user who types "commit and push" 13 times across sessions is compensating for agents that don't auto-complete the delivery cycle. A user who types "create a worktree" 10 times has a rule that agents aren't following consistently.

Include the top repeated instructions and intent classification in the reflection report.

## Phase 2c: Efficiency retrofit sampling (optional)

Use this phase when the user asks to reduce token consumption, reduce tool calls,
or analyze repeated agent inefficiencies across Claude Code and Codex CLI.

Do **not** read raw transcripts directly into context. Use aggregate scripts and
bounded samples. The goal is evidence-backed patterns, not full conversation
replay.

### Data sources

Inspect these sources when present:

- Codex CLI sessions: `~/.codex/sessions/**/rollout-*.jsonl`
- Codex prompt history: `~/.codex/history.jsonl`
- Claude Code project transcripts: `~/.claude/projects/**/*.jsonl`
- Claude Code prompt history: `~/.claude/history.jsonl`
- Claude Code telemetry: `~/.claude/telemetry/*.json`
- Existing reflection state: `~/.claude/session-reflections/*`

Prefer scripts that count structured fields over commands that dump large log
payloads. Cap every ad hoc parser by date, file count, or byte count.

### Parallel slice pattern

When the corpus is broad, split it into independent slices and use cheap
subagents when available:

- Codex sessions by time window, for example `03:00-05:00`, `05:00-07:00`,
  `07:00-09:00`, `09:00-12:00`, `12:00-latest`.
- Claude telemetry as one slice.
- Claude project transcripts as one or more repo-focused slices.
- Prompt histories as one slice for repeated user corrections.
- A cross-cutting prevention slice for deterministic wrappers/hooks.

Ask each subagent for only:

1. top repeated inefficiency patterns,
2. evidence counts and example session/file ids,
3. one or two prevention ideas.

If subagents are unavailable, run the same slices locally with small Python
parsers and summarize counts.

### Patterns to measure

Record counts for these high-signal categories:

- repeated `git status`, `git diff`, `gh pr list`, `gh pr checks`, or task API
  polls without an intervening state change;
- repeated reads of the same `SKILL.md`, playbook, PR template, or reviewer
  specialist file;
- broad output commands (`cat`, `nl -ba`, wide `sed`, full `git diff`) that
  produce large outputs;
- near-duplicate `rg`/`find`/`ls` orientation loops;
- fixed sleep polling (`sleep N; poll`) and many empty `write_stdin` polls;
- identical failed commands rerun without changed inputs;
- repeated user prompt boilerplate such as "create a fresh worktree", "push and
  open PR", "keep going", or "use the running prod checkout";
- noisy hook warnings repeated across sessions;
- missing setup steps before delivery, especially `git fetch` before creating a
  worktree and dependency provisioning before push/test hooks.

### Ranking model

For every candidate improvement, score:

- **Evidence**: frequency, recency, and whether multiple slices saw it.
- **Expected savings**: tokens, tool calls, wall time, or avoided failed runs.
- **Implementation ease**: docs/checklist < helper script < hook < runtime
  feature < architecture change.
- **Blast radius**: project-only vs plugin-wide, blocking vs advisory.

Prefer fixes with high evidence, high expected savings, low blast radius, and a
clear verification path.

## Phase 3: Cross-session pattern analysis

Using the structured data from Phase 1-2, analyze these friction categories:

1. **Snooze Storm** — Agents snoozed 5+ times (script detects automatically). Means snooze UX is broken for that scenario.
2. **Reactive User** — Question-classified inputs where the system should proactively surface info.
3. **Repeated Corrections** — Same feedback across sessions (from session analyzer corrections output).
4. **Detection Gaps** — User intervened before anomaly fired, or manual stops of agents the system didn't flag.
5. **Workflow Inefficiency** — High snooze/skip rates, always-skipped anomaly types, empty sessions.

Also analyze:
- Task outcomes: completion rate, intervention density by task category
- Workflow evolution: new task patterns that could become playbooks
- Positive signals: what's working well (high approval ratios, fast completions)

## Phase 4: Cross-reference with prior report

```bash
cat ~/.claude/session-reflections/reflection-report.md 2>/dev/null
```

Check which prior recommendations were acted on. Identify trends (improving/stable/worsening).

## Phase 5: Generate report

Archive previous report, then write to `~/.claude/session-reflections/reflection-report.md`:

```bash
if [ -f ~/.claude/session-reflections/reflection-report.md ]; then
  cp ~/.claude/session-reflections/reflection-report.md \
     ~/.claude/session-reflections/archive/reflection-$(date -u +%Y%m%dT%H%M%SZ).md
fi
```

Report structure: Executive Summary, Session Statistics table (this run + cumulative), Friction Patterns Found (with category, frequency, evidence, trend, recommended action, where to apply), User Input Classification, Task Outcome Analysis, Recommendations (priority ordered), Prior Recommendations Status, Raw Data (per-session in collapsible details).

For efficiency retrofit reports, add:

1. **Top Opportunities** — up to 10 items, each with evidence, likely savings,
   implementation ease, and recommended surface.
2. **Best Bets** — the 3-5 highest ROI fixes.
3. **Rejected/Deferred** — ideas that look plausible but are too broad, too
   brittle, or lack enough evidence.
4. **Implementation Plan** — only if the user asks to proceed.

Do not over-prescribe. If a checklist or helper script would prevent most of
the waste, prefer that over a blocking hook. Use a blocking hook only for hard
invariants or expensive mistakes that are mechanically detectable.

## Phase 5b: Implement structural fixes (only after explicit user approval)

If the user explicitly says to implement the recommendations, turn the report
into the smallest durable change. Use `placement-picker` before editing:

- repeated behavioral guidance visible across runtimes → plugin skill/playbook
  or project `CLAUDE.md`, not Claude-only memory;
- mechanically detectable wrong behavior → hook or wrapper command;
- repeated long command outputs → output guard or command wrapper;
- repeated setup mistakes → helper script plus docs/checklist;
- one repo's workflow only → project playbook or project docs.

Implementation rules:

1. Create a fresh git worktree before tracked-file edits. Do not edit the main
   checkout, production runtime worktree, or another task's worktree.
2. Start by refreshing the base: `git fetch origin main`.
3. Keep the first implementation narrow. One helper plus tests, or one playbook
   update, is better than a sprawling framework.
4. Add focused tests for scripts/hooks. For playbook-only edits, run formatting
   or the repository's light validation command.
5. Before push, ensure the worktree has dependencies available. If the repo uses
   per-worktree `node_modules`, provision them with `npm ci` or a temporary
   symlink to a matching checkout, and remove any symlink before committing.
6. If a pre-push hook fails because dependencies are absent, do not bypass it.
   Provision dependencies and retry the push.
7. Report exactly what was implemented, what was verified, and whether anything
   remains report-only.

## Phase 6: Update state

**Read `state.json` first** (the Write tool requires reading a file before overwriting it), then update with new analyzed session dirs, incremented run_count, and updated cumulative stats.

```bash
cat ~/.claude/session-reflections/state.json
```

Then write the updated state. Also read `reflection-report.md` before Phase 5's write for the same reason.

## Rules

- **Idempotent**: Never re-analyze sessions already in state.json. Append, don't reset.
- **Archive first**: Always archive previous report before overwriting.
- **Evidence required**: Every recommendation needs at least one concrete example.
- **No auto-apply by default**: Present findings to user, don't modify CLAUDE.md/skills/code unless the user explicitly asks to implement.
- **Use durable visible surfaces**: For behavioral fixes, prefer hooks, skills,
  playbooks, helper scripts, or `CLAUDE.md` over Claude-only memory.
- **Optimize the analysis itself**: Use bounded parsers, structured counts, and
  parallel slices; avoid filling context with raw transcripts.
- **Weight recency**: Recent sessions matter more for trend analysis.
- **Tolerate missing data**: If hook files or API are down, analyze what's available and note gaps.
- **Don't read full transcripts**: Use the session analyzer CLI, not raw transcript files.
