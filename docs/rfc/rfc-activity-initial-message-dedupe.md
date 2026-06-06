# RFC: Activity Initial Message Dedupe

**Status:** Draft (v4 - post-round-3 revision)
**Date:** 2026-06-06
**Author:** Jean Ibarz (with Codex)

---

## Problem

The Activity panel can show the initial task instructions twice for a managed
agent:

1. once as a synthetic "You" message derived from `AgentState.description`;
2. once as the provider's real `UserPromptSubmit` hook event.

The duplicate is visible on task `9cfb27a8-f7da-4e3b-838f-39a9ab6b79f4`.
That task's Kookr session is `kookr-6394a8e7`.

This is not just cosmetic. The Activity panel is the operator's trust surface
for what the agent has seen. Showing the launch instructions twice makes it
look like Kookr sent the initial prompt twice, even when the hook ledger shows
one authoritative parent `UserPromptSubmit`.

## Empirical Checkpoint

Observed local data on 2026-06-06 for the reported task:

- `~/.kookr/tasks.json` stores task
  `9cfb27a8-f7da-4e3b-838f-39a9ab6b79f4` with `userPrompt` equal to the
  original operator-authored launch instructions.
- `~/.kookr/activity/kookr-6394a8e7.jsonl` contains exactly one
  `UserPromptSubmit` projected as `parent_activity` for that session.
- The same raw `UserPromptSubmit` also arrives through the other hook delivery
  source as `diagnostic_only`. That is expected dual-delivery dedupe, not a
  second visible parent activity event.
- The Codex transcript contains one initial `user_message` with the same
  launch instructions, followed by a developer-message KB injection. The
  initial user prompt itself was not duplicated in the transcript.

Relevant implementation:

- `src/frontend/store/activity-history.ts` injects a synthetic launch prompt
  from `agent.description` into `agent.events` when no event with exactly the
  same prompt text is already present.
- The synthetic event uses `sessionId = agent.agentId` and optional
  `cwd = agent.cwd`.
- The real hook event uses the provider runtime `session_id` and provider hook
  `cwd`.
- `mergeActivityEvents()` finds overlap by `JSON.stringify(event)`, so a
  synthetic launch prompt and a real `UserPromptSubmit` are distinct even when
  their `prompt` strings match.
- If a first browser snapshot arrives before the real `UserPromptSubmit`, the
  synthetic event is kept in browser history. When the real prompt later
  arrives, overlap detection appends it instead of replacing the synthetic row.

Minimal reproduction from the current merge contract:

```ts
previous.events = [
  { type: 'user_prompt', sessionId: 'kookr-6394a8e7', prompt: P, cwd: worktreeCwd },
];

incoming.events = [
  { type: 'session_start', sessionId: '019e9e9a-...' },
  { type: 'user_prompt', sessionId: '019e9e9a-...', prompt: P, cwd: launchCwd },
];

// JSON overlap is zero because previous[0] !== incoming[0].
// Result: synthetic prompt + real prompt.
```

Round-1 empirical scan across recent local activity:

- 10 `~/.kookr/activity/*.jsonl` files mapped to tasks in `tasks.json`.
- 19 parent `UserPromptSubmit` records were found.
- 4 of 10 sessions had a first parent prompt matching the display prompt.
- 6 of 10 sessions had mismatches, usually because launch warnings, worktree
  guardrails, or long orchestration context altered the effective provider
  prompt relative to `displayPromptForTask(task)`.
- 4 sessions had multiple parent `UserPromptSubmit` records.
- 13 child `UserPromptSubmit` records were present and correctly projected as
  child activity.

Conclusion: the reported duplicate is caused by frontend display compensation
being stored as a real activity event. A server-wide "first prompt equals
display prompt" classifier is not reliable enough without launch-time identity
metadata.

## Current Behavior

The backend publishes a sliding provider activity window. The window can be
empty or start after the launch event, especially during initial connection
timing, server restart, or capped-window history.

The frontend compensates by synthesizing the launch prompt from
`AgentState.description`. That makes old, capped, or empty snapshots more
readable: users still see what task the agent was launched with.

