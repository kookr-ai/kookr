# ADR-010: Session Reflection Workflow

## Status

**Accepted** (2026-03-25, by Jean Ibarz)

## Context

Kookr supervises AI coding agents and routes developer attention to agents that need help. During a supervision session, the developer interacts with agents through the triage loop: view finding, read context, send input, advance to next agent.

In practice, developers experience **friction** — situations where the system isn't proactive enough and the developer has to compensate manually:

1. **"Did you do this?"** — The developer asks an agent a question that the system should have surfaced automatically (e.g., whether the agent ran tests, whether it's actually stuck, or what it's working on).
2. **"Can you do that now?"** — The developer gives an agent instructions that could have been part of the agent's initial prompt or CLAUDE.md.
3. **Repeated corrections** — The developer sends the same guidance to multiple agents or across multiple sessions ("use strict types", "don't skip tests").
4. **Missed anomalies** — The developer intervenes with an agent that has no active finding, meaning the anomaly detector failed to catch a problem.
5. **Unnecessary triage** — The developer skips or snoozes findings that aren't worth their attention, indicating the detection thresholds are too sensitive.

These friction patterns are **signal about how to improve** the system. Currently, this signal is lost — once the session ends, there's no mechanism to capture what went well, what didn't, and what should change.

### The Opportunity

If Kookr could analyze its own session data (hook events, anomaly history, user interactions, queue transitions), it could identify these friction patterns and suggest concrete improvements. But **where** those improvements land matters as much as **what** they are.

### Progressive Disclosure Principle

Agent behavior is steered through a hierarchy that follows **progressive disclosure**:

```
CLAUDE.md                          ← concise, always loaded into agent context
  ↓ agent discovers via frontmatter
.claude/skills/*/SKILL.md          ← detailed patterns, loaded on demand
  ↓ skill references
source files, docs, examples       ← full context, explored as needed
```

CLAUDE.md must stay concise — it's loaded into every agent's context window. Skills are the natural home for detailed behavioral guidance: agents scan skill frontmatter descriptions (cheap), then load full content only when the description matches their current task (on-demand). This means the best way to steer agent behavior is usually to **create or improve a skill** rather than add lines to CLAUDE.md.

When a reflection finding suggests a behavioral improvement:
- If it's a universal one-liner ("always run tests before completing"), it may belong in CLAUDE.md
- If it needs explanation, examples, or conditional logic, it belongs in a skill — either a new one, or by improving an existing skill's `description` and `keywords` so it gets discovered more reliably in the right contexts
- Avoid redundancy: don't add a CLAUDE.md line that just points to a skill. Instead, make the skill's frontmatter description clear enough that the agent discovers it naturally.

The reflection system should follow this principle when suggesting improvements — prefer skill improvements over CLAUDE.md bloat.

This turns Kookr from a static supervisor into a **self-improving** one: each session makes future sessions smoother.

### Relationship to Existing Architecture

The supervisor agent (see `docs/architecture.md`) already processes event streams and detects anomalies. Session reflection extends this by applying the same analytical approach **retrospectively** to the supervisor's own performance — a meta-supervision layer.

Current data available for analysis:
- **Hook event JSONL** (`~/.kookr/hooks/{session-name}.jsonl`) — every agent event (session name is a dtach session post-ADR-014; the original tmux naming was `{tmux-name}`)
- **Task state** (`~/.kookr/tasks.json`) — lifecycle, session metadata
- **In-memory anomaly state** (`Monitor.getSnapshot()`) — current anomalies

Data **not currently captured** but needed:
- User input history (what the developer sent through the terminal backend input path)
- Attention queue transitions (enqueue, skip, snooze, advance timestamps)
- Anomaly lifecycle (detection → resolution, with resolution method)

## Options

### Option A: Interaction Event Log + LLM Analysis (Recommended)

Add a lightweight event log that captures **interaction events** — the data that bridges the gap between "what agents did" (hook events) and "what the developer did" (inputs, navigation, skips). Then use LLM analysis (the supervisor agent or a dedicated reflection prompt) to identify friction patterns and generate a report.

#### Architecture

