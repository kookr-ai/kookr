# RFC: Smart Task Speech Summary

**Status:** Draft v2 (post critic review)
**Date:** 2026-05-25
**Author:** Codex (with Jean Ibarz)
**Related RFCs:** `rfc-speak-finding-summary.md`, `rfc-supervision-next-actions.md`

---

## Problem

Kookr can speak a short recap for an active supervisor finding, but that path is finding-scoped. It only works when `agent.anomaly` exists and the source material is mostly `taskName + anomaly.explanation`.

The user need is broader: "tell me what matters about this task" regardless of whether the task is running, pending, completed, terminated, snoozed, or currently has a supervisor finding. Completed tasks need digest/test/PR context. Running tasks without findings need status/turn/branch context. Active findings should still be spoken with the task context, not as the entire summary.

## Requirements

- R1: The user can request spoken context for the selected task even when it has no active supervisor finding.
- R2: The summary includes the highest-value speech-safe signals for that task: status, task name, active finding, completion digest, launch warnings, branch/worktree health, turn state, and cost when present.
- R3: Completed, cancelled, and terminated tasks are supported through their synthetic `AgentState` entries.
- R4: The output remains short enough for audio triage: one or two declarative sentences, <= 45 words and <= 280 characters.
- R5: The LLM is used to synthesize and prioritize context, but failures degrade to deterministic text.
- R6: Prompt-injection protections match or exceed the current finding recap path.
- R7: Existing TTS/cache/playback infrastructure is reused rather than creating a second audio stack.
- R8: Existing finding-speak behavior remains compatible during rollout.

## Design

Introduce a task-level spoken summary pipeline alongside the existing finding-level compatibility route.

```
selected task or finding card
  -> POST /api/tasks/:taskId/speak-summary
  -> build speech-safe TaskSpeechSummaryInput from AgentState + TaskStore
  -> TaskSpeechSummaryCache singleflight
  -> summarizeTaskForSpeech(LlmClient)
  -> TTS synthesize
  -> frontend plays audio with existing useSpeakFinding lifecycle
```

### Core Summarizer

Add `src/core/task-speech-summary.ts`.

It owns:

- `TaskSpeechSummaryInput`, containing only bounded, speech-safe fields.
- A system prompt that asks for one or two declarative sentences with no recommendations.
- A JSON schema response: `{ "summary": "..." }`.
- Guardrails copied from finding recap: untrusted delimiters, schema parsing, length cap, advice/action verb denylist.
- Token-shaped secret redaction for both LLM payload and deterministic fallback.
- A deterministic fallback that composes status, active finding, completion digest, launch warnings, branch, turn state, and cost in priority order.
- `normalizedTaskSpeechSummaryHashInput`, the canonical cache-freshness projection.

The core module does not know about Hono, TTS, task store mutation, or frontend audio. It accepts a nullable `LlmClient` and never throws on LLM failure.

### Server Projection

Add `src/server/use-cases/task-speech-summary-input.ts`.

The route should not own cross-store joining. The use-case resolves `taskId` to:

- Optional `AgentState` from `monitor.getSnapshot()`.
- Optional `Task` from `TaskStore.getTask(taskId)`.
- A speech-safe `TaskSpeechSummaryInput`.

V1 must not send raw prompts, raw task descriptions, tool inputs, tool outputs, hook payloads, terminal buffers, GitHub comments, or recent event messages to the LLM or deterministic fallback. Completion digest bullets are allowed because they are already a bounded task summary generated for this UI.

### Route Contract

Add:

```ts
POST /api/tasks/:taskId/speak-summary
  -> 503 { error: 'feature-disabled' }
  -> 503 { error: 'tts-not-configured' }
  -> 404 { error: 'task-not-found' }
  -> 503 { error: 'aborted' }
  -> 500 { error: 'tts-error', reason }
  -> 200 {
       text: string,
       audioBase64: string,
       mimeType: 'audio/wav',
       durationMs: number,
       usedFallback: boolean,
       llmMs: number,
       ttsMs: number,
       cached: boolean,
     }
```