The problem is where that compensation lives: `withLaunchPrompt()` writes the
synthetic row into `AgentState.events`, the shared frontend event history.
After that, the placeholder is indistinguishable from provider activity for
frontend consumers.

## Requirements

- R1. The Activity panel SHALL show at most one launch-instructions display row
  for the same task/session when the display placeholder and provider launch
  event have the same conservative-normalized prompt text.
- R2. The launch row SHALL remain visible when the monitor window no longer
  contains the original provider `UserPromptSubmit`.
- R3. A provider launch-prefix `UserPromptSubmit` SHALL supersede the display
  placeholder for the same task/session and prompt.
- R4. Deduplication SHALL NOT collapse later operator messages that happen to
  have the same text as the launch prompt.
- R5. Deduplication SHALL tolerate different `sessionId`, `cwd`, source, and
  arrival ordering between the display placeholder and provider event.
- R6. V1 SHALL keep raw `AgentState.events` provider/server-only in the
  frontend store.
- R7. V1 SHALL not add protocol fields, task-store fields, adapter state, or
  diagnostics counters.
- R8. The implementation SHALL be testable with deterministic frontend display
  projection and merge tests.

## Non-Goals

- Do not change provider hook delivery semantics.
- Do not remove dual file/HTTP hook delivery diagnostics.
- Do not build a full unbounded activity log viewer.
- Do not solve pending mid-turn user message visibility; that is covered by
  the separate pending-user-message RFC work.
- Do not deduplicate arbitrary same-text user messages across the activity log.
- Do not infer canonical launch identity across relaunch, resume, restart, or
  mutated launch prompts in V1.
- Do not classify launch prompts from bounded monitor windows.

## Recommendation

Separate raw activity history from Activity panel display projection.

V1 should remove synthetic launch insertion from
`src/frontend/store/activity-history.ts`. The store should merge and retain
only server/provider `AgentEvent`s. The Activity panel, or a selector directly
feeding it, should derive a display-only launch placeholder when provider
history lacks the launch prompt.

Recommended display model:

```ts
type ActivityDisplayItem =
  | { kind: 'agent_event'; event: AgentEvent }
  | {
      kind: 'launch_placeholder';
      agentId: string;        // Kookr managed session id
      prompt: string;
      cwd?: string;
    };
```

The projection should live in a dedicated frontend selector module:

```text
src/frontend/store/activity-display.ts
```

That module owns `ActivityDisplayItem`, `buildActivityDisplayItems()`,
`hasProviderLaunchPrompt()`, and `normalizeLaunchPrompt()`. `ActivityPanel`
renders projected items; it does not decide placeholder identity while
rendering. The panel can then summarize display items without ever writing the
placeholder back into `AgentState.events`.

This is intentionally smaller than a server-side launch identity system, but
more robust than mutating frontend event history:

- provider hook events remain raw activity facts;
- monitor, server snapshots, and frontend store history stay unchanged;
- Activity panel display keeps the useful "task prompt" context for capped or
  empty windows;
- display projection can suppress the placeholder when a provider launch event
  is present.

## Design

### 1. Keep The Store Raw

Change `mergeActivityEvents()` so it no longer calls `withLaunchPrompt()`.
Its only job should be to merge incoming server events into browser history.

The existing JSON-overlap merge can remain, but round-2 review exposed a
separate reconnection risk: incoming snapshots may be an authoritative superset
of existing history rather than a suffix-overlap.

Add a small superset rule before suffix append. When `eventSeq` is present on
the compared events, use eventSeq as the primary identity:

```ts
if (incomingContainsExistingEventSeqSubsequence(existingEvents, incomingEvents)) {
  return incomingEvents;
}
```

This prevents duplication when the browser previously saw `tool1, tool2` and
a later snapshot replays `session_start, user_prompt, tool1, tool2, tool3`.
Use JSON subsequence matching only as a fallback for legacy events without
eventSeq, and cover repeated identical events so fallback matching does not
hide duplicates.

### 2. Build Display Items At The Activity Boundary

Add `buildActivityDisplayItems(agent)` in
`src/frontend/store/activity-display.ts`.

Pseudo-code:

```ts
function buildActivityDisplayItems(agent: AgentState): ActivityDisplayItem[] {
  const raw = agent.events.map((event) => ({ kind: 'agent_event', event } as const));
  const prompt = agent.description?.trim();
  if (!prompt) return raw;

  if (hasProviderLaunchPrompt(agent.events, prompt)) return raw;

  const placeholder = {
    kind: 'launch_placeholder',
    agentId: agent.agentId,
    prompt,
    cwd: agent.cwd,
  } as const;

  if (agent.events[0]?.type === 'session_start') {
    return [raw[0], placeholder, ...raw.slice(1)];
  }
  return [placeholder, ...raw];
}
```

The Activity panel can map `launch_placeholder` to the same visual "You" row
currently used for `user_prompt`, but it remains display-only.

### 3. Define Provider Launch Evidence Conservatively

`hasProviderLaunchPrompt()` must not treat any later same-text provider prompt
as the launch prompt. It should require complete-prefix evidence:

- prompt text matches after conservative normalization;
- when `eventSeq` is present, the visible raw list starts at the beginning of
  the parent stream (`eventSeq === 1` for the first visible parent event, or
  the local equivalent if sequence numbering starts elsewhere);
- when `eventSeq` is absent, V1 should be conservative and keep the placeholder
  unless the visible list contains an explicit `session_start` before the
  candidate and no prior non-start activity;
- the candidate `user_prompt` occurs before any non-start activity in the
  visible raw event list;
- allowed preceding events are `session_start` and low-value startup notices
  already rendered as system notices.

Pseudo-code:

```ts
function hasProviderLaunchPrompt(events: AgentEvent[], prompt: string): boolean {
  if (!hasCompleteVisiblePrefix(events)) return false;
  for (const event of events) {
    if (isLaunchPrefixNoise(event)) continue;
    if (event.type !== 'user_prompt') return false;
    return normalizeLaunchPrompt(event.prompt) === normalizeLaunchPrompt(prompt);
  }
  return false;
}
```

This deliberately does not infer launch identity from capped windows. If the
raw visible list starts at `tool_use` or a later same-text `user_prompt`, the
display placeholder stays.

Display projection should sort or canonicalize by `eventSeq` when the merged
raw history contains a complete eventSeq prefix. That handles delayed arrival
where a browser first saw `tool_use(eventSeq: 3)` and later receives
`session_start(1), user_prompt(2), tool_use(3)`.

### 4. Add Conservative Prompt Normalization

Add a frontend helper:

```ts
function normalizeLaunchPrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, '\n').trim();
}
```

This helper is deliberately conservative:

- trims outer whitespace;
- normalizes CRLF to LF;
- preserves case;
- preserves Markdown;
- does not strip Kookr launch warnings, worktree guardrails, or KB-injected
  content.

### 5. Treat Child Prompt Leakage As A Server Invariant

V1 display projection cannot distinguish a leaked child `UserPromptSubmit`
from a parent provider prompt because parentage is not exposed in
`AgentEvent`. The design therefore depends on an existing server invariant:

```text
child activity must not be projected into parent AgentState.events
```

Add a mandatory server/projection regression test for this invariant. If a
child prompt can appear in parent `AgentState.events`, do not ship the
frontend display fix alone; expose parentage or implement canonical server
launch identity first.

### 6. Explicitly Defer Canonical Server Identity

A more canonical future design would record launch identity at managed-session
creation:

```ts
interface SessionInfo {
  agentId: string;              // Kookr managed session id
  launchInstanceId?: string;    // stable across reconnect, unique per launch attempt
  launchPromptHash?: string;    // hash of effective provider-submitted prompt
  displayPromptHash?: string;   // hash of operator-facing display prompt
}
```

That future design would classify provider launch events at ingestion or
durable ledger replay time using `taskId + agentId + launchInstanceId`.
It would be appropriate if Kookr needs to distinguish relaunch attempts,
provider-mutated prompts, or restart-stable launch diagnostics.

V1 should not implement this. The local scan shows that effective provider
prompts often differ from display prompts, so doing server classification
without launch-time hashes would create false confidence.

## Consumer Scope