```
┌──────────────────────────────────────────────────────┐
│  Session Data                                         │
│                                                       │
│  Hook JSONL ──────┐                                   │
│  Task state ──────┤                                   │
│  Interaction log ─┤  ← NEW: captures user actions     │
│                   ▼                                   │
│  ┌─────────────────────┐                              │
│  │ Session Collector    │                              │
│  │ Merges all sources   │                              │
│  │ into unified timeline│                              │
│  └──────────┬──────────┘                              │
│             ▼                                         │
│  ┌─────────────────────┐                              │
│  │ Pattern Analyzer     │                              │
│  │ Rule-based detection │                              │
│  │ of friction taxonomy │                              │
│  └──────────┬──────────┘                              │
│             ▼                                         │
│  ┌─────────────────────┐                              │
│  │ LLM Summarizer       │                              │
│  │ Generates report with│                              │
│  │ actionable suggestions│                             │
│  └──────────┬──────────┘                              │
│             ▼                                         │
│  ┌─────────────────────┐                              │
│  │ Reflection Report    │  → UI panel / modal          │
│  │ Friction patterns    │  → API response              │
│  │ Suggested actions    │  → Exportable markdown        │
│  └─────────────────────┘                              │
└──────────────────────────────────────────────────────┘
```

#### Interaction Event Log (new component)

A simple append-only JSONL file (`~/.kookr/sessions/{session-id}/interactions.jsonl`) that captures:

```typescript
type InteractionEvent =
  | { type: 'user_input'; agentId: string; content: string; timestamp: string }
  | { type: 'agent_selected'; agentId: string; source: 'auto' | 'manual'; timestamp: string }
  | { type: 'finding_skipped'; agentId: string; anomalyType: AnomalyType; timestamp: string }
  | { type: 'finding_snoozed'; agentId: string; duration: number; timestamp: string }
  | { type: 'finding_resolved'; agentId: string; anomalyType: AnomalyType; method: 'input' | 'auto_clear' | 'skip' | 'snooze'; durationMs: number; timestamp: string }
  | { type: 'agent_launched'; agentId: string; taskPrompt: string; timestamp: string }
  | { type: 'agent_stopped'; agentId: string; reason: 'user' | 'completed' | 'error'; timestamp: string }
  | { type: 'reflect_triggered'; timestamp: string }
```

This log is **intentionally minimal** — it captures developer actions and their timing, not full agent transcripts. It's the "what did the human do?" complement to hook events' "what did the agent do?".

**Privacy consideration:** `user_input` content is stored locally only. The reflection LLM prompt should sanitize any content that looks like secrets before including it in the report.

#### Reflection Trigger

Reflection runs as a **regular Kookr task** — reusing the existing task lifecycle and triage loop rather than introducing a separate UI surface.

**UX flow:**
1. User clicks "Reflect" button in the status bar
2. Confirmation dialog explains: "Analyze this session's history to find friction patterns and suggest workflow improvements. This will create a new task."
3. On confirmation, Kookr creates a new task with an auto-generated prompt summarizing the session to analyze (agent count, intervention count, session duration, hook file paths)
4. The task appears in the task list like any other agent task — the user can monitor its progress, see its output, and interact with it through the normal triage loop
5. When complete, the reflection report is the task's output — visible in the terminal view

This approach has several advantages:
- **No special UI** — reflection uses the same task/terminal infrastructure as everything else
- **Observable** — the user can watch the analysis happen, just like any other agent
- **Interruptible** — the user can stop or snooze the reflection task if something more urgent comes up
- **Consistent** — follows the same lifecycle (open → inProgress → completed) as all tasks

**Additional triggers:**
- **Post-session notification:** After session ends with >N interventions, show a toast: "Session had 12 interventions — want to reflect?" → same task creation flow
- **API:** `POST /api/reflect` → returns `{ taskId: string }`

#### LLM Analysis

The reflection prompt sends the unified session timeline to the supervisor LLM with instructions to:
1. Identify friction patterns from the taxonomy (see skill file)
2. Classify each pattern by category and severity
3. Suggest concrete, actionable fixes
4. Prioritize suggestions by expected impact