Keep `POST /api/findings/:agentId/speak` as a compatibility route for older callers. Visible dashboard controls should prefer task-summary speech when a `taskId` exists.

`KOOKR_SPEAK=false` disables both finding and task manual speech routes.

### Cache Key

Add `TaskSpeechSummaryCache` rather than merging task and finding domains. The cache key is:

```
voice + sha1(JSON.stringify(normalizedTaskSpeechSummaryHashInput(input)))
```

Cache freshness follows exactly what may influence spoken text. Do not include monotonically growing event sequence numbers, because irrelevant hook traffic would turn every running task into LLM/TTS churn. Aborted results are not cached.

### Frontend

Rename the user-facing control from "Speak finding summary" to "Speak task summary" where the selected item has a `taskId`.

Minimal UI change:

- Finding cards keep a speaker button, but it calls the task summary route when `taskId` exists.
- Healthy, snoozed, pending, and completed task rows get the same speaker control when TTS is available and a `taskId` exists.
- The global shortcut continues to click the selected visible speech button.
- Playback, suppression, DND, timing display, and cancellation reuse `useSpeakFinding` through a small endpoint seam.

No auto-play is introduced.

## Files To Change

- `docs/rfc/rfc-smart-task-speech-summary.md`
- `src/core/task-speech-summary.ts`
- `src/core/task-speech-summary.test.ts`
- `src/server/task-speech-summary-cache.ts`
- `src/server/use-cases/task-speech-summary-input.ts`
- `src/server/routes/speech-routes.ts`
- `src/server/routes/speech-routes.test.ts`
- `src/shared/contracts/speech.ts`
- `src/frontend/hooks/useSpeakFinding.ts`
- `src/frontend/components/FindingsPanel.tsx`
- `src/frontend/components/FindingsPanel.speech.test.ts`

## Edge Cases

- Task has no active session: summarize task store fields and completion digest; do not require `agentId`.
- Task is pending: say it is queued/pending and include launch warnings if any.
- Task is terminated: say the session ended unexpectedly and include digest only if available.
- Task has an active finding and a completion digest due to stale state: active finding wins for urgency, digest can be secondary.
- Task has no LLM client: deterministic fallback still returns useful text.
- TTS disabled: route returns `tts-not-configured`; UI hides controls where appropriate.
- Prompt injection in task name, digest, or anomaly explanation: all content is delimited, capped, and treated as data.
- Multiple tabs request the same task: singleflight prevents duplicate LLM/TTS work.

## Alternatives Considered

### A. Replace Finding Summary Immediately

Make `/api/findings/:agentId/speak` directly call task summary and delete `finding-summary.ts`.

Rejected for first implementation. Keeping compatibility lowers risk and preserves the focused tests for the existing feature. A follow-up can remove duplication once task summaries prove better in production.

### B. Deterministic Summaries Only

Build a hand-written priority template from task status and fields.

Rejected as the full answer because the user request explicitly asks for smarter synthesis and the product goal is to prioritize heterogeneous task state in a short spoken form. We keep a strong deterministic fallback and restrict V1 inputs to speech-safe fields, rather than letting the LLM see raw prompts or raw event payloads.

### C. Store Generated Task Summaries On `Task`

Persist summaries in `tasks.json`.

Rejected for this feature. Spoken summaries are presentation artifacts that depend on current task state. Keeping them in an in-memory cache avoids persistence churn and stale stored narration.

## Critic Feedback Incorporated

- Boundary critic: moved cross-store task resolution into a server use-case and kept task/finding caches separate.
- Failure-mode analyst: added a speech-safe projection, redaction/capping, no raw event or GitHub payloads, normalized-input cache keys, and explicit terminal/pending task handling.
- Design minimalist: kept the existing finding route intact, limited V1 inputs, avoided broad frontend renames, and reused the existing playback hook through an endpoint seam.
- Operability reviewer: clarified `KOOKR_SPEAK` scope, added task-speak logs, abort behavior, bounded cache freshness, and concrete test scenarios.