| Consumer | V1 behavior |
|---|---|
| Activity panel | Receives display items; may show one launch placeholder when complete-prefix provider prompt evidence is absent. |
| Frontend `AgentState.events` store | Raw provider/server events only; no synthetic launch rows. |
| Raw monitor events | Unchanged; provider events only. |
| Activity ledger diagnostics | Unchanged; dual delivery remains `diagnostic_only` for duplicates. |
| Speech summaries | Unchanged unless explicitly moved to consume Activity display events. |
| Reflection tasks / completion digests | Unchanged; no frontend placeholder is persisted as raw task activity. |
| Server snapshots | Unchanged. |

## Edge Cases

### Snapshot Arrives Before UserPromptSubmit

Initial raw snapshot may contain no events. Activity display projection inserts
a launch placeholder. Later raw snapshot contains
`session_start(eventSeq: 1) -> user_prompt(eventSeq: 2)`. Raw merge recognizes
the incoming sequence as an authoritative prefix/superset. Projection sees
complete-prefix provider evidence and omits the placeholder.

### Capped Window Drops The Provider Launch Prompt

Visible raw history starts after the launch prefix, so display projection keeps
the placeholder as task context. It does not claim that the placeholder was
observed provider activity.

### User Later Sends The Same Text Again

The later event is not in the launch prefix because other activity precedes it.
The display placeholder remains, and the later provider prompt is also shown.

### Incoming Snapshot Is A Superset Of Browser History

Raw merge should replace browser history with the incoming authoritative
superset when existing events appear as a contiguous subsequence. This avoids
duplicating `tool1/tool2` after reconnect or replay.

### Same Prompt, Different Runtime CWD

Display suppression ignores `cwd`. The provider event is authoritative when
it appears in launch prefix; otherwise the placeholder uses `agent.cwd` only as
display context.

### Relaunch Or Resume Reuses The Same Task Prompt

V1 is scoped to the current `AgentState.agentId`, the Kookr managed session id.
Cross-launch canonical identity is deferred to the launch-instance design.

### Provider Prompt Differs From Display Prompt

No suppression occurs. The Activity panel may show both the display
placeholder and a provider prompt with extra launch context. That is not the
reported duplicate, because the rows are not identical user instructions. A
future launch-identity design can present requested-vs-effective prompt as one
related launch row.

### Child Agent Receives The Same Prompt

Child prompts must not appear in parent `AgentState.events`. V1 acceptance
requires a regression test for this. If tests or data show otherwise, V1 is
blocked until parentage is available to display projection or fixed at the
server projection layer.

## Files To Change

- `src/frontend/store/activity-history.ts`: stop injecting launch prompts into
  stored event history; add eventSeq-first authoritative-superset merge
  handling.
- `src/frontend/store/activity-history.test.ts`: assert the store remains raw
  and covers superset reconnect merging.
- `src/frontend/store/activity-display.ts`: build `ActivityDisplayItem`s with
  a display-only launch placeholder, complete-prefix launch detection, and
  conservative normalization.
- `src/frontend/components/ActivityPanel.tsx`: render display items and keep
  placeholder identity out of component render logic.
- `src/frontend/components/ActivityPanel.*.test.tsx`: cover placeholder
  display, launch-prefix suppression, later same-text provider prompts, and
  capped-window behavior.
- Server/projection test for child prompt exclusion.

No adapter, task-store, protocol, or diagnostics files are required for V1.

## Test Plan

1. Store rawness: merging an empty initial snapshot does not add a synthetic
   `user_prompt` to `AgentState.events`.
2. Display placeholder: Activity display items include a launch placeholder
   when raw events do not contain complete-prefix provider prompt evidence.
3. Complete-prefix suppression: raw `session_start(eventSeq: 1) ->
   user_prompt(eventSeq: 2)` with matching normalized prompt shows one
   provider "You" row and no placeholder.
4. Later same-text prompt: raw `tool_use -> user_prompt` with matching text
   still shows the placeholder plus the later provider prompt.
5. Provider mismatch: launch-prefix provider prompt that differs from
   `agent.description` does not suppress the display placeholder.
6. Normalization: trim and CRLF-only differences suppress; case or content
   differences do not.