The LLM prompt would include the session timeline (sanitized), the current CLAUDE.md content, and the current anomaly detector configuration — so suggestions are contextual.

**Pros:**
- Captures the full picture: agent events + user behavior + timing
- LLM analysis can catch subtle patterns that pure rules miss (e.g., "user always asks about tests after agent completes" → add test-running to agent template)
- Interaction log is lightweight — small JSONL file per session, no database
- Incremental: can start with just the log + simple rules, add LLM analysis later
- Suggestions are specific and actionable (not vague "improve anomaly detection")
- Session data stays local — no cloud dependency

**Cons:**
- Requires persistence of interaction events (new JSONL file per session)
- LLM analysis adds API cost per reflection (~1 call with moderate context)
- Need to design the reflection prompt carefully to avoid hallucinated suggestions
- User input content storage has privacy implications (mitigated by local-only storage)
- Interaction log must be wired into every user-facing action (input, skip, snooze, navigate)

### Option B: Pure Rule-Based Post-Session Analysis (No LLM)

Apply the friction pattern taxonomy as deterministic rules against session data. No LLM involvement — just heuristics.

#### Rules Engine

```typescript
interface FrictionRule {
  name: string;
  category: 'reactive_user' | 'repeated_correction' | 'detection_gap' | 'workflow_inefficiency';
  detect(timeline: SessionTimeline): FrictionFinding[];
}

// Example rules:
// - "user sent >3 question-shaped inputs" (regex: /^(did|does|is|are|have|has|can|could|should|will|what|why|how)\s/i)
// - "user intervened with agent that had no active finding"
// - "same anomaly type skipped >2 times"
// - "user sent same message to >1 agent"
// - "gap >5 minutes between last agent event and user input"
```

**Pros:**
- No API cost — fully local computation
- Deterministic — same session always produces the same report
- Fast — no LLM latency
- Easier to test — pure functions
- No prompt engineering needed

**Cons:**
- Cannot catch subtle or novel friction patterns
- Rule maintenance burden — every new pattern needs a new rule
- Cannot generate nuanced, contextual suggestions (only templated ones)
- Misses the "why" — can detect that the user asked questions but can't infer what they were trying to learn
- Question detection via regex is brittle (false positives on legitimate instructions that happen to start with "can you")
- No ability to correlate patterns across sessions without building a persistence layer

### Option C: Transcript-Based LLM Analysis (No Interaction Log)

