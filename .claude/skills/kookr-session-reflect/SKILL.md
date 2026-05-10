---
name: kookr-session-reflect
description: Analyze a Kookr supervision session to identify friction patterns and generate actionable improvements for agent behavior and anomaly detection.
keywords: session, reflect, friction, feedback, self-improve, meta-analysis, supervision, attention, interaction, patterns, UX
related: testing-patterns, e2e-agent-testing, state-machine-workflow-patterns
---

# Session Reflection Workflow

## When to Use

- After a supervision session where the user experienced repeated friction (had to ask agents the same thing multiple times, manually intervened often, or felt the system wasn't proactive enough)
- When the user triggers the "Reflect" action from the Kookr UI
- When reviewing whether Kookr's anomaly detection is catching the right things
- When tuning agent launch templates or supervision policies based on observed patterns

## Core Principle: Friction is Signal

Every time a user has to manually intervene, ask a question, or correct an agent, it reveals a gap between what the system does automatically and what the user needs. Session reflection turns these friction events into concrete improvements.

```
Session Events (hooks, anomalies, user input, queue transitions)
  ↓
Reflection Analysis (pattern detection + LLM summarization)
  ↓
Findings (friction patterns, root causes, improvement suggestions)
  ↓
Actions (new anomaly rules, prompt templates, CLAUDE.md updates)
```

## Friction Pattern Taxonomy

### Category 1: Reactive User (user asks what the system should have surfaced)

| Signal | Example | Improvement |
|--------|---------|-------------|
| User sends question-shaped input | "did you do X?", "are you done?", "what happened?" | Agent should proactively report status at milestones — create/update a skill with milestone reporting patterns |
| User checks agent that has no anomaly | Clicks into agent with no finding | Missing anomaly type — add detection rule in `anomaly-detector.ts` |
| User sends same message to multiple agents | "make sure you run tests" | Encode as permanent guidance — CLAUDE.md one-liner or skill if it needs conditional logic |

### Category 2: Repeated Corrections (user gives same feedback multiple times)

| Signal | Example | Improvement |
|--------|---------|-------------|
| Same input sent N times across sessions | "use strict types", "don't skip tests" | Encode as permanent guidance — improve existing skill discoverability (frontmatter keywords) or add CLAUDE.md one-liner |
| User overrides anomaly then same anomaly recurs | Snoozes "needs_input" but agent keeps stopping | Agent needs autonomy guidance — create/update skill with patterns for when to ask vs. proceed |
| User skips same anomaly type repeatedly | Always skips `permission_blocked` for Bash | Tool should be pre-authorized — update launch template (`--allowedTools`) |

### Category 3: Detection Gaps (system missed something)

| Signal | Example | Improvement |
|--------|---------|-------------|
| User intervenes before any anomaly fires | Sends input to agent with status "running" | Anomaly detector missed the pattern — add detection rule |
| Long gap between last event and user input | Agent idle 5+ minutes, user finally checks | Add idle/stall detection anomaly type |
| User stops agent manually (not via anomaly flow) | Kills task from UI without triage | Agent was doing something wrong that detection didn't catch — add detection rule or prevention skill |

### Category 4: Workflow Inefficiency (triage loop has unnecessary steps)

| Signal | Example | Improvement |
|--------|---------|-------------|
| User navigates away from suggested agent | Kookr suggests Agent A but user picks Agent B | Priority scoring needs adjustment — tune thresholds |
| Rapid skip/advance cycle | User skips 3+ agents before acting | Too many low-priority findings — raise detection thresholds |
| User sends input then immediately sends more | Two inputs within seconds | First input was incomplete — consider multi-line input UX |

## Data Sources for Reflection

### Available Now (V1)

| Source | Location | Contains |
|--------|----------|----------|
| Hook event JSONL | `~/.kookr/hooks/{tmux-name}.jsonl` | All agent events (tool use, stops, permissions) |
| Task state | `~/.kookr/tasks.json` | Task lifecycle, session metadata |
| Anomaly history | In-memory (`Monitor.getSnapshot()`) | What anomalies were detected and when |
| Claude Code sessions | `~/.claude/projects/{project}/*.jsonl` | Full conversation history: user messages, assistant responses, tool calls, token usage, errors |

### Session Analyzer CLI

The `self-reflect` skill bundles a session analyzer script that can also be used here to cross-reference what happened inside Claude Code agent sessions during a supervision session:

```bash
SA="${CLAUDE_SKILL_DIR}/../self-reflect/scripts/session-analyzer.ts"

# List recent agent sessions for this project
bun "$SA" -p kookr -n 20 --since 2026-03-25

# Find corrections the user gave to agents (repeated corrections = skill/CLAUDE.md gap)
bun "$SA" -p kookr --corrections -n 20

# View what an agent did during a specific session
bun "$SA" -s <session-id-prefix> --timeline

# Cross-session patterns: correction themes, interruption rates, token trends
bun "$SA" -p kookr --patterns --since 2026-03-20

# Tool usage report across sessions (spot permission friction, tool errors)
bun "$SA" -p kookr --tools-report -n 30

# Extract only user-typed messages (lightweight, high-signal)
bun "$SA" -p kookr --user-messages -n 30 --since 2026-03-25

# Find repeated instructions across sessions (detects CLAUDE.md/skill gaps)
bun "$SA" -p kookr --repeated-instructions -n 0 --since 2026-03-25

# Same with lower threshold (2+ instead of default 3+)
bun "$SA" -p kookr --repeated-instructions --repeat-threshold 2 -n 0

# JSON output for structured processing
bun "$SA" -p kookr -n 10 -f json
```

This is especially useful for:
- **Repeated instructions analysis**: The `--repeated-instructions` mode finds messages the user gives repeatedly across sessions. Each repeated instruction is a system gap — it should become a CLAUDE.md rule, skill, playbook, or hook. The mode classifies each instruction by intent (approval, lifecycle, correction, process, question, directive) and suggests improvement actions by category.
- **User message extraction**: The `--user-messages` mode extracts only human-typed messages (no tool results, no assistant output), drastically reducing the content to analyze while preserving the highest-signal data.
- **Repeated corrections analysis**: If the same feedback appears across multiple agent sessions, it should become a skill or CLAUDE.md instruction
- **Agent efficiency**: High tool error rates or frequent interruptions signal missing permissions or unclear instructions
- **Correlation**: Match Kookr supervision events (anomalies, user interventions) with what agents were actually doing at that time

### Needed for Full Reflection (requires persistence — see ADR-010)

| Source | What to Capture | Why |
|--------|-----------------|-----|
| User input log | Every `send-keys` / input_received with timestamp and content | Detect repeated messages, question patterns |
| Attention queue transitions | Enqueue, skip, snooze, advance, dequeue events with timestamps | Detect workflow inefficiency |
| Anomaly lifecycle | Detection time, resolution time, resolution method (user input, auto-clear, skip, snooze) | Measure detection quality |
| Session timeline | Merged chronological view of all sources | Enable temporal pattern analysis |

## Progressive Disclosure: Where Improvements Land

Agent behavior is steered through a progressive disclosure hierarchy:

```
CLAUDE.md                          ← concise, always loaded into agent context
  ↓ agent discovers via frontmatter
.claude/skills/*/SKILL.md          ← detailed patterns, loaded on demand
  ↓ skill references
source files, docs, examples       ← full context, explored as needed
```

**Skills are the natural home for most improvements.** CLAUDE.md must stay concise (it's always in context), so anything that needs examples, conditions, or decision logic belongs in a skill. The key lever is **discoverability**: a skill with a clear `description` and well-chosen `keywords` in its frontmatter gets picked up automatically when the agent's task matches — no CLAUDE.md pointer needed.

When reflection identifies a behavioral improvement:
- **First check if an existing skill already covers it.** If so, improve that skill's content or sharpen its frontmatter `description`/`keywords` so it gets discovered more reliably.
- **If no skill covers it, consider creating one** — with good frontmatter so it's self-discoverable.
- **Only add to CLAUDE.md** if it's a universal one-liner that applies to every task (e.g., "always run tests before completing"). Avoid adding CLAUDE.md lines that just point to skills — that's redundancy, not disclosure.

## Reflection Output Format

### Writing Style

**Write for a human, not a dashboard.** The report's audience is the project owner — someone who uses Kookr daily but doesn't think in terms of "intervention density" or "anomaly type breakdowns."

Rules:
- **Lead each finding with a plain-language story**: what happened, why it's a problem, what would be better. Only then add supporting numbers.
- **Avoid jargon without explanation.** Don't write "stale_agent carry-over noise" — write "alerts from finished agents that kept showing up in later sessions." If you must use a technical term, explain it in parentheses on first use.
- **Don't let tables replace narrative.** A table of metrics is useful as a reference appendix, but the main body should read like a briefing, not a spreadsheet.
- **Use concrete examples.** Instead of "52% of inputs were questions", say "You asked 11 questions (like 'what about a shortcut for snoozing?') vs. only 2 approvals — you were brainstorming, not just approving."
- **Explain the "so what."** Every number needs a sentence saying why it matters. "30% empty sessions" means nothing alone — "30% of sessions were empty, which clutters your history when you look back" gives it meaning.
- **Keep section headers descriptive.** "Ghost Alerts From Finished Agents" is better than "stale_agent Carry-Over Noise — Mass Skip Event."

### Report Structure

```markdown
## Session Reflection — {date}

### What This Report Is
[1-2 sentences explaining what was analyzed and why]

### The Big Picture
**What went well:** [2-3 bullet points, plain language]
**What needs attention:** [2-3 bullet points, plain language]

### Friction Pattern 1: {Descriptive Name in Plain Language}
#### What happened
[Tell the story: what the user did, what the system did, what went wrong]
#### Why it's a problem
[Explain the impact in terms the user feels — wasted clicks, confusion, noise]
#### What could be better
[Concrete suggestion with estimated effort]

### Friction Pattern 2: ...
[Same structure]

### How You're Using Kookr
[Narrative about interaction patterns — what shifted, what it means]

### What's Going Well
[Positive signals — things that are working, things that improved]

### Recommendations
[Priority ordered, each with: one-sentence problem, suggested action, effort estimate]

### Status of Previous Recommendations
[Table or list — what was done, what wasn't, what evolved]

### Numbers At A Glance
[Compact reference table for anyone who wants the raw stats]

### Raw Session Details
[Collapsible per-session breakdown for reference]
```

## Implementation Approach

### Phase 1: Manual Reflection (Task-Based)

The user triggers reflection from the UI. Kookr creates a new task — the reflection runs as a regular agent task, visible and monitorable in the triage loop like any other.

1. **Confirm** — User clicks Reflect → confirmation dialog explains what will happen
2. **Create task** — Kookr generates a task with a prompt containing: session summary, hook file paths, interaction log path, agent count, intervention count
3. **Agent analyzes** — The reflection agent (running in its own tmux session) reads session data, applies pattern matchers, and generates the report
4. **Output** — The reflection report is the task's output, visible in the terminal view when the user selects the task

### Phase 2: Automatic Suggestions (Post-Session)

After a session ends (all agents completed or user closes Kookr):
- Automatically run reflection if the session had >N user interventions
- Show a notification: "Session had 12 interventions — want to see improvement suggestions?"

### Phase 3: Continuous Learning (Feedback Loop)

- Track which suggestions the user accepts vs. dismisses
- Use accepted suggestions to auto-tune anomaly thresholds and detection rules
- Build a per-project "supervision profile" that improves over time

## Quick Reference: Triggering Reflection

### UX Flow

Reflection runs as a **Kookr task** — the same way any agent task works. This lets the user monitor its progress in the triage loop like any other agent.

```
User clicks [Reflect] in status bar
  ↓
Confirmation dialog:
  "Analyze this session's history to find friction patterns
   and suggest workflow improvements. This will create a
   new task to perform the analysis."
  [Start Reflection]  [Cancel]
  ↓
Kookr creates a new task:
  - Name: "Session reflection — {date} {time}"
  - Prompt: auto-generated summary of session to analyze
  - Appears in the task list like any other task
  ↓
User can monitor reflection progress in the triage loop
  ↓
When complete, findings appear as the task's output
```

This approach reuses the existing task infrastructure — no special UI panels needed. The reflection agent is just another task the user can watch, and its output (the reflection report) is visible in the same terminal view as any other agent.

### From API
```
GET /api/reflect
  Response: { taskId: string }  // returns the created task ID
```

## Anti-Patterns

- **Don't reflect on trivial sessions.** If the user launched one agent and it completed without intervention, there's nothing to learn.
- **Don't suggest changes that contradict project CLAUDE.md.** Reflection suggestions must be compatible with existing project constraints.
- **Don't auto-apply suggestions.** Always present to user for review. The user decides what to change.
- **Don't store raw user input in reflection logs without consent.** Input may contain sensitive content (API keys, passwords typed into agents).
- **Don't over-index on single sessions.** One bad session doesn't mean the system is broken. Track patterns across sessions before recommending structural changes.

## See Also

- `docs/adr/010-session-reflection-workflow.md` — System design decision for this feature
- `src/core/anomaly-detector.ts` — Current anomaly detection rules (reflection may suggest new ones)
- `src/core/monitor.ts` — Supervisor event processing (source of reflection data)
- `src/server/ws.ts` — WebSocket message types (reflection messages to add here)
- [[state-machine-workflow-patterns]] — Session lifecycle states that feed into reflection
- [[testing-patterns]] — How to test reflection analysis