7. Provider-vs-provider: two provider prompts with the same text are both
   preserved.
8. Superset merge: previous `tool1(eventSeq: 3), tool2(eventSeq: 4)`,
   incoming `session_start(1), user_prompt(2), tool1(3), tool2(4), tool3(5)`
   results in the incoming sequence, not duplicated tools.
9. Child invariant: child same-prompt `UserPromptSubmit` is not present in
   parent `AgentState.events`, or V1 is blocked.

## Alternatives Considered

### Server-Issued Launch Prompt Identity

Record `launchPromptHash` or `launchInstanceId` at launch time and use it to
classify provider prompt events at ingestion or snapshot projection time.

Deferred. It is the right shape for restart-stable, relaunch-aware canonical
identity, but it is larger than the reported bug and requires launch-time
metadata that does not exist today. Prompt equality to display text is not
reliable enough to fake this in the server.

### Store Synthetic Prompt Then Dedupe It

Keep the current `withLaunchPrompt()` store behavior and retire the synthetic
row when the matching provider prompt appears.

Rejected after round 2. A display placeholder stored as `AgentEvent` blurs raw
activity with presentation state and can leak into future frontend consumers.

### Add Role/Origin Fields To UserPromptEvent

Extend `AgentEvent.user_prompt` with `role`, `origin`, `taskId`, or
`supersedesSyntheticLaunch`.

Rejected for V1. Those are Kookr projection concepts, not provider activity
facts. Adding them would spread a frontend display issue into the shared event
protocol.

### Frontend Text-Only Dedupe

Compare prompt strings globally in `mergeActivityEvents()` and drop duplicates.

Rejected. It would collapse legitimate later messages with the same text.

### Remove Synthetic Launch Prompt Entirely

Only show provider `UserPromptSubmit`.

Rejected. Capped windows and late browser connects would lose the most
important user-authored context for the task.

## Critic Feedback Incorporated

- Round 1 `boundary-critic` 2026-06-06: accepted the concern that v1 split
  launch identity across boundaries; revised away from protocol/server
  expansion and later separated display placeholders from stored raw events.
- Round 1 `design-minimalist` 2026-06-06: accepted the recommendation to avoid
  protocol/server expansion for V1.
- Round 1 `failure-mode-analyst` 2026-06-06: accepted ordering and
  provider-vs-provider risks; V3 suppresses placeholders only from
  launch-prefix provider evidence and never dedupes provider-vs-provider.
- Round 1 `socratic-challenger` 2026-06-06: accepted the need for broader data
  scanning and per-session identity; added scan results and scoped V1 to the
  current Kookr managed session id.
- Round 1 empirical checkpoint 2026-06-06: local scan falsified
  display-prompt equality as a server-wide launch classifier; recommendation
  changed from server-owned prompt classification to frontend display
  projection.
- Round 2 `ambition-amplifier` 2026-06-06: novel finding; accepted the deeper
  issue that synthetic placeholders should be display projection, not stored
  as raw `AgentEvent`s.
- Round 2 `boundary-critic` 2026-06-06: novel finding; accepted adapter-neutral
  future naming (`agentId` / `launchInstanceId`) instead of `tmuxSession`.
- Round 2 `design-minimalist` 2026-06-06: novel finding; accepted the
  launch-prefix requirement so later same-text prompts cannot suppress the
  placeholder.
- Round 2 `failure-mode-analyst` 2026-06-06: novel finding; accepted superset
  merge handling and the child-prompt server invariant.
- Round 3 `boundary-critic` 2026-06-06: novel finding; accepted a dedicated
  selector module and `ActivityDisplayItem` naming so display projection is not
  hidden inside React render logic.
- Round 3 `design-minimalist` 2026-06-06: no substantive findings.
- Round 3 `failure-mode-analyst` 2026-06-06: novel finding; accepted
  eventSeq-first complete-prefix detection, eventSeq-first superset merge, and
  mandatory child-prompt projection testing.
- Adversarial pair resolution 2026-06-06: agreed with `design-minimalist` that
  canonical server launch identity is too large for V1, but agreed with
  `ambition-amplifier` that the minimal fix still must separate display
  placeholders from raw event history.