Skip the interaction event log entirely. Instead, read the hook event JSONL files and agent transcripts, and send them to an LLM for analysis. The LLM infers user behavior from the agent transcripts (which contain the user's messages as part of the conversation).

**Pros:**
- No new data capture needed — works with existing hook JSONL and transcripts
- Zero instrumentation cost — no need to wire interaction logging into every action
- Can start immediately without any backend changes

**Cons:**
- Agent transcripts are large — sending full transcripts to the LLM is expensive and may exceed context limits
- Transcripts contain the agent-user conversation but **not** the Kookr-level actions (skip, snooze, advance, navigation). These are critical friction signals.
- Cannot detect "user intervened with agent that had no finding" — this requires Kookr-level data
- Cannot detect workflow inefficiency (rapid skip cycles, manual navigation overrides) — this data isn't in transcripts
- Privacy risk: transcripts contain full code, file contents, and potentially secrets
- Relies on transcript availability — not all agents may have accessible transcripts

### Option D: Frontend-Only Analytics (No Backend Changes)

Track user interactions entirely in the frontend (Zustand store + localStorage). Reflection runs client-side using the browser's view of session state.

```typescript
// In Zustand store
interface SessionAnalytics {
  interactions: InteractionEvent[];
  startedAt: string;
  agentViews: Map<string, number>; // how many times each agent was viewed
  inputCounts: Map<string, number>; // inputs per agent
}
```

**Pros:**
- No backend changes at all
- Data stays in browser — simplest privacy model
- Can use existing Zustand store patterns
- Quick to prototype

**Cons:**
- Lost on page refresh or browser close — no persistence
- Cannot access hook event files directly (browser sandbox)
- No server-side LLM access — would need to call an external API from the browser or use a limited client-side model
- Frontend doesn't know about anomaly lifecycle details (detection timing, event windows)
- Cannot correlate with task state or hook events without additional API calls
- Splitting analytics between frontend and backend creates consistency issues

### Option E: Session Recording + Playback

Record the entire session as a replayable event stream (like a flight recorder). Reflection replays the session and annotates friction points.

```typescript
interface SessionRecording {
  id: string;
  events: Array<{
    timestamp: string;
    source: 'hook' | 'anomaly' | 'user' | 'queue' | 'task';
    event: unknown;
  }>;
}
```

**Pros:**
- Complete data capture — nothing is lost
- Enables session playback UI (rewatch what happened)
- Can be analyzed multiple times with different rules
- Valuable for debugging Kookr itself

**Cons:**
- Significant storage — full event stream for every session
- Highest implementation complexity — must instrument every event source
- Overkill for V1 — session playback is a V2+ feature
- Most of the data is noise (hundreds of tool_use events) — reflection only needs key interaction moments
- Privacy: stores everything, including potentially sensitive agent output

## Evaluation

| Criterion | Weight | A: Log + LLM | B: Rules Only | C: Transcript | D: Frontend | E: Recording |
|-----------|--------|-------------|---------------|---------------|-------------|-------------|
| Catches subtle friction patterns | High | Yes (LLM) | **No** | Partial | **No** | Yes (if analyzed) |
| Actionable suggestions | High | Yes (contextual) | Templated only | Yes | Templated only | Depends on analyzer |
| Implementation complexity | High | Medium | Low | Low | Low | **High** |
| Captures Kookr-level actions (skip, snooze) | Critical | Yes | Yes | **No** | Yes | Yes |
| Works without additional persistence | Medium | No (needs log) | No (needs log) | Yes | Partial (localStorage) | **No** (large storage) |
| API cost per reflection | Medium | ~1 LLM call | **None** | ~1 large call | **None** | Varies |
| Privacy risk | Medium | Low (local log) | Low (local log) | **High** (full transcripts) | Low (browser only) | **High** (everything stored) |
| Incremental implementation | High | Yes (rules first, LLM later) | Yes | Yes | Yes | **No** (all-or-nothing) |
| Cross-session pattern detection | Medium | Future (needs session index) | Future | **No** | **No** | Future |
| Aligns with V1 simplicity principle | High | Yes | Yes | Yes | Yes | **No** |

## Recommendation

**Option A: Interaction Event Log + LLM Analysis.**

This option best balances the quality of insights with implementation simplicity. The key insight is that the **interaction event log** is the missing piece — hook events tell us what agents did, but only interaction events tell us what the developer did and why. This log is small (tens of events per session, not thousands), easy to persist (append-only JSONL), and captures exactly the signals needed to detect friction.

The LLM analysis layer can be added incrementally:

1. **Phase 1:** Add the interaction event log + rule-based analysis for the most obvious friction patterns (repeated inputs, skipped findings, interventions without findings). No LLM needed yet.
2. **Phase 2:** Add LLM-powered summarization that reads the session timeline and generates a contextual report with improvement suggestions.
3. **Phase 3:** Cross-session pattern detection — aggregate findings across sessions to identify persistent friction that a single session might not surface.

Option B (rules only) is a valid starting point and is effectively Phase 1 of Option A. Option C (transcript analysis) misses critical Kookr-level interaction data. Option D (frontend only) can't access the data it needs. Option E (recording) is overbuilt for the current need.

### Why Not Pure Rules (Option B)?

Rules work for obvious patterns ("user skipped 5 times") but miss the nuanced ones that matter most. When a user sends "are you sure you ran the tests?" to an agent, a rule can detect the question mark but only an LLM can understand the intent: the user doesn't trust the agent's work and wants verification. The suggested fix — "add test execution verification to the agent's completion checklist" — requires semantic understanding.

However, rules are the right **first step**. The recommendation is to implement Option A in phases, starting with rule-based detection (effectively Option B) and adding LLM analysis when the interaction log is proven useful.

## Implementation Notes

If accepted:

### New Files

> **Updated 2026-04-01:** The implementation simplified the original 4-file design to 2 files. `friction-analyzer.ts` absorbed the responsibilities of both `session-collector.ts` (takes `InteractionEvent[]` directly) and `reflection-report.ts` (produces `ReflectionReport` inline). **Frontend UI not yet implemented:** the Reflect button in the status bar, confirmation dialog, and post-session notification toast described below are not yet in `src/frontend/`. The `POST /api/reflect` route exists in `routes.ts`. Phase 2 (LLM summarization) is also pending.

```
src/core/interaction-log.ts       — InteractionEvent types, append/read functions         ✓ Implemented
src/core/friction-analyzer.ts     — Rule-based friction detection + report generation      ✓ Implemented (absorbed session-collector + reflection-report)
```

### Modifications

```
src/server/ws.ts                  — Add 'reflect' client message → creates task via existing task launch flow
src/server/index.ts               — Wire reflection endpoint, log interaction events
src/frontend/                     — Add Reflect button + confirmation dialog in status bar
```

### Interaction Log Location

```
~/.kookr/sessions/{session-id}/interactions.jsonl
```

Session ID can be a timestamp-based identifier (e.g., `2026-03-25T14-30-00`), generated when Kookr starts and the first agent is launched.

### Wiring Interaction Events

Every user-facing action in the WebSocket handler and HTTP routes should emit an interaction event:

| Action | Event Type | Where to Instrument |
|--------|-----------|---------------------|
| User sends input to agent | `user_input` | `ws.ts` → `sendInput` handler |
| User selects agent manually | `agent_selected` | `ws.ts` → `selectAgent` handler |
| User skips finding | `finding_skipped` | `ws.ts` → `skip` handler |
| User snoozes finding | `finding_snoozed` | `ws.ts` → `snooze` handler |
| Anomaly resolved | `finding_resolved` | `monitor.ts` → anomaly clear path |
| Agent launched | `agent_launched` | `index.ts` → launch handler |
| Agent stopped | `agent_stopped` | `index.ts` → stop handler |
| Reflect triggered | `reflect_triggered` | `ws.ts` → `reflect` handler |

### UI Integration

- **Reflect button** in the status bar (bottom of the UI), visible when at least one agent has been supervised
- **Confirmation dialog** — explains what will happen ("analyze session history, create a new task"), with Start/Cancel buttons
- **Task creation** — on confirmation, creates a task with an auto-generated prompt containing session summary + hook file paths. The task appears in the task list and is monitored via the normal triage loop
- **Post-session notification** — after session ends with >5 user interventions, toast suggests reflection → same confirmation → task creation flow

### Phase 1 Friction Rules (implement first)

1. **Repeated input:** Same message (normalized) sent to >1 agent or sent >2 times to same agent
2. **Intervention without finding:** User sent input to agent that had no active anomaly
3. **Rapid skip cycle:** >3 findings skipped within 30 seconds
4. **Question-shaped input:** Input matching question patterns sent >2 times in session
5. **Long resolution time:** Anomaly active for >5 minutes before user responded
6. **Always-skipped anomaly type:** Same anomaly type skipped >50% of the time across session

### Applying Progressive Disclosure to Suggestions

Reflection suggestions that improve agent behavior should follow the progressive disclosure principle (see Context section). In practice this means:

- **Prefer skill improvements over CLAUDE.md additions.** Most behavioral guidance needs examples or conditional logic, which makes it a skill, not a CLAUDE.md line.
- **Improve discoverability, not just content.** If a skill already covers the right behavior but agents aren't finding it, the fix is to improve the skill's `description` and `keywords` in frontmatter — not to duplicate the guidance in CLAUDE.md.
- **Avoid redundant pointers.** Don't suggest adding "see skill X" lines to CLAUDE.md. A well-described skill gets discovered naturally through frontmatter matching.
- **When suggesting a new skill**, include a draft `name`, `description`, `keywords`, and `related` fields so the developer can evaluate the frontmatter quality before committing.
