---
name: Session Self-Reflection
description: Analyze recent Kookr supervision sessions to identify friction patterns, workflow improvements, and actionable recommendations
checklist:
  - Run interaction stats script and reviewed output
  - Ran session analyzer CLI for corrections, patterns, and tool usage
  - Ran repeated instructions analysis on user messages
  - Analyzed cross-session patterns (friction, corrections, detection gaps)
  - Cross-referenced with prior reflection report for trends
  - Generated structured reflection report with evidence
  - Updated state file with analyzed session timestamps
  - Reported summary to user (sessions, findings, recommendations)
---

## Objective

Analyze recent Kookr supervision sessions to identify recurring friction patterns, workflow inefficiencies, and improvement opportunities. Produce an actionable reflection report. Present findings to the user — never auto-apply changes.

## Phase 1: Gather structured data

Run the interaction stats script to get pre-computed summaries (replaces manual JSONL parsing):

```bash
STATS=".claude/skills/self-reflect/scripts/kookr-interaction-stats.ts"

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
SA=".claude/skills/self-reflect/scripts/session-analyzer.ts"

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
SA=".claude/skills/self-reflect/scripts/session-analyzer.ts"

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
- **No auto-apply**: Present findings to user, don't modify CLAUDE.md/skills/code.
- **Weight recency**: Recent sessions matter more for trend analysis.
- **Tolerate missing data**: If hook files or API are down, analyze what's available and note gaps.
- **Don't read full transcripts**: Use the session analyzer CLI, not raw transcript files.
